import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { friendlySqlError } from '../utils/sql-error.util';

/**
 * Farm Report — every flock (broiler) or batch (layer) belonging to ONE
 * `farm_units` row, restricted to a date range.
 *
 * READ-ONLY, for the same reason `overview.service.ts` is: there are no
 * transactions in this codebase, so a service that both reads and writes
 * across modules could half-complete and leave the books inconsistent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW THIS DIFFERS FROM THE OVERVIEW DASHBOARD
 * ─────────────────────────────────────────────────────────────────────────
 * `overview.service.ts` ELIMINATES internal transfers — when the owner's
 * distribution business "sells" feed to their own broiler flock, the app
 * books both a `bills` row and a cost row, and at ACCOUNT level those two
 * cancel: no money left the owner.
 *
 * This report deliberately does the OPPOSITE and INCLUDES them. The unit of
 * account here is one farm, not the owner. That farm consumed the feed, and
 * the feed cost it money — dropping it would understate the cost of running
 * the farm and overstate its profit. So there is no `internal_transfers`
 * join, no `bill_id` exclusion, and no `payment_type = 'internal'` guard
 * anywhere in this file. That is intentional; do not "fix" it by copying
 * Overview's elimination logic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DATE RANGE SEMANTICS
 * ─────────────────────────────────────────────────────────────────────────
 * TRANSACTIONS are filtered by date; FLOCKS are not. A flock or batch is
 * included when at least one of its transactions falls inside the range, and
 * it then contributes only the revenue and costs recorded inside that range.
 * A flock that started before the range, or runs on past its end, is neither
 * pulled in whole nor dropped whole — only its in-range slice counts.
 * `DATE_RULE_LABEL` states this and is meant to be rendered verbatim.
 *
 * `flock_health` has no date column, only `week_number` — but that column is
 * misnamed: it is a 1-based DAY index (the UI labels it "Day"), and day 1
 * falls on the flock's own `start_date`. So each row's real calendar date is
 * `start_date + (week_number - 1) days`, and broiler birds placed / broiler
 * mortality ARE date-filtered off that computed date, same as every other
 * source here.
 *
 * ONE FIGURE still cannot honour the range: broiler `sales` records weight
 * (`bird_weight`), never a bird count, so "birds sold" does not exist on the
 * broiler side. Weight sold is reported instead, and that figure IS
 * date-filtered. This is noted in `mortality.note`.
 *
 * Layer has none of this trouble: `batches.initial_birds`, `layer_health`
 * and `hen_sales` all carry real counts, and the last two carry dates.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING
 * ─────────────────────────────────────────────────────────────────────────
 * Filtered by the logged-in account's `farm_id` per the multi-tenancy rule,
 * and then by `unit_id` — the client-facing "Farm". `unitId = null` means the
 * account has no `farm_units` rows yet, in which case every flock/batch of
 * that module is covered rather than none (the same fallback the sidebar and
 * `layer-report.component.ts` already use for legacy accounts).
 *
 * Shared tables (`expenses`, `feed_entries`, `medicine_entries`,
 * `labour_payments`, `income`) reuse `flock_id` to hold a `batch_id` when
 * `module_type = 'layer'`, so every one of them is filtered on BOTH.
 */

export type FarmReportModule = 'broiler' | 'layer';

/** Inclusive date bounds, 'YYYY-MM-DD'. Omit/null either side for open-ended. */
export interface FarmReportDateRange {
  from?: string | null;
  to?: string | null;
}

export interface FarmReportRevenue {
  total: number;
  /** Broiler: `sales`. Layer: `egg_sales`. */
  sales: number;
  /** Layer only — `hen_sales`. Always 0 for broiler. */
  henSales: number;
  /** `income` rows that are not mirrors of a sale. */
  income: number;
}

export interface FarmReportExpenses {
  total: number;
  feed: number;
  medicine: number;
  /**
   * `chick_entries` — the chicks a flock was stocked with, bought from a
   * hatchery or sent over from Distribution. A purchased input like feed and
   * medicine, on its own line for the same reason.
   */
  chicks: number;
  vaccination: number;
  labour: number;
  /** The `expenses` table. */
  general: number;
  /**
   * Ledger-screen debits — `ledger_entries` on the broiler side,
   * `layer_ledger_entries` on the layer side. A separate book from `general` on
   * both. The report is module-scoped, so only one of the two is ever read.
   */
  ledgerDebits: number;
}

export interface FarmReportFlockRow {
  /** flock_id (broiler) or batch_id (layer). */
  id: number;
  name: string;
  startDate: string | null;
  /**
   * Layer: `batches.initial_birds` (not date-filtered — a placement figure).
   * Broiler: `flock_health.total_birds` on the earliest in-range day.
   */
  birdsPlaced: number;
  /** Layer: hens sold in range (`hen_sales.quantity`). Broiler: null. */
  birdsSold: number | null;
  /** Broiler: weight sold in range, kg (`sales.bird_weight`). Layer: null. */
  weightSoldKg: number | null;
  revenue: number;
  expenses: number;
  profit: number;
}

export interface FarmReportMortality {
  birdsPlaced: number;
  /** Layer: hens sold in range. Broiler: null — sales record weight, not a count. */
  birdsSold: number | null;
  /** Broiler: weight sold in range (kg). Layer: null. */
  weightSoldKg: number | null;
  mortality: number;
  /** mortality / birdsPlaced * 100, or 0 when nothing was placed. */
  mortalityRate: number;
  /**
   * Broiler only — weightSoldKg / (birdsPlaced - mortality), i.e. total weight
   * sold divided by surviving birds. Null when there's nothing to divide by
   * (no birds placed, all placed birds dead, or nothing sold) or on layer,
   * where it isn't a meaningful figure.
   */
  avgWeightPerBirdKg: number | null;
  /** Caveats about which of the above respect the date range. Render verbatim, when non-empty. */
  note: string;
}

/**
 * What this farm still owes the owner's distribution business for stock it has
 * been supplied with.
 *
 * NOT part of `expenses` or `netProfit`, and must never be: the cost of that
 * stock is already in `expenses` (as feed, medicine, vaccination or a general
 * expense) on the day it arrived. This is the unpaid part of the same bills —
 * a debt, not a second cost. Adding it in would charge the farm twice.
 *
 * A stock, not a flow, so only the upper bound of the range applies — "what was
 * owed as at range.to" — the same convention `qAssetOutstanding()` uses in
 * overview.service.ts.
 */
export interface FarmReportOwedToDistribution {
  /** Still unpaid on own-farm bills, as at range.to. */
  outstanding: number;
  /** Total billed to this farm by distribution, up to range.to. */
  billed: number;
  /** Number of own-farm bills still carrying a balance. */
  unpaidBillCount: number;
}

export interface FarmReportSummary {
  moduleType: FarmReportModule;
  unitId: number | null;
  unitName: string;
  range: FarmReportDateRange;
  revenue: FarmReportRevenue;
  expenses: FarmReportExpenses;
  netProfit: number;
  /**
   * Profit carried forward from the client's previous system (`farm_units.opening_balance`),
   * entered by hand — never app-calculated. A point-in-time figure with no date of its own, so
   * it is NOT filtered by `range` and is included in every report regardless of the period
   * selected — see `OPENING_BALANCE_LABEL`. Kept OUT of `revenue`/`expenses`/`netProfit`; it is
   * neither. Always 0 when `unitId` is null (no single farm to attribute it to).
   */
  openingBalance: number;
  /** `netProfit + openingBalance` — the only place the two figures are combined. */
  totalWithOpeningBalance: number;
  /** Debt to the distribution business. Read-only, and outside netProfit. */
  owedToDistribution: FarmReportOwedToDistribution;
  /** One row per flock/batch with activity in range, best profit first. */
  flocks: FarmReportFlockRow[];
  mortality: FarmReportMortality;
  /** How the date range was applied. Render verbatim on screen and in the PDF. */
  dateRuleLabel: string;
  /** Why internal transfers are counted here. Render verbatim. */
  transferLabel: string;
  /** Why openingBalance ignores `range`. Render verbatim. */
  openingBalanceLabel: string;
  /** True when the unit owns any flock/batch at all, in range or not. */
  hasFlocks: boolean;
  /** True when at least one flock/batch had a transaction inside the range. */
  hasActivity: boolean;
  /** True when no `farm_units` exist and the report fell back to the whole account. */
  isAccountWideFallback: boolean;
  /** Non-fatal problems (failed queries). */
  warnings: string[];
}

/** One `GROUP BY flock_id|batch_id` bucket. */
interface OwnerRow {
  ownerId: number;
  amount: number;
  /** Secondary metric — a bird count or a weight, depending on the query. */
  qty: number;
  rowCount: number;
}

/** Everything a grouped query needs beyond the farm/unit/date scoping. */
interface QuerySpec {
  table: string;
  alias: string;
  /** Column on `table` holding the flock_id / batch_id. */
  ownerCol: string;
  /** SQL expression aggregated into `amount`. */
  amount: string;
  /** Aggregate applied to `amount`. Defaults to SUM. */
  agg?: 'SUM' | 'MAX';
  /** SQL expression summed into `qty`. Defaults to 0. */
  qty?: string;
  /** Extra predicates. Literals only — never a caller-supplied value. */
  where?: string;
  /** Qualified date column, or null to skip range filtering entirely. */
  dateCol: string | null;
}

const DATE_RULE_LABEL =
  'Transactions are filtered by date, flocks are not. A flock or batch appears here if it ' +
  'recorded at least one transaction inside the selected range, and it contributes only the ' +
  'revenue and costs dated inside that range. A flock that started before the range, or that ' +
  'continues past it, is neither included nor excluded as a whole — you are seeing its ' +
  'in-range slice only.';

const OPENING_BALANCE_LABEL =
  'A fixed starting figure carried forward from your previous system, not something this app ' +
  'calculated. It has no date of its own, so it is included here regardless of the date range ' +
  'selected above, and is kept separate from the profit this app calculated for the period.';

const TRANSFER_LABEL =
  'Feed, medicine and other stock supplied by your own distribution business is counted as a ' +
  'cost of this farm, because the farm consumed it. (The Overview dashboard removes these ' +
  'internal transfers, since at account level the money never left the owner. A farm report ' +
  'is not an account-level view, so it keeps them.)';

/**
 * Empty: broiler sales report weight sold (kg), which — unlike a bird count —
 * IS what `sales` records, so there is no unavailable figure left to caveat.
 */
const BROILER_MORTALITY_NOTE = '';

const LAYER_MORTALITY_NOTE =
  'Mortality and hens sold are date-filtered. Birds placed is each batch\'s opening bird count, ' +
  'which is a placement figure and so is not restricted to the range; the mortality percentage ' +
  'is therefore in-range deaths against the opening count.';

@Injectable({ providedIn: 'root' })
export class FarmReportService {

  constructor(private db: DatabaseService) {}

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Build the report for one farm unit. Never throws and never writes: a
   * failed query contributes zero and adds a line to `warnings`.
   *
   * @param unitId  null when the account has no farm_units yet — the report
   *                then covers every flock/batch of `moduleType`.
   */
  async getReport(
    farmId: number,
    unitId: number | null,
    moduleType: FarmReportModule,
    unitName: string,
    range: FarmReportDateRange = {},
    openingBalance: number = 0
  ): Promise<FarmReportSummary> {
    const warnings: string[] = [];

    if (!farmId) {
      return this.emptySummary(moduleType, unitId, unitName, range, unitId == null,
        ['No farm account is active — nothing to report.'], 0);
    }

    const flocks = await this.loadFlocks(farmId, unitId, moduleType, warnings);
    if (flocks.length === 0) {
      return this.emptySummary(moduleType, unitId, unitName, range, unitId == null, warnings, openingBalance);
    }

    const layer = moduleType === 'layer';
    const run = (spec: QuerySpec) =>
      this.ownerRows(this.buildQuery(farmId, unitId, moduleType, range, spec), warnings);

    // Broiler birds-placed and mortality both come off `flock_health`, computed
    // off the same real-date expression — one query, reused by both fields.
    const broilerHealthPromise = layer
      ? Promise.resolve({ birdsPlaced: [] as OwnerRow[], mortality: [] as OwnerRow[] })
      : this.loadBroilerHealthInRange(farmId, unitId, range, warnings);

    const [
      sales, henSales, income,
      feed, medicine, chicks, vaccination, labour, general, ledgerDebits,
      birdsPlaced, mortality
    ] = await Promise.all([
      // ── Revenue ──
      run(layer ? this.specEggSales() : this.specBroilerSales()),
      layer ? run(this.specHenSales()) : Promise.resolve([] as OwnerRow[]),
      run(this.specIncome(moduleType)),

      // ── Costs. No internal-transfer exclusion — see the file header. ──
      run(this.specTraderEntries(moduleType, 'feed')),
      run(this.specTraderEntries(moduleType, 'medicine')),
      run(this.specTraderEntries(moduleType, 'chick')),
      run(this.specVaccinations(moduleType)),
      run(this.specLabour(moduleType)),
      run(this.specExpenses(moduleType)),
      // Both modules have a ledger book now; they live in different tables keyed
      // on different ids, so the module picks the spec and nothing else changes.
      run(layer ? this.specLayerLedgerDebits() : this.specLedgerDebits()),

      // ── Birds. Layer takes birds placed off `batches` instead. ──
      layer ? Promise.resolve([] as OwnerRow[]) : broilerHealthPromise.then(r => r.birdsPlaced),
      layer ? run(this.specLayerMortality()) : broilerHealthPromise.then(r => r.mortality)
    ]);

    const owedToDistribution = await this.loadOwedToDistribution(farmId, unitId, range, warnings);

    // Every source below is now date-filtered (broiler `flock_health` included —
    // its real date is derived from the flock's start_date), so a dormant
    // flock is never dragged into the report by any of them.
    const revenueGroups = [sales, henSales, income];
    const expenseGroups = [feed, medicine, chicks, vaccination, labour, general, ledgerDebits];
    const activityGroups = [...revenueGroups, ...expenseGroups, mortality];

    const active = new Set<number>();
    for (const group of activityGroups) {
      for (const row of group) {
        if (row.rowCount > 0) active.add(row.ownerId);
      }
    }

    const revenue: FarmReportRevenue = {
      sales: this.sum(sales),
      henSales: this.sum(henSales),
      income: this.sum(income),
      total: this.sum(sales) + this.sum(henSales) + this.sum(income)
    };

    const expenses: FarmReportExpenses = {
      feed: this.sum(feed),
      medicine: this.sum(medicine),
      chicks: this.sum(chicks),
      vaccination: this.sum(vaccination),
      labour: this.sum(labour),
      general: this.sum(general),
      ledgerDebits: this.sum(ledgerDebits),
      total: this.sum(feed) + this.sum(medicine) + this.sum(chicks) +
             this.sum(vaccination) +
             this.sum(labour) + this.sum(general) + this.sum(ledgerDebits)
    };

    const placedById = layer
      ? new Map(flocks.map(f => [f.id, this.num(f.initialBirds)]))
      : this.byOwner(birdsPlaced, r => r.amount);

    // Sold quantity per flock — hen count for layer, weight (kg) for broiler,
    // since that's what `sales.bird_weight` actually records. Needed by both
    // the per-flock table and the totals below, so compute it once.
    const soldById = this.byOwner(layer ? henSales : sales, r => r.qty);

    const rows = this.buildFlockRows(flocks, active, placedById, soldById, layer, revenueGroups, expenseGroups);

    // Mortality totals cover the SAME flocks as the table above, so the two
    // cannot disagree.
    const mortalityById = this.byOwner(mortality, r => r.amount);

    let totalPlaced = 0;
    let totalMortality = 0;
    let totalSold = 0;
    for (const row of rows) {
      totalPlaced += row.birdsPlaced;
      totalMortality += mortalityById.get(row.id) || 0;
      totalSold += soldById.get(row.id) || 0;
    }

    // Broiler only — total weight sold spread over surviving birds. Skipped
    // (left null) rather than shown misleadingly when there's nothing to
    // divide by.
    const survivingBirds = totalPlaced - totalMortality;
    const avgWeightPerBirdKg = !layer && survivingBirds > 0 && totalSold > 0
      ? totalSold / survivingBirds
      : null;

    return {
      moduleType,
      unitId,
      unitName,
      range,
      revenue,
      expenses,
      netProfit: revenue.total - expenses.total,
      openingBalance,
      totalWithOpeningBalance: (revenue.total - expenses.total) + openingBalance,
      owedToDistribution,
      flocks: rows,
      mortality: {
        birdsPlaced: totalPlaced,
        birdsSold: layer ? totalSold : null,
        weightSoldKg: layer ? null : totalSold,
        mortality: totalMortality,
        mortalityRate: totalPlaced > 0 ? (totalMortality / totalPlaced) * 100 : 0,
        avgWeightPerBirdKg,
        note: layer ? LAYER_MORTALITY_NOTE : BROILER_MORTALITY_NOTE
      },
      dateRuleLabel: DATE_RULE_LABEL,
      transferLabel: TRANSFER_LABEL,
      openingBalanceLabel: OPENING_BALANCE_LABEL,
      hasFlocks: true,
      hasActivity: rows.length > 0,
      isAccountWideFallback: unitId == null,
      warnings
    };
  }

  // ── Revenue specs ────────────────────────────────────────────────────────
  //
  // `sale.component.ts`, `egg-sales.component.ts` and `hen-sales.component.ts`
  // each upsert a copy of their sale into `income` tagged
  // source = 'sale' / 'egg_sale' / 'hen_sale'. Counting the sale table AND
  // that mirror row would double the revenue, so the mirrors are excluded
  // here — the same guard `overview.service.ts` applies.

  private specBroilerSales(): QuerySpec {
    return {
      table: 'sales', alias: 's', ownerCol: 'flock_id',
      amount: 's.total_amount',
      qty: 's.bird_weight',
      where: `COALESCE(s.module_type,'broiler') = 'broiler'`,
      dateCol: 's.date'
    };
  }

  private specEggSales(): QuerySpec {
    return {
      table: 'egg_sales', alias: 'es', ownerCol: 'batch_id',
      amount: 'es.total_amount',
      qty: 'es.quantity',
      dateCol: 'es.date'
    };
  }

  private specHenSales(): QuerySpec {
    return {
      table: 'hen_sales', alias: 'hs', ownerCol: 'batch_id',
      amount: 'hs.total_amount',
      qty: 'hs.quantity',
      dateCol: 'hs.date'
    };
  }

  private specIncome(module: FarmReportModule): QuerySpec {
    return {
      table: 'income', alias: 'i', ownerCol: 'flock_id',
      amount: 'i.amount',
      where: module === 'layer'
        ? `i.module_type = 'layer' AND COALESCE(i.source,'manual') NOT IN ('egg_sale','hen_sale')`
        : `COALESCE(i.module_type,'broiler') = 'broiler' AND COALESCE(i.source,'manual') <> 'sale'`,
      dateCol: 'i.date'
    };
  }

  // ── Cost specs ───────────────────────────────────────────────────────────

  /**
   * `medicine_entries`, `feed_entries` and `chick_entries` share a shape, so
   * share a spec. All three carry `module_type` and reuse their `flock_id`
   * column for a `batch_id` on the layer side, which is why one `where` covers
   * every one of them.
   */
  private specTraderEntries(module: FarmReportModule, kind: 'medicine' | 'feed' | 'chick'): QuerySpec {
    return {
      table: `${kind}_entries`,
      alias: 't', ownerCol: 'flock_id',
      amount: 't.total_amount',
      qty: 't.quantity',
      where: module === 'layer'
        ? `t.module_type = 'layer'`
        : `COALESCE(t.module_type,'broiler') = 'broiler'`,
      dateCol: 't.date'
    };
  }

  /**
   * `vaccinations` serves both modules off two nullable columns. A row that
   * somehow carries both is attributed to layer only, so it cannot be counted
   * twice — same rule as `overview.service.ts`.
   */
  private specVaccinations(module: FarmReportModule): QuerySpec {
    return {
      table: 'vaccinations', alias: 'v',
      ownerCol: module === 'layer' ? 'batch_id' : 'flock_id',
      amount: 'v.cost',
      where: module === 'layer'
        ? 'v.batch_id IS NOT NULL'
        : 'v.batch_id IS NULL AND v.flock_id IS NOT NULL',
      dateCol: 'v.date'
    };
  }

  private specLabour(module: FarmReportModule): QuerySpec {
    return {
      table: 'labour_payments', alias: 'lp', ownerCol: 'flock_id',
      amount: 'lp.amount',
      where: module === 'layer'
        ? `lp.module_type = 'layer'`
        : `COALESCE(lp.module_type,'broiler') = 'broiler'`,
      dateCol: 'lp.date'
    };
  }

  private specExpenses(module: FarmReportModule): QuerySpec {
    return {
      table: 'expenses', alias: 'e', ownerCol: 'flock_id',
      amount: 'e.amount',
      where: module === 'layer'
        ? `e.module_type = 'layer'`
        : `COALESCE(e.module_type,'broiler') = 'broiler'`,
      dateCol: 'e.date'
    };
  }

  /**
   * Broiler side — `ledgers` hang off `flocks`. Every debit entered on the
   * Ledger screen, which since the separation is every debit there is: expenses
   * and ledgers are independent books, an expense writes no ledger row, and the
   * one-time migration deleted the mirrors already written. Strictly disjoint
   * from `general`. Reported as its own line rather than folded into `general`,
   * because the two are separate books on screen and the report has to be
   * readable against them.
   *
   * The `<> 'expense'` guard stays anyway — a no-op on a migrated database, and
   * the only thing stopping a double count on one where the migration has not
   * landed. Same guard in `report.component.ts` and `overview.service.ts`.
   */
  private specLedgerDebits(): QuerySpec {
    return {
      table: 'ledger_entries', alias: 'le', ownerCol: 'flock_id',
      amount: 'le.amount',
      where: `le.type = 'debit' AND COALESCE(le.source,'manual') <> 'expense'`,
      dateCol: 'le.date'
    };
  }

  /**
   * Layer side — `layer_ledgers` hang off `batches`, so the owner column is
   * `batch_id`. The mirror image of `specLedgerDebits()` above, and read the same
   * way by `overview.service.ts` (`qLayerLedgerDebits`), which is what keeps the
   * two in agreement.
   *
   * No `module_type` guard and no `source` guard: the layer ledger is its own pair
   * of batch-keyed tables (the `layer_health`-beside-`flock_health` pattern), so
   * the flock/batch id collision cannot reach it, and nothing auto-files into it,
   * so there is no mirror row to exclude. Strictly disjoint from `general` —
   * different tables entirely.
   */
  private specLayerLedgerDebits(): QuerySpec {
    return {
      table: 'layer_ledger_entries', alias: 'le', ownerCol: 'batch_id',
      amount: 'le.amount',
      where: `le.type = 'debit'`,
      dateCol: 'le.date'
    };
  }

  /**
   * Layer mortality comes off `layer_health`, the daily health table the layer Flock
   * Health screen writes. The old `layer_mortality` table it replaced is kept intact
   * as the migration's original but no longer receives writes, so reading it here
   * would report only mortality entered before the migration.
   */
  private specLayerMortality(): QuerySpec {
    return {
      table: 'layer_health', alias: 'lh', ownerCol: 'batch_id',
      amount: 'lh.mortality',
      dateCol: 'lh.date'
    };
  }

  // ── Query building ───────────────────────────────────────────────────────

  /**
   * Assembles one grouped query. Every interpolated fragment is a literal
   * from this file — table names, column names and fixed module_type values,
   * never caller input — so interpolating them is safe; farm id, unit id and
   * the date bounds all go in as `?` params, in the order they appear.
   */
  private buildQuery(
    farmId: number,
    unitId: number | null,
    module: FarmReportModule,
    range: FarmReportDateRange,
    spec: QuerySpec
  ): [string, any[]] {
    const layer = module === 'layer';
    const ownerCol = layer ? 'o.batch_id' : 'o.flock_id';
    const join = layer
      ? `JOIN batches o ON o.batch_id = ${spec.alias}.${spec.ownerCol}`
      : `JOIN flocks o ON o.flock_id = ${spec.alias}.${spec.ownerCol}`;

    const params: any[] = [farmId];
    let where = 'o.farm_id = ?';
    if (unitId != null) {
      where += ' AND o.unit_id = ?';
      params.push(unitId);
    }
    if (spec.where) where += ` AND ${spec.where}`;

    const sql =
      `SELECT ${ownerCol} AS owner_id,
              COALESCE(${spec.agg || 'SUM'}(${spec.amount}), 0) AS amount,
              COALESCE(SUM(${spec.qty || '0'}), 0) AS qty,
              COUNT(*) AS row_count
       FROM ${spec.table} ${spec.alias}
       ${join}
       WHERE ${where}` +
      (spec.dateCol ? this.dateClause(spec.dateCol, range, params) : '') +
      ` GROUP BY ${ownerCol}`;

    return [sql, params];
  }

  /** Appends the range predicates and pushes their params. */
  private dateClause(column: string, range: FarmReportDateRange, params: any[]): string {
    let sql = '';
    if (range.from) { sql += ` AND ${column} >= ?`; params.push(range.from); }
    if (range.to) { sql += ` AND ${column} <= ?`; params.push(range.to); }
    return sql;
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  /**
   * Every flock/batch owned by the unit, in range or not — the report needs
   * the full list to tell "this farm has no flocks" apart from "this farm's
   * flocks were idle over this period".
   */
  /**
   * What this farm still owes the distribution business.
   *
   * Distribution bills the owner's own farms like any other customer: an
   * own-farm bill (`payment_type = 'internal'`) carries the `customers` row for
   * this farm unit (`customer_type = 'own_farm'`, `unit_id = this unit`), and
   * `amount_paid` records how much of it the farm has settled.
   *
   * READ-ONLY and outside every other figure on this report — see
   * `FarmReportOwedToDistribution` for why adding it to costs would double-charge
   * the farm.
   *
   * Two cases have no debt to show and correctly return zero: an account with no
   * farm_units at all (`unitId == null`, where there is no per-farm customer to
   * attribute anything to), and a farm that has simply never been supplied.
   * The per-bill clamp matches `getBillPaidAmount()` in
   * distribution-report.component.ts, so the farm's view of what it owes and
   * distribution's view of what it is owed are the same number.
   */
  private async loadOwedToDistribution(
    farmId: number,
    unitId: number | null,
    range: FarmReportDateRange,
    warnings: string[]
  ): Promise<FarmReportOwedToDistribution> {
    const empty = { outstanding: 0, billed: 0, unpaidBillCount: 0 };
    if (unitId == null) return empty;

    // A stock, not a flow: only the upper bound applies.
    const params: any[] = [farmId, unitId];
    let dateClause = '';
    if (range.to) {
      dateClause = ' AND b.bill_date <= ?';
      params.push(range.to);
    }

    const res = await this.db.get(
      `SELECT COALESCE(SUM(
                MAX(COALESCE(b.total_amount, 0)
                    - MIN(MAX(COALESCE(b.amount_paid, 0), 0), COALESCE(b.total_amount, 0)), 0)
              ), 0) AS outstanding,
              COALESCE(SUM(COALESCE(b.total_amount, 0)), 0) AS billed,
              COALESCE(SUM(
                CASE WHEN COALESCE(b.total_amount, 0)
                        - MIN(MAX(COALESCE(b.amount_paid, 0), 0), COALESCE(b.total_amount, 0)) > 0
                     THEN 1 ELSE 0 END
              ), 0) AS unpaid_bill_count
       FROM bills b
       JOIN customers c ON c.customer_id = b.customer_id
       WHERE b.farm_id = ?
         AND COALESCE(b.payment_type, 'cash') = 'internal'
         AND c.customer_type = 'own_farm'
         AND c.unit_id = ?${dateClause}`,
      params
    );

    if (!res?.success) {
      warnings.push('Could not load what this farm owes distribution: ' + friendlySqlError(res?.error, 'unknown error'));
      return empty;
    }

    const row = (res.data && res.data[0]) || {};
    return {
      outstanding: this.num(row.outstanding),
      billed: this.num(row.billed),
      unpaidBillCount: this.num(row.unpaid_bill_count)
    };
  }

  private async loadFlocks(
    farmId: number,
    unitId: number | null,
    module: FarmReportModule,
    warnings: string[]
  ): Promise<Array<{ id: number; name: string; startDate: string | null; initialBirds: number }>> {
    const params: any[] = [farmId];
    let where = 'farm_id = ?';
    if (unitId != null) {
      where += ' AND unit_id = ?';
      params.push(unitId);
    }

    const sql = module === 'layer'
      ? `SELECT batch_id AS id, batch_name AS name, start_date, initial_birds
         FROM batches WHERE ${where} ORDER BY start_date ASC, batch_id ASC`
      : `SELECT flock_id AS id, flock_name AS name, start_date, 0 AS initial_birds
         FROM flocks WHERE ${where} ORDER BY start_date ASC, flock_id ASC`;

    const res = await this.db.get(sql, params);
    if (!res?.success) {
      warnings.push(
        (module === 'layer' ? 'Could not load batches: ' : 'Could not load flocks: ') +
        friendlySqlError(res?.error, 'unknown error')
      );
      return [];
    }

    return (res.data || []).map((r: any) => ({
      id: r.id,
      name: r.name || (module === 'layer' ? `Batch #${r.id}` : `Flock #${r.id}`),
      startDate: r.start_date ?? null,
      initialBirds: this.num(r.initial_birds)
    }));
  }

  /**
   * Broiler birds placed and mortality, both date-filtered off `flock_health`.
   *
   * `week_number` is a 1-based DAY index despite its name (see CLAUDE.md) —
   * the UI labels it "Day", and day 1 is the flock's own `start_date`. So a
   * row's real date is `start_date + (week_number - 1) days`; that expression
   * is what the range is filtered against, same as every other source here.
   *
   * Birds placed is the `total_birds` on the earliest row inside the range
   * (rows come back ordered by `week_number`, so the first one seen per flock
   * is it) — mirroring how layer's opening count is a placement figure, not a
   * sum. Mortality is the sum of in-range rows.
   */
  private async loadBroilerHealthInRange(
    farmId: number,
    unitId: number | null,
    range: FarmReportDateRange,
    warnings: string[]
  ): Promise<{ birdsPlaced: OwnerRow[]; mortality: OwnerRow[] }> {
    const realDate = `date(o.start_date, '+' || (fh.week_number - 1) || ' days')`;
    const params: any[] = [farmId];
    let where = 'o.farm_id = ?';
    if (unitId != null) {
      where += ' AND o.unit_id = ?';
      params.push(unitId);
    }
    if (range.from) { where += ` AND ${realDate} >= ?`; params.push(range.from); }
    if (range.to) { where += ` AND ${realDate} <= ?`; params.push(range.to); }

    const sql =
      `SELECT fh.flock_id AS owner_id, fh.week_number, fh.total_birds, fh.mortality
       FROM flock_health fh
       JOIN flocks o ON o.flock_id = fh.flock_id
       WHERE ${where}
       ORDER BY fh.flock_id ASC, fh.week_number ASC`;

    const res = await this.db.get(sql, params);
    if (!res?.success) {
      warnings.push('Could not load broiler health records: ' + friendlySqlError(res?.error, 'unknown error'));
      return { birdsPlaced: [], mortality: [] };
    }

    const perFlock = new Map<number, { birdsPlaced: number; mortality: number; rowCount: number }>();
    for (const row of res.data || []) {
      const ownerId = Number(row.owner_id);
      const entry = perFlock.get(ownerId) || { birdsPlaced: 0, mortality: 0, rowCount: 0 };
      if (entry.rowCount === 0) entry.birdsPlaced = this.num(row.total_birds);
      entry.mortality += this.num(row.mortality);
      entry.rowCount++;
      perFlock.set(ownerId, entry);
    }

    const birdsPlaced: OwnerRow[] = [];
    const mortality: OwnerRow[] = [];
    for (const [ownerId, v] of perFlock) {
      birdsPlaced.push({ ownerId, amount: v.birdsPlaced, qty: 0, rowCount: v.rowCount });
      mortality.push({ ownerId, amount: v.mortality, qty: 0, rowCount: v.rowCount });
    }
    return { birdsPlaced, mortality };
  }

  /** Runs a grouped query. `db.get()` reports failure in `.success`, it does not throw. */
  private async ownerRows([sql, params]: [string, any[]], warnings: string[]): Promise<OwnerRow[]> {
    const res = await this.db.get(sql, params);
    if (!res?.success) {
      warnings.push('Report query failed: ' + friendlySqlError(res?.error, 'unknown error'));
      return [];
    }
    return (res.data || [])
      .filter((r: any) => r.owner_id != null)
      .map((r: any) => ({
        ownerId: Number(r.owner_id),
        amount: this.num(r.amount),
        qty: this.num(r.qty),
        rowCount: this.num(r.row_count)
      }));
  }

  // ── Assembly ─────────────────────────────────────────────────────────────

  /** One row per flock that had activity in range, best profit first. */
  private buildFlockRows(
    flocks: Array<{ id: number; name: string; startDate: string | null; initialBirds: number }>,
    active: Set<number>,
    placedById: Map<number, number>,
    soldById: Map<number, number>,
    layer: boolean,
    revenueGroups: OwnerRow[][],
    expenseGroups: OwnerRow[][]
  ): FarmReportFlockRow[] {
    const revenueById = this.foldGroups(revenueGroups);
    const expensesById = this.foldGroups(expenseGroups);

    return flocks
      .filter(f => active.has(f.id))
      .map(f => {
        const revenue = revenueById.get(f.id) || 0;
        const expenses = expensesById.get(f.id) || 0;
        const sold = soldById.get(f.id) || 0;
        return {
          id: f.id,
          name: f.name,
          startDate: f.startDate,
          birdsPlaced: placedById.get(f.id) || 0,
          birdsSold: layer ? sold : null,
          weightSoldKg: layer ? null : sold,
          revenue,
          expenses,
          profit: revenue - expenses
        };
      })
      .sort((a, b) => b.profit - a.profit);
  }

  private foldGroups(groups: OwnerRow[][]): Map<number, number> {
    const out = new Map<number, number>();
    for (const rows of groups) {
      for (const row of rows) {
        out.set(row.ownerId, (out.get(row.ownerId) || 0) + row.amount);
      }
    }
    return out;
  }

  private byOwner(rows: OwnerRow[], pick: (row: OwnerRow) => number): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of rows) {
      out.set(row.ownerId, (out.get(row.ownerId) || 0) + pick(row));
    }
    return out;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private sum(rows: OwnerRow[]): number {
    return rows.reduce((s, r) => s + r.amount, 0);
  }

  private num(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private emptySummary(
    moduleType: FarmReportModule,
    unitId: number | null,
    unitName: string,
    range: FarmReportDateRange,
    isAccountWideFallback: boolean,
    warnings: string[],
    openingBalance: number
  ): FarmReportSummary {
    return {
      moduleType,
      unitId,
      unitName,
      range,
      revenue: { total: 0, sales: 0, henSales: 0, income: 0 },
      expenses: {
        total: 0, feed: 0, medicine: 0, chicks: 0, vaccination: 0,
        labour: 0, general: 0, ledgerDebits: 0
      },
      netProfit: 0,
      openingBalance,
      totalWithOpeningBalance: openingBalance,
      owedToDistribution: { outstanding: 0, billed: 0, unpaidBillCount: 0 },
      flocks: [],
      mortality: {
        birdsPlaced: 0,
        birdsSold: moduleType === 'layer' ? 0 : null,
        weightSoldKg: moduleType === 'layer' ? null : 0,
        mortality: 0,
        mortalityRate: 0,
        avgWeightPerBirdKg: null,
        note: moduleType === 'layer' ? LAYER_MORTALITY_NOTE : BROILER_MORTALITY_NOTE
      },
      dateRuleLabel: DATE_RULE_LABEL,
      transferLabel: TRANSFER_LABEL,
      openingBalanceLabel: OPENING_BALANCE_LABEL,
      hasFlocks: false,
      hasActivity: false,
      isAccountWideFallback,
      warnings
    };
  }
}
