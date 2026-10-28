import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { friendlySqlError } from '../utils/sql-error.util';
import { distributionBillsOnly } from '../utils/bill-source.util';

/**
 * Account-wide financial consolidation for the Overview dashboard.
 *
 * READ-ONLY. Every statement in this file is a SELECT — nothing here calls
 * `db.run()`. There are no transactions in this codebase, so a service that
 * both reads and writes across seven modules could half-complete and leave
 * the books inconsistent; consolidation therefore never writes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PICTURE: MONEY IN, MONEY OUT, PROFIT OR LOSS
 * ─────────────────────────────────────────────────────────────────────────
 * The dashboard shows one thing: profit = money in - money out. For broiler and
 * layer, revenue is counted when a sale is recorded, not when it is collected,
 * because `sales`, `egg_sales` and `hen_sales` carry a `payment_type` but no
 * customer-payment table — there is no way to know how much of a credit sale
 * has since been collected, so recording-time is the only basis those modules
 * can actually produce.
 *
 * Distribution is the exception, and deliberately so: `bills.amount_paid` is
 * maintained per bill, so distribution revenue is counted when it is COLLECTED
 * (`qDistributionBills()`). An unpaid bill must never appear as profit — that
 * is a standing rule from the client, not an implementation preference. The
 * uncollected balance is reported as `revenue.distributionUnpaid`, outside both
 * `revenue.total` and profit. `distribution-report.component.ts` applies the
 * same rule with the same clamp, so the two screens agree.
 *
 * Everything to do with assets is cash as it happens instead: an asset
 * installment counts as money out when it is actually paid, not when the
 * asset is bought, and selling an asset counts as money in at the full sale
 * price, not the gain over its cost.
 *
 * There is still deliberately no bank balance or cash-position figure on this
 * dashboard, and adding one is a separate decision from the reliability of the
 * underlying data. (An asset installment paid by bank does now write a real
 * `bank_ledger` withdrawal — see the ASSET PAYMENTS AGAINST A BANK ACCOUNT
 * block in database.service.ts — which fixes the upward drift that got the
 * figure removed in the first place. It changes nothing here: a bank balance
 * is a position, money in / money out / profit are flows, and the same
 * installment must not be counted as both.) Nothing in this file reads
 * `bank_accounts` or `bank_ledger`, and nothing should start to without that
 * distinction being made deliberately.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DISTRIBUTION COST: COST OF GOODS SOLD, NOT PURCHASES
 * ─────────────────────────────────────────────────────────────────────────
 * Distribution's cost is the purchase cost of the stock that actually SOLD,
 * traced through `batch_transactions` -> `product_batches.purchase_price`.
 * It is not `purchase_orders.total_amount`.
 *
 * Charging every purchase against the period treats buying stock as spending
 * money, when it converts cash into an asset the owner still holds. A shop
 * that had bought Rs 7.24m of stock and sold Rs 12.5k of it read as a Rs 7.24m
 * loss, with Rs 7.23m of that sitting on its own shelves. `qDistributionCogs()`
 * carries the full derivation, including how partly-costed and uncosted sales
 * are handled; `distribution-report.component.ts` computes the same figure the
 * same way, so the two screens agree.
 *
 * Purchase returns are consequently NOT credited against profit any more:
 * stock sent back to a supplier never sold, so its cost never entered COGS.
 * `expenses.purchases` and `expenses.purchaseReturns` are still reported for
 * reference, but neither is part of `expenses.total`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INTERNAL TRANSFERS
 * ─────────────────────────────────────────────────────────────────────────
 * When distribution sells to a broiler flock or layer batch, the app books BOTH
 * sides: a `bills` row (revenue, owed by that farm) and a cost row in the target
 * module (expense). At account level those cancel — see the block above
 * `internalBillIdsSql()` for exactly which rows are dropped and how they are
 * identified.
 *
 * THIS ELIMINATION IS THE WHOLE POINT AND MUST NOT BE RELAXED. The distribution
 * report counts own-farm sales as its own revenue, because for that business
 * they are real sales; here they are not, because the money never left the
 * owner. Without the elimination he could bill his own farm repeatedly and watch
 * company profit grow out of nothing. What survives is the purchase cost of the
 * goods, via `qDistributionCogs()` — that is the only part the owner is actually
 * out of pocket for.
 *
 * Both sides are eliminated on an ACCRUAL basis — the bill's whole
 * `total_amount` and the whole cost row — with no reference to `amount_paid`.
 * So how much of an own-farm bill the farm has settled cannot unbalance the
 * elimination, and nothing here moves when a farm pays.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING
 * ─────────────────────────────────────────────────────────────────────────
 * Everything is filtered by the logged-in account's `farm_id`, per the
 * multi-tenancy rule. "Per-farm breakdown" means per `farm_units` row (the
 * client-facing "Farm"), NOT per `farms` row — `farms` is the login account,
 * and aggregating across accounts would leak one customer's data into
 * another's dashboard.
 */

/** Inclusive date bounds, 'YYYY-MM-DD'. Omit/null either side for open-ended. */
export interface OverviewDateRange {
  from?: string | null;
  to?: string | null;
}

export interface OverviewRevenue {
  total: number;
  broiler: number;
  layer: number;
  /** Distribution revenue actually COLLECTED. See `qDistributionBills()`. */
  distribution: number;
  /**
   * External distribution bills billed but not yet collected. Reported for
   * visibility only — deliberately NOT part of `distribution` or `total`, and
   * therefore never part of profit.
   */
  distributionUnpaid: number;
}

export interface OverviewExpenses {
  total: number;
  /** expenses table, broiler + layer */
  general: number;
  medicine: number;
  feed: number;
  /**
   * `chick_entries`, both modules. Chicks are a purchased input like feed and
   * medicine and get their own line for the same reason: the client buys them
   * from a hatchery at a rate per chick and wants to see what they cost. It is
   * part of `total` and of `byModule`.
   */
  chicks: number;
  vaccination: number;
  labour: number;
  /**
   * Ledger-screen debits, both modules: broiler `ledger_entries` (keyed on
   * flock_id) plus layer `layer_ledger_entries` (keyed on batch_id). Two tables,
   * one figure — the Ledger screen's own book on each side, holding no expenses.
   * Split per module in `byModule`, like every other line here.
   */
  ledgerDebits: number;
  /**
   * Purchase cost of the distribution stock that actually sold in the period.
   * This is the distribution module's cost of sales and IS part of `total`.
   */
  costOfGoodsSold: number;
  /**
   * Gross purchase_orders in the period. Reference only — NOT in `total`.
   * Buying stock is an asset swap, not an expense; `costOfGoodsSold` is the
   * expense. Shown so the dashboard can reconcile purchases to stock on hand.
   */
  purchases: number;
  /** purchase_returns in the period. Reference only — NOT in `total`. */
  purchaseReturns: number;
  /** expense_ledger — the distribution module's own expense book */
  distributionExpenses: number;
  byModule: { broiler: number; layer: number; distribution: number };
}

/** The compact assets section: what is owned, and what is still owed on it. */
export interface OverviewAssets {
  /** Total agreed price of assets still owned (not sold), as at range.to. */
  activeValue: number;
  /** Still owed on installments across every asset, sold ones included, as at range.to. */
  outstanding: number;
  /**
   * Bottom-of-dashboard totals. Point-in-time like `activeValue`/`outstanding`
   * above (and like `openingBalance`): every figure is "as at range.to", so it
   * only honours the upper bound of the date filter, never the lower one — an
   * asset bought before the visible window is still something the farm owns
   * today. `range.to` unset means "as of now", the same as everywhere else in
   * this section.
   */
  totals: {
    /** Every asset on file (active + sold) purchased on/before range.to. */
    count: number;
    /** Sum of their agreed price (COALESCE total_price, purchase_amount). */
    purchaseValue: number;
    /** Every asset_payments row (any asset) dated on/before range.to. */
    paid: number;
    /** Sum of sale_amount for assets sold on/before range.to. */
    soldFor: number;
    /** sale_amount - agreed price, summed over sold assets with a known agreed price. */
    profitLoss: number;
    /** Sold assets excluded from `profitLoss` because they have no agreed price on file. */
    excludedFromProfitLoss: number;
  };
}

export interface OverviewFarmProfit {
  /** null when the flock/batch has no unit_id, or for the distribution row. */
  unitId: number | null;
  unitName: string;
  moduleType: 'broiler' | 'layer' | 'distribution';
  revenue: number;
  expenses: number;
  profit: number;
  /**
   * `farm_units.opening_balance` for this row's unit — 0 for the "Unassigned"
   * buckets, which are not a real farm_units row. The "Distribution" bucket is
   * the one exception: it carries `app_settings['distribution_opening_balance']`
   * instead, since distribution is one business per account with no farm_units
   * row of its own — see `OverviewSummary.openingBalance`. Kept OUT of `profit`
   * on purpose either way.
   */
  openingBalance: number;
}

export interface OverviewInternalTransfers {
  /** Number of bills with payment_type = 'internal' inside the range. */
  billCount: number;
  /** Distribution revenue removed (sum of those bills' total_amount). */
  revenueExcluded: number;
  /** Broiler/layer cost rows removed (the matching other side). */
  expenseExcluded: number;
  /** Rows removed on the expense side. */
  expenseRowCount: number;
  /**
   * Of `revenueExcluded`, the part the owner's farms have not yet settled with
   * the distribution business. Purely informational — it is money owed by one
   * part of the account to another, so it is in neither revenue nor profit, and
   * it is deliberately absent from `revenue.distributionUnpaid`, which reports
   * only what OUTSIDE customers owe.
   */
  unsettledInternal: number;
}

/**
 * Distribution stock still on hand, valued at what it cost to buy. Not part of
 * profit — it is the asset the purchases turned into, reported so a large
 * purchase figure can be reconciled against something visible.
 *
 * Point-in-time, valued as at now: `product_batches` holds only a live quantity
 * with no movement history to rewind, so this ignores `range`.
 */
export interface OverviewInventory {
  /** Cost value of unexpired stock with quantity remaining. */
  value: number;
  /** Units sitting in batches with no purchase price — valued at a fallback rate. */
  unpricedUnits: number;
}

export interface OverviewMoneyIn {
  total: number;
  /** All revenue, accrual, every module, internal transfers eliminated. */
  revenue: number;
  /** Full sale_amount of assets sold in the period — money in, not gain/loss. */
  assetSales: number;
}

export interface OverviewMoneyOut {
  total: number;
  /** Business expenses across every module, including distribution COGS. */
  expenses: number;
  /** Owner's drawings (personal_expenses). */
  personal: number;
  /** Asset installments actually paid in the period. */
  assetPayments: number;
}

export interface OverviewSummary {
  range: OverviewDateRange;
  revenue: OverviewRevenue;
  expenses: OverviewExpenses;
  inventory: OverviewInventory;
  moneyIn: OverviewMoneyIn;
  moneyOut: OverviewMoneyOut;
  profit: number;
  /**
   * Sum of every farm_units row's `opening_balance` for this account PLUS
   * Distribution's own carried-forward figure — profit carried forward from
   * the client's previous system, entered by hand rather than calculated.
   * Distribution has no farm_units row (it is one business per account, not
   * several), so its value lives in `app_settings['distribution_opening_balance']`
   * instead and is added in here exactly once, alongside every farm's own
   * figure. A point-in-time figure with no date, so `range` is ignored and it
   * is always the account's full carried-forward total, regardless of the
   * period selected. Kept OUT of `moneyIn`/`profit`; it is neither revenue nor
   * an internal transfer. See `profitWithOpeningBalance`.
   */
  openingBalance: number;
  /** `profit + openingBalance` — the only place the two are combined. */
  profitWithOpeningBalance: number;
  assets: OverviewAssets;
  perFarm: OverviewFarmProfit[];
  internalTransfers: OverviewInternalTransfers;
  /** Non-fatal problems (failed queries, data the basis can't represent). */
  warnings: string[];
}

/** One `GROUP BY unit_id` bucket. */
interface UnitRow {
  unitId: number | null;
  amount: number;
  rowCount: number;
}

type ModuleKey = 'broiler' | 'layer' | 'distribution';

@Injectable({ providedIn: 'root' })
export class OverviewService {

  constructor(private db: DatabaseService) {}

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Consolidate every module for `farmId`, optionally restricted to a date
   * range. Never throws and never writes: a failed query contributes zero and
   * adds a line to `warnings`.
   */
  async getSummary(farmId: number, range: OverviewDateRange = {}): Promise<OverviewSummary> {
    const warnings: string[] = [];

    if (!farmId) {
      return this.emptySummary(range, ['No farm account is active — nothing to consolidate.']);
    }

    const [
      units,
      broilerSales, eggSales, henSales, broilerIncome, layerIncome,
      distributionBills, distributionBillsAll, distributionUnpaidBills, internalBills,
      broilerExpenses, layerExpenses,
      broilerMedicine, layerMedicine,
      broilerFeed, layerFeed,
      broilerChicks, layerChicks,
      broilerVaccination, layerVaccination,
      broilerLabour, layerLabour,
      broilerLedgerDebits, layerLedgerDebits,
      broilerInternalCost, layerInternalCost,
      purchases, purchaseReturns, distributionCogs, inventoryOnHand, distributionExpenses,
      internalExpenseSide,
      assetSales, assetsActive, assetPayments, assetOutstanding, assetTotals,
      personal, distributionOpeningBalanceRow
    ] = await Promise.all([
      this.loadUnits(farmId, warnings),

      // ── Revenue ──
      this.unitRows(this.qBroilerSales(farmId, range), warnings),
      this.unitRows(this.qEggSales(farmId, range), warnings),
      this.unitRows(this.qHenSales(farmId, range), warnings),
      this.unitRows(this.qBroilerIncome(farmId, range), warnings),
      this.unitRows(this.qLayerIncome(farmId, range), warnings),
      this.scalarRow(this.qDistributionBills(farmId, range), warnings),
      this.scalarRow(this.qDistributionBillsAll(farmId, range), warnings),
      this.scalarRow(this.qDistributionUnpaid(farmId, range), warnings),
      this.scalarRow(this.qInternalBills(farmId, range), warnings),

      // ── Expenses ──
      this.unitRows(this.qExpenses(farmId, range, 'broiler'), warnings),
      this.unitRows(this.qExpenses(farmId, range, 'layer'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'broiler', 'medicine'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'layer', 'medicine'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'broiler', 'feed'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'layer', 'feed'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'broiler', 'chick'), warnings),
      this.unitRows(this.qTraderEntries(farmId, range, 'layer', 'chick'), warnings),
      this.unitRows(this.qVaccinations(farmId, range, 'broiler'), warnings),
      this.unitRows(this.qVaccinations(farmId, range, 'layer'), warnings),
      this.unitRows(this.qLabour(farmId, range, 'broiler'), warnings),
      this.unitRows(this.qLabour(farmId, range, 'layer'), warnings),
      this.unitRows(this.qLedgerDebits(farmId, range), warnings),
      this.unitRows(this.qLayerLedgerDebits(farmId, range), warnings),
      this.unitRows(this.qInternalCostByUnit(farmId, range, 'broiler'), warnings),
      this.unitRows(this.qInternalCostByUnit(farmId, range, 'layer'), warnings),
      this.scalarRow(this.qPurchases(farmId, range), warnings),
      this.scalarRow(this.qPurchaseReturns(farmId, range), warnings),
      this.scalarRow(this.qDistributionCogs(farmId, range), warnings),
      this.scalarRow(this.qInventoryOnHand(farmId), warnings),
      this.scalarRow(this.qDistributionExpenses(farmId, range), warnings),
      this.scalarRow(this.qInternalExpenseSide(farmId, range), warnings),

      // ── Assets / personal ──
      this.scalarRow(this.qAssetSales(farmId, range), warnings),
      this.scalarRow(this.qAssetsActive(farmId, range), warnings),
      this.scalarRow(this.qAssetPayments(farmId, range), warnings),
      this.scalarRow(this.qAssetOutstanding(farmId, range), warnings),
      this.scalarRow(this.qAssetTotals(farmId, range), warnings),
      this.scalarRow(this.qPersonalExpenses(farmId, range), warnings),
      this.scalarRow(this.qDistributionOpeningBalance(farmId), warnings)
    ]);

    // ── Revenue ────────────────────────────────────────────────────────────
    const broilerRevenue = this.sum(broilerSales) + this.sum(broilerIncome);
    const layerRevenue = this.sum(eggSales) + this.sum(henSales) + this.sum(layerIncome);
    const distributionRevenue = this.num(distributionBills['amount']);
    const distributionUnpaid = this.num(distributionUnpaidBills['amount']);
    // Collected revenue across ALL bills, own-farm ones included — see
    // qDistributionBillsAll(). Per-farm breakdown only; the headline above
    // keeps eliminating internal transfers.
    const distributionRevenueAll = this.num(distributionBillsAll['amount']);

    const revenue: OverviewRevenue = {
      // distributionUnpaid is deliberately absent from `total`: an uncollected
      // bill is not profit. See qDistributionBills().
      total: broilerRevenue + layerRevenue + distributionRevenue,
      broiler: broilerRevenue,
      layer: layerRevenue,
      distribution: distributionRevenue,
      distributionUnpaid
    };

    // ── Expenses ───────────────────────────────────────────────────────────
    const general = this.sum(broilerExpenses) + this.sum(layerExpenses);
    const medicine = this.sum(broilerMedicine) + this.sum(layerMedicine);
    const feed = this.sum(broilerFeed) + this.sum(layerFeed);
    const chicks = this.sum(broilerChicks) + this.sum(layerChicks);
    const vaccination = this.sum(broilerVaccination) + this.sum(layerVaccination);
    const labour = this.sum(broilerLabour) + this.sum(layerLabour);
    // Two tables, one line. `ledger_entries` is keyed on flock_id and
    // `layer_ledger_entries` on batch_id, so no row can land in both — they are
    // separate tables precisely so the colliding ids cannot be confused.
    const ledgerDebits = this.sum(broilerLedgerDebits) + this.sum(layerLedgerDebits);
    // Distribution's cost of sales is COGS, not purchases. See qDistributionCogs().
    // Purchases and purchase returns are reported alongside it for reconciliation
    // but neither enters the total: money spent on stock that has not sold is an
    // asset, and stock handed back to a supplier never sold in the first place.
    const grossPurchases = this.num(purchases['amount']);
    const purchaseReturnsTotal = this.num(purchaseReturns['amount']);
    const costOfGoodsSold = this.num(distributionCogs['amount']);
    const distExpenses = this.num(distributionExpenses['amount']);

    const broilerExpenseTotal =
      this.sum(broilerExpenses) + this.sum(broilerMedicine) + this.sum(broilerFeed) +
      this.sum(broilerChicks) +
      this.sum(broilerVaccination) + this.sum(broilerLabour) + this.sum(broilerLedgerDebits);
    const layerExpenseTotal =
      this.sum(layerExpenses) + this.sum(layerMedicine) + this.sum(layerFeed) +
      this.sum(layerChicks) +
      this.sum(layerVaccination) + this.sum(layerLabour) + this.sum(layerLedgerDebits);
    const distributionExpenseTotal = costOfGoodsSold + distExpenses;

    const expenses: OverviewExpenses = {
      total: broilerExpenseTotal + layerExpenseTotal + distributionExpenseTotal,
      general,
      medicine,
      feed,
      chicks,
      vaccination,
      labour,
      ledgerDebits,
      costOfGoodsSold,
      purchases: grossPurchases,
      purchaseReturns: purchaseReturnsTotal,
      distributionExpenses: distExpenses,
      byModule: {
        broiler: broilerExpenseTotal,
        layer: layerExpenseTotal,
        distribution: distributionExpenseTotal
      }
    };

    const inventory: OverviewInventory = {
      value: this.num(inventoryOnHand['amount']),
      unpricedUnits: this.num(inventoryOnHand['unpriced_qty'])
    };

    const uncostedUnits = this.num(distributionCogs['uncosted_qty']);
    if (uncostedUnits > 0) {
      warnings.push(
        `${uncostedUnits.toLocaleString()} unit(s) of distribution stock sold in this period are ` +
        'costed at an estimated rate rather than the price recorded on the batch they came from ' +
        '(bills predating the batch module, or batches saved without a purchase price). ' +
        'The Distribution Report breaks this down per product.'
      );
    }
    if (inventory.unpricedUnits > 0) {
      warnings.push(
        `${inventory.unpricedUnits.toLocaleString()} unit(s) of stock on hand sit in batches with no ` +
        'purchase price, so the inventory value shown for them is an estimate.'
      );
    }

    // ── Assets ─────────────────────────────────────────────────────────────
    const assets: OverviewAssets = {
      activeValue: this.num(assetsActive['amount']),
      outstanding: this.num(assetOutstanding['amount']),
      totals: {
        count: this.num(assetTotals['asset_count']),
        purchaseValue: this.num(assetTotals['total_purchase_value']),
        paid: this.num(assetTotals['total_paid']),
        soldFor: this.num(assetTotals['total_sold_for']),
        profitLoss: this.num(assetTotals['profit_loss']),
        excludedFromProfitLoss: this.num(assetTotals['excluded_count'])
      }
    };

    // ── Money in / money out / profit ─────────────────────────────────────
    const assetSalesTotal = this.num(assetSales['amount']);
    const assetPaymentsTotal = this.num(assetPayments['amount']);
    const personalTotal = this.num(personal['amount']);

    const moneyIn: OverviewMoneyIn = {
      total: revenue.total + assetSalesTotal,
      revenue: revenue.total,
      assetSales: assetSalesTotal
    };

    const moneyOut: OverviewMoneyOut = {
      total: expenses.total + personalTotal + assetPaymentsTotal,
      expenses: expenses.total,
      personal: personalTotal,
      assetPayments: assetPaymentsTotal
    };

    const profit = moneyIn.total - moneyOut.total;

    // Point-in-time, hand-entered figure with no date of its own — summed
    // straight off `units` (already loaded above) rather than a fresh query,
    // plus Distribution's own app_settings figure, and deliberately NOT
    // restricted by `range`. See OverviewSummary.openingBalance.
    const distributionOpeningBalance = this.num(distributionOpeningBalanceRow['value']);
    const openingBalance =
      units.reduce((s, u) => s + this.num(u.opening_balance), 0) + distributionOpeningBalance;

    // ── Per-farm breakdown ─────────────────────────────────────────────────
    const perFarm = this.buildPerFarm(units, {
      broilerRevenue: [broilerSales, broilerIncome],
      layerRevenue: [eggSales, henSales, layerIncome],
      broilerExpenses: [
        broilerExpenses, broilerMedicine, broilerFeed, broilerChicks,
        broilerVaccination, broilerLabour, broilerLedgerDebits, broilerInternalCost
      ],
      layerExpenses: [
        layerExpenses, layerMedicine, layerFeed, layerChicks, layerVaccination, layerLabour,
        layerLedgerDebits, layerInternalCost
      ]
    }, distributionRevenueAll, distributionExpenseTotal, distributionOpeningBalance);

    // ── Internal transfer diagnostics ──────────────────────────────────────
    const internalTransfers: OverviewInternalTransfers = {
      billCount: this.num(internalBills['row_count']),
      revenueExcluded: this.num(internalBills['amount']),
      expenseExcluded: this.num(internalExpenseSide['amount']),
      expenseRowCount: this.num(internalExpenseSide['row_count']),
      unsettledInternal: this.num(internalBills['unsettled'])
    };

    if (Math.abs(internalTransfers.revenueExcluded - internalTransfers.expenseExcluded) > 1) {
      warnings.push(
        'Internal transfers do not balance for this period: ' +
        `${internalTransfers.revenueExcluded.toFixed(2)} removed from distribution revenue but ` +
        `${internalTransfers.expenseExcluded.toFixed(2)} removed from broiler/layer costs. ` +
        'Returns re-date the cost side to the return date, so a period boundary can split a ' +
        'transfer; a persistent gap means orphaned rows from a half-completed save.'
      );
    }

    return {
      range,
      revenue,
      expenses,
      inventory,
      moneyIn,
      moneyOut,
      profit,
      openingBalance,
      profitWithOpeningBalance: profit + openingBalance,
      assets,
      perFarm,
      internalTransfers,
      warnings
    };
  }

  // ── Internal transfer elimination ────────────────────────────────────────

  /**
   * The two sides of an internal transfer and how each is recognised.
   *
   * REVENUE SIDE — `bills` rows written by `sales-orders.component.ts` when
   * `customerType === 'internal'`. They are stamped `payment_type = 'internal'`
   * and carry the own-farm `customers` row that owes for them, with a real
   * `amount_paid` recording how much that farm has settled. Dropped by
   * `COALESCE(payment_type,'cash') <> 'internal'` — the FULL total_amount,
   * regardless of what has been settled, because a payment from the owner's farm
   * to the owner's shop is not income to the owner either. Every internal bill
   * is dropped, including one whose cost side failed to write: it is still not a
   * sale outside the business.
   *
   * EXPENSE SIDE — one row per bill item, in whichever table matches the
   * product's category. `internal_transfers` is the join table:
   *
   *   target_type   | table            | key matched against
   *   ------------- | ---------------- | ----------------------------------
   *   'medicine'    | medicine_entries | entry_id
   *   'feed'        | feed_entries     | entry_id
   *   'chick'       | chick_entries    | entry_id
   *   'vaccination' | vaccinations     | vaccination_id
   *   'expense'     | expenses         | expense_id
   *   NULL (legacy) | expenses         | expense_id
   *
   * `target_type` and `reference_id` were added by ALTER after the feature
   * shipped, so rows written before that carry only `expense_id`. Both
   * cleanup paths in the app resolve this as
   * `target_type || (expense_id ? 'expense' : null)` and
   * `reference_id || expense_id` — matched here by
   * `COALESCE(it.reference_id, it.expense_id)`.
   *
   * BELT AND BRACES — `medicine_entries`, `feed_entries`, `chick_entries` and
   * `vaccinations` also store the originating `bill_id`, and nothing but the internal-transfer
   * paths ever writes it. Those four are therefore excluded on EITHER the
   * reference-id match OR a `bill_id` pointing at an internal bill, so a row
   * whose `internal_transfers` record was lost (there are no transactions —
   * `cleanupInternalTransfers()` deletes the join rows and re-inserts, and a
   * crash between the two orphans them) is still eliminated. `expenses` has no
   * `bill_id` column, so it can only be matched through the join table.
   *
   * RETURNS — `sales-returns.component.ts` does not post reversing entries. It
   * deletes the cost rows, re-creates them at the reduced quantity, and edits
   * `bills.total_amount` in place. So the live rows already reflect all returns
   * and nothing extra needs subtracting on either side. The one wrinkle: the
   * rebuilt cost rows are dated `returnDate`, not the original bill date, so a
   * returned transfer's two sides can land in different periods — that is what
   * the balance warning above detects.
   */
  private internalBillIdsSql(): string {
    return `SELECT b.bill_id FROM bills b
            WHERE b.farm_id = ? AND COALESCE(b.payment_type, 'cash') = 'internal'
              AND ${distributionBillsOnly('b')}`;
  }

  /** Ids in `target_type`'s table that came from an internal transfer. Params: farmId, targetType. */
  private internalRefIdsSql(): string {
    return `SELECT COALESCE(it.reference_id, it.expense_id) AS ref_id
            FROM internal_transfers it
            JOIN bills b ON b.bill_id = it.bill_id
            WHERE b.farm_id = ? AND it.target_type = ?
              AND COALESCE(it.reference_id, it.expense_id) IS NOT NULL`;
  }

  /**
   * `expenses.expense_id` values that came from an internal transfer. Covers
   * both the legacy shape (expense_id only, target_type NULL) and the current
   * one (target_type = 'expense', reference_id set). Params: farmId, farmId.
   */
  private internalExpenseIdsSql(): string {
    return `SELECT it.expense_id AS ref_id
            FROM internal_transfers it
            JOIN bills b ON b.bill_id = it.bill_id
            WHERE b.farm_id = ? AND it.expense_id IS NOT NULL
            UNION
            SELECT it.reference_id AS ref_id
            FROM internal_transfers it
            JOIN bills b ON b.bill_id = it.bill_id
            WHERE b.farm_id = ? AND it.target_type = 'expense' AND it.reference_id IS NOT NULL`;
  }

  // ── Revenue queries ──────────────────────────────────────────────────────
  //
  // Revenue is taken from the sale tables themselves plus any income row that
  // is NOT a mirror of one. `sale.component.ts`, `egg-sales.component.ts` and
  // `hen-sales.component.ts` each upsert a copy of their sales into `income`
  // tagged source = 'sale' / 'egg_sale' / 'hen_sale'; counting both would
  // double the revenue. (`layer-report.component.ts` filters out 'egg_sale'
  // but not 'hen_sale', so its own summary double-counts hen sales. This
  // service excludes both.)

  private qBroilerSales(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT f.unit_id AS unit_id,
              COALESCE(SUM(s.total_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM sales s
       JOIN flocks f ON f.flock_id = s.flock_id
       WHERE f.farm_id = ? AND COALESCE(s.module_type,'broiler') = 'broiler'` +
      this.dateClause('s.date', range, params) +
      ` GROUP BY f.unit_id`;
    return [sql, params];
  }

  private qEggSales(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT b.unit_id AS unit_id,
              COALESCE(SUM(es.total_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM egg_sales es
       JOIN batches b ON b.batch_id = es.batch_id
       WHERE b.farm_id = ?` +
      this.dateClause('es.date', range, params) +
      ` GROUP BY b.unit_id`;
    return [sql, params];
  }

  private qHenSales(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT b.unit_id AS unit_id,
              COALESCE(SUM(hs.total_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM hen_sales hs
       JOIN batches b ON b.batch_id = hs.batch_id
       WHERE b.farm_id = ?` +
      this.dateClause('hs.date', range, params) +
      ` GROUP BY b.unit_id`;
    return [sql, params];
  }

  private qBroilerIncome(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT f.unit_id AS unit_id,
              COALESCE(SUM(i.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM income i
       JOIN flocks f ON f.flock_id = i.flock_id
       WHERE f.farm_id = ? AND COALESCE(i.module_type,'broiler') = 'broiler'
         AND COALESCE(i.source,'manual') <> 'sale'` +
      this.dateClause('i.date', range, params) +
      ` GROUP BY f.unit_id`;
    return [sql, params];
  }

  private qLayerIncome(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT b.unit_id AS unit_id,
              COALESCE(SUM(i.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM income i
       JOIN batches b ON b.batch_id = i.flock_id
       WHERE b.farm_id = ? AND i.module_type = 'layer'
         AND COALESCE(i.source,'manual') NOT IN ('egg_sale','hen_sale')` +
      this.dateClause('i.date', range, params) +
      ` GROUP BY b.unit_id`;
    return [sql, params];
  }

  /**
   * External distribution revenue, COLLECTED basis. Internal bills are dropped.
   *
   * Distribution is the one module that knows what it has actually been paid:
   * `bills.amount_paid` is maintained per bill, where broiler and layer have a
   * `payment_type` and no payment table at all. So while the rest of this file
   * counts revenue when the sale is recorded — the only basis those modules can
   * produce — distribution counts it when the money arrives, because it can, and
   * because an unpaid bill must never show up as profit.
   *
   * That is a deliberate mixed basis, and it is the conservative direction on
   * the only module where the choice exists: COGS for a credit sale is charged
   * as soon as the goods leave, so an uncollected bill pulls profit DOWN until
   * it is paid, and can never inflate it. The uncollected amount is reported
   * separately as `revenue.distributionUnpaid` so it stays visible.
   *
   * The clamp matches `getBillPaidAmount()` in distribution-report.component.ts
   * exactly — MIN/MAX with two arguments are SQLite's scalar forms, not the
   * aggregates — so both screens compute the same figure from the same rows.
   */
  private qDistributionBills(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(
                MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))
              ), 0) AS amount
       FROM bills bl
       WHERE bl.farm_id = ? AND COALESCE(bl.payment_type,'cash') <> 'internal'
         AND ${distributionBillsOnly('bl')}` +
      this.dateClause('bl.bill_date', range, params);
    return [sql, params];
  }

  /**
   * Collected revenue across EVERY bill, own-farm ones included — the same
   * basis `distribution-report.component.ts` uses for `totalPaidSales`
   * (`revenueBills` there is deliberately "all of them").
   *
   * This is for the Per-Farm Breakdown's Distribution row only. It is NOT
   * used in the headline `revenue` — the headline keeps eliminating internal
   * transfers via `qDistributionBills()` above. The Distribution row is a
   * per-business-unit view of the distribution business's own P&L, where an
   * own-farm bill is a real sale; see the comment on `buildPerFarm()`.
   */
  private qDistributionBillsAll(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(
                MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))
              ), 0) AS amount
       FROM bills bl
       WHERE bl.farm_id = ? AND ${distributionBillsOnly('bl')}` +
      this.dateClause('bl.bill_date', range, params);
    return [sql, params];
  }

  /**
   * Billed but not yet collected on external bills — reported, never added to
   * revenue or profit. Same clamp as above, so `billed = collected + unpaid`.
   *
   * Own-farm bills are excluded here as they are everywhere else in this file:
   * what one of the owner's farms owes his own shop is not money owed TO the
   * account. It is reported separately as
   * `internalTransfers.unsettledInternal`.
   */
  private qDistributionUnpaid(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(
                MAX(COALESCE(bl.total_amount, 0)
                    - MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0)), 0)
              ), 0) AS amount
       FROM bills bl
       WHERE bl.farm_id = ? AND COALESCE(bl.payment_type,'cash') <> 'internal'
         AND ${distributionBillsOnly('bl')}` +
      this.dateClause('bl.bill_date', range, params);
    return [sql, params];
  }

  /**
   * The revenue side that was eliminated — diagnostic only.
   *
   * `unsettled` is what the owner's own farms still owe on these bills, using
   * the same clamp as `qDistributionUnpaid()`. It is reported, never added to
   * anything: an intra-account debt is not the account's receivable.
   */
  private qInternalBills(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(bl.total_amount), 0) AS amount,
              COALESCE(SUM(
                MAX(COALESCE(bl.total_amount, 0)
                    - MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0)), 0)
              ), 0) AS unsettled,
              COUNT(*) AS row_count
       FROM bills bl
       WHERE bl.farm_id = ? AND COALESCE(bl.payment_type,'cash') = 'internal'
         AND ${distributionBillsOnly('bl')}` +
      this.dateClause('bl.bill_date', range, params);
    return [sql, params];
  }

  // ── Expense queries ──────────────────────────────────────────────────────

  private qExpenses(farmId: number, range: OverviewDateRange, module: 'broiler' | 'layer'): [string, any[]] {
    const layer = module === 'layer';
    // Shared table: flock_id holds a batch_id when module_type = 'layer'.
    const join = layer
      ? 'JOIN batches u ON u.batch_id = e.flock_id'
      : 'JOIN flocks u ON u.flock_id = e.flock_id';
    const moduleWhere = layer
      ? `e.module_type = 'layer'`
      : `COALESCE(e.module_type,'broiler') = 'broiler'`;

    const params: any[] = [farmId, farmId, farmId];
    const sql =
      `SELECT u.unit_id AS unit_id,
              COALESCE(SUM(e.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM expenses e
       ${join}
       WHERE u.farm_id = ? AND ${moduleWhere}
         AND e.expense_id NOT IN (${this.internalExpenseIdsSql()})` +
      this.dateClause('e.date', range, params) +
      ` GROUP BY u.unit_id`;
    return [sql, params];
  }

  /**
   * medicine_entries / feed_entries / chick_entries share a shape, so share a
   * builder. `kind` is both the table prefix and the `internal_transfers`
   * `target_type` the elimination matches on, which is why the three strings
   * have to stay in step with the branches in sales-orders.component.ts.
   */
  private qTraderEntries(
    farmId: number,
    range: OverviewDateRange,
    module: 'broiler' | 'layer',
    kind: 'medicine' | 'feed' | 'chick'
  ): [string, any[]] {
    const layer = module === 'layer';
    const table = `${kind}_entries`;
    const join = layer
      ? 'JOIN batches u ON u.batch_id = t.flock_id'
      : 'JOIN flocks u ON u.flock_id = t.flock_id';
    const moduleWhere = layer
      ? `t.module_type = 'layer'`
      : `COALESCE(t.module_type,'broiler') = 'broiler'`;

    const params: any[] = [farmId, farmId, kind, farmId];
    const sql =
      `SELECT u.unit_id AS unit_id,
              COALESCE(SUM(t.total_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM ${table} t
       ${join}
       WHERE u.farm_id = ? AND ${moduleWhere}
         AND t.entry_id NOT IN (${this.internalRefIdsSql()})
         AND COALESCE(t.bill_id, 0) NOT IN (${this.internalBillIdsSql()})` +
      this.dateClause('t.date', range, params) +
      ` GROUP BY u.unit_id`;
    return [sql, params];
  }

  /**
   * `vaccinations` serves both modules off two nullable columns. A row that
   * somehow carries both is attributed to layer only, so it cannot be counted
   * twice.
   */
  private qVaccinations(farmId: number, range: OverviewDateRange, module: 'broiler' | 'layer'): [string, any[]] {
    const layer = module === 'layer';
    const join = layer
      ? 'JOIN batches u ON u.batch_id = v.batch_id'
      : 'JOIN flocks u ON u.flock_id = v.flock_id';
    const moduleWhere = layer ? 'v.batch_id IS NOT NULL' : 'v.batch_id IS NULL AND v.flock_id IS NOT NULL';

    const params: any[] = [farmId, farmId, 'vaccination', farmId];
    const sql =
      `SELECT u.unit_id AS unit_id,
              COALESCE(SUM(v.cost), 0) AS amount,
              COUNT(*) AS row_count
       FROM vaccinations v
       ${join}
       WHERE u.farm_id = ? AND ${moduleWhere}
         AND v.vaccination_id NOT IN (${this.internalRefIdsSql()})
         AND COALESCE(v.bill_id, 0) NOT IN (${this.internalBillIdsSql()})` +
      this.dateClause('v.date', range, params) +
      ` GROUP BY u.unit_id`;
    return [sql, params];
  }

  private qLabour(farmId: number, range: OverviewDateRange, module: 'broiler' | 'layer'): [string, any[]] {
    const layer = module === 'layer';
    const join = layer
      ? 'JOIN batches u ON u.batch_id = lp.flock_id'
      : 'JOIN flocks u ON u.flock_id = lp.flock_id';
    const moduleWhere = layer
      ? `lp.module_type = 'layer'`
      : `COALESCE(lp.module_type,'broiler') = 'broiler'`;

    const params: any[] = [farmId];
    const sql =
      `SELECT u.unit_id AS unit_id,
              COALESCE(SUM(lp.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM labour_payments lp
       ${join}
       WHERE u.farm_id = ? AND ${moduleWhere}` +
      this.dateClause('lp.date', range, params) +
      ` GROUP BY u.unit_id`;
    return [sql, params];
  }

  /**
   * Broiler side — `ledgers` hang off `flocks`. Every debit entered on the
   * Ledger screen, which since the separation is every debit there is: expenses
   * and ledgers are independent books, an expense writes no ledger row, and the
   * one-time migration deleted the mirrors already written. Strictly disjoint
   * from `general`, and the two together are the same total cost as before.
   *
   * The `<> 'expense'` guard stays anyway. It is a no-op on a migrated database,
   * and on one whose migration has not landed (retrying after a failure, or a
   * pre-change backup) it is the only thing between us and counting every legacy
   * expense twice. Same guard, same reason, in `report.component.ts` and
   * `farm-report.service.ts`.
   */
  private qLedgerDebits(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT f.unit_id AS unit_id,
              COALESCE(SUM(le.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM ledger_entries le
       JOIN flocks f ON f.flock_id = le.flock_id
       WHERE f.farm_id = ? AND le.type = 'debit'
         AND COALESCE(le.source,'manual') <> 'expense'` +
      this.dateClause('le.date', range, params) +
      ` GROUP BY f.unit_id`;
    return [sql, params];
  }

  /**
   * Layer side — `layer_ledgers` hang off `batches`, and this is the mirror image
   * of `qLedgerDebits()` above: every debit entered on the layer Ledger screen.
   *
   * No `module_type` guard and no `source` guard, and neither is an oversight.
   * The layer ledger is its OWN pair of tables keyed on batch_id (the same choice
   * `layer_health` makes beside `flock_health`), so the flock/batch id collision
   * cannot reach it: a row here is never a broiler flock's row, whatever the id.
   * And nothing auto-files into it — the layer Expenses screen writes `expenses`
   * and nothing else — so there is no mirror kind of row to exclude the way
   * `ledger_entries.source = 'expense'` once had to be.
   *
   * Strictly disjoint from `general`: an `expenses` row and a
   * `layer_ledger_entries` row are rows in different tables, so the two books
   * partition the layer module's costs with nothing counted twice.
   */
  private qLayerLedgerDebits(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT b.unit_id AS unit_id,
              COALESCE(SUM(le.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM layer_ledger_entries le
       JOIN batches b ON b.batch_id = le.batch_id
       WHERE b.farm_id = ? AND le.type = 'debit'` +
      this.dateClause('le.date', range, params) +
      ` GROUP BY b.unit_id`;
    return [sql, params];
  }

  /**
   * Fallback purchase rate per product, as a CTE body. Consumes ONE `?` (farm_id).
   *
   * `products.cost_price` alone is not dependable: `inventory.component.ts` is
   * the only writer, so it is whatever was last typed by hand and purchase
   * orders never refresh it. The chain falls through to the weighted-average
   * rate across that product's purchase orders, then to its most recent batch
   * that carries a price. Products that come up empty on all three rate 0, and
   * whatever they cost is reported as uncosted rather than buried.
   */
  private productRateCte(): string {
    return `SELECT p.product_id AS product_id,
                   COALESCE(
                     NULLIF(p.cost_price, 0),
                     NULLIF((SELECT CASE WHEN COALESCE(SUM(po.quantity), 0) > 0
                                         THEN SUM(po.total_amount) / SUM(po.quantity)
                                         ELSE 0 END
                             FROM purchase_orders po
                             WHERE po.product_id = p.product_id AND po.farm_id = p.farm_id), 0),
                     NULLIF((SELECT pb.purchase_price
                             FROM product_batches pb
                             WHERE pb.product_id = p.product_id AND pb.farm_id = p.farm_id
                               AND COALESCE(pb.purchase_price, 0) > 0
                             ORDER BY pb.batch_id DESC LIMIT 1), 0),
                     0) AS unit_cost
            FROM products p
            WHERE p.farm_id = ?`;
  }

  /**
   * COST OF GOODS SOLD for the distribution module — the purchase cost of the
   * stock that actually left on the period's bills.
   *
   * `sales-orders.component.ts` deducts stock oldest-expiry-first and writes one
   * `batch_transactions` row per batch it draws from (`type = 'sale'`,
   * `reference_id = bills.bill_id`); the rate is `purchase_price` on the batch
   * that row points at. Stock coming back is `type = 'return'` and is netted
   * off, otherwise an edited bill charges its goods twice — a bill edit posts a
   * `return` and then re-deducts a fresh `sale`.
   *
   * `return` rows overload `reference_id`: `restoreBillStock()` puts a
   * `bills.bill_id` there, `restoreReturnedStock()` puts a
   * `sales_returns.return_id`. Both id spaces start at 1, so the join also
   * requires the note to start with that return's `return_number` — which the
   * sales-return path always writes and the bill-edit path ("Restored from
   * deleted/edited sale") never does.
   *
   * The `' - '` in that LIKE pattern is load-bearing, not cosmetic. Matching on
   * `return_number || '%'` made RET-100 match the notes of RET-1000, RET-1001,
   * … as well as its own, so from the 100th return onwards a single return row
   * could join several transactions and net the same goods off more than once.
   * `restoreReturnedStock()` writes the note as `${return_number} - Bill ...`,
   * so requiring the separator pins the match to the whole number. Keep the two
   * in step: change the note format and this pattern changes with it.
   *
   * `type = 'purchase'` and `type = 'adjustment'` are excluded deliberately:
   * adjustments are stock leaving for a purchase edit, a purchase return or a
   * batch deletion. None of it sold, so none of it is a cost of sales.
   *
   * Sales returns need no further handling — `sales-returns.component.ts`
   * rewrites `bills.total_amount` in place as well as posting the `return`
   * rows, so both revenue and cost already net out.
   *
   * Units on `bill_items` that no priced batch draw covers — bills predating
   * the batch module, batches saved with `purchase_price = 0`, or a FIFO walk
   * that ran out of stock — are re-priced at `productRateCte()`'s fallback
   * rather than left at zero, which would overstate profit. Whatever is still
   * uncosted after that is returned as `uncosted_qty` and warned about.
   *
   * Internal bills are INCLUDED here, even though `qDistributionBills()` drops
   * them from revenue. Goods transferred to a flock or batch were genuinely
   * consumed by the business; `eliminateInternalRows()` removes the mirrored
   * broiler/layer cost row (which stands at the bill's selling price), so the
   * purchase cost has to remain or the transfer would cost the account nothing.
   *
   * Batch draws against a bill with no surviving `bill_items` line are not
   * picked up. A fully returned bill nets to roughly zero anyway, so the
   * omission is immaterial and this stays a single grouped query.
   */
  private qDistributionCogs(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId, farmId, farmId, farmId, farmId];
    const sql =
      `WITH tx AS (
         SELECT bt.reference_id AS bill_id,
                bt.product_id   AS product_id,
                bt.quantity     AS net_qty,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN bt.quantity * pb.purchase_price ELSE 0 END AS priced_cost,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN 0 ELSE bt.quantity END AS unpriced_qty
         FROM batch_transactions bt
         JOIN product_batches pb ON pb.batch_id = bt.batch_id
         WHERE pb.farm_id = ? AND bt.type = 'sale' AND bt.reference_id IS NOT NULL

         UNION ALL

         SELECT COALESCE(sr.bill_id, bt.reference_id) AS bill_id,
                bt.product_id   AS product_id,
                -bt.quantity    AS net_qty,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN -(bt.quantity * pb.purchase_price) ELSE 0 END AS priced_cost,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN 0 ELSE -bt.quantity END AS unpriced_qty
         FROM batch_transactions bt
         JOIN product_batches pb ON pb.batch_id = bt.batch_id
         LEFT JOIN sales_returns sr
                ON sr.return_id = bt.reference_id
               AND sr.farm_id = ?
               AND bt.notes LIKE sr.return_number || ' - %'
         WHERE pb.farm_id = ? AND bt.type = 'return' AND bt.reference_id IS NOT NULL
       ),
       drawn AS (
         SELECT bill_id, product_id,
                SUM(net_qty)      AS net_qty,
                SUM(priced_cost)  AS priced_cost,
                SUM(unpriced_qty) AS unpriced_qty
         FROM tx
         GROUP BY bill_id, product_id
       ),
       rate AS (
         ${this.productRateCte()}
       ),
       sold AS (
         SELECT bi.bill_id AS bill_id, bi.product_id AS product_id,
                COALESCE(SUM(bi.quantity), 0) AS qty
         FROM bill_items bi
         JOIN bills b ON b.bill_id = bi.bill_id
         WHERE b.farm_id = ?` + this.dateClause('b.bill_date', range, params) + `
         GROUP BY bi.bill_id, bi.product_id
       )
       SELECT COALESCE(SUM(
                COALESCE(d.priced_cost, 0)
                + (MAX(COALESCE(d.unpriced_qty, 0), 0)
                   + MAX(s.qty - COALESCE(d.net_qty, 0), 0)) * COALESCE(r.unit_cost, 0)
              ), 0) AS amount,
              COALESCE(SUM(
                CASE WHEN COALESCE(r.unit_cost, 0) > 0 THEN 0
                     ELSE MAX(COALESCE(d.unpriced_qty, 0), 0)
                          + MAX(s.qty - COALESCE(d.net_qty, 0), 0) END
              ), 0) AS uncosted_qty,
              COUNT(*) AS row_count
       FROM sold s
       LEFT JOIN drawn d
              ON d.bill_id = s.bill_id
             AND (d.product_id = s.product_id
                  OR (d.product_id IS NULL AND s.product_id IS NULL))
       LEFT JOIN rate r ON r.product_id = s.product_id`;
    return [sql, params];
  }

  /**
   * Distribution stock on hand, valued at what it cost to buy — the asset the
   * purchases turned into, and the reason a large purchase figure is not a loss.
   *
   * Same stock filter `DatabaseService.getTotalStock()` applies (quantity left,
   * not past expiry) so value and quantity describe the same stock. Batches with
   * no recorded price fall back to `productRateCte()`, matching how
   * `qDistributionCogs()` prices the same units.
   *
   * `range` is ignored: `product_batches` carries a live quantity and no
   * movement history to rewind, so this can only ever be "as at now".
   */
  private qInventoryOnHand(farmId: number): [string, any[]] {
    const params: any[] = [farmId, farmId];
    const sql =
      `WITH rate AS (
         ${this.productRateCte()}
       )
       SELECT COALESCE(SUM(CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                                THEN pb.quantity * pb.purchase_price
                                ELSE pb.quantity * COALESCE(r.unit_cost, 0) END), 0) AS amount,
              COALESCE(SUM(CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                                THEN 0 ELSE pb.quantity END), 0) AS unpriced_qty,
              COUNT(*) AS row_count
       FROM product_batches pb
       LEFT JOIN rate r ON r.product_id = pb.product_id
       WHERE pb.farm_id = ? AND pb.quantity > 0 AND pb.expiry_date >= date('now')`;
    return [sql, params];
  }

  private qPurchases(farmId: number, range: OverviewDateRange): [string, any[]] {

    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(po.total_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM purchase_orders po
       WHERE po.farm_id = ?` +
      this.dateClause('po.date', range, params);
    return [sql, params];
  }

  private qPurchaseReturns(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(pr.return_amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM purchase_returns pr
       WHERE pr.farm_id = ?` +
      this.dateClause('pr.return_date', range, params);
    return [sql, params];
  }

  private qDistributionExpenses(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(el.amount), 0) AS amount,
              COUNT(*) AS row_count
       FROM expense_ledger el
       WHERE el.farm_id = ?` +
      this.dateClause('el.transaction_date', range, params);
    return [sql, params];
  }

  /**
   * The broiler/layer cost rows that were eliminated — diagnostic only, so the
   * dashboard can show what cancelled and the balance check above has both
   * sides to compare.
   */
  private qInternalExpenseSide(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [];

    const expensesParams: any[] = [farmId, farmId];
    const expensesSql =
      `SELECT e.amount AS amt FROM expenses e
       WHERE e.expense_id IN (${this.internalExpenseIdsSql()})` +
      this.dateClause('e.date', range, expensesParams);

    const medicineParams: any[] = [farmId, 'medicine', farmId];
    const medicineSql =
      `SELECT me.total_amount AS amt FROM medicine_entries me
       WHERE (me.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(me.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('me.date', range, medicineParams);

    const feedParams: any[] = [farmId, 'feed', farmId];
    const feedSql =
      `SELECT fe.total_amount AS amt FROM feed_entries fe
       WHERE (fe.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(fe.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('fe.date', range, feedParams);

    const chickParams: any[] = [farmId, 'chick', farmId];
    const chickSql =
      `SELECT ce.total_amount AS amt FROM chick_entries ce
       WHERE (ce.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(ce.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('ce.date', range, chickParams);

    const vaccParams: any[] = [farmId, 'vaccination', farmId];
    const vaccSql =
      `SELECT v.cost AS amt FROM vaccinations v
       WHERE (v.vaccination_id IN (${this.internalRefIdsSql()})
              OR COALESCE(v.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('v.date', range, vaccParams);

    params.push(...expensesParams, ...medicineParams, ...feedParams, ...chickParams, ...vaccParams);

    const sql =
      `SELECT COALESCE(SUM(amt), 0) AS amount, COUNT(*) AS row_count
       FROM (
         ${expensesSql}
         UNION ALL
         ${medicineSql}
         UNION ALL
         ${feedSql}
         UNION ALL
         ${chickSql}
         UNION ALL
         ${vaccSql}
       )`;
    return [sql, params];
  }

  /**
   * The internal-transfer cost rows `qExpenses()`/`qTraderEntries()`/
   * `qVaccinations()` exclude from the headline, grouped by unit instead of
   * summed to one figure — the mirror image of `qInternalExpenseSide()`.
   *
   * For the Per-Farm Breakdown only. A farm genuinely incurred this cost —
   * it bought feed/medicine/chicks/a vaccination/an expense-item from the
   * distribution business — so its row should show it even though the
   * headline total must not (that is exactly what the elimination cancels
   * against the Distribution row's COGS). Labour has no internal-transfer
   * target_type, so there is nothing to add back there.
   */
  private qInternalCostByUnit(farmId: number, range: OverviewDateRange, module: 'broiler' | 'layer'): [string, any[]] {
    const layer = module === 'layer';
    const unitTable = layer ? 'batches' : 'flocks';
    const unitKey = layer ? 'batch_id' : 'flock_id';
    const mw = (col: string) => layer ? `${col} = 'layer'` : `COALESCE(${col},'broiler') = 'broiler'`;

    const expParams: any[] = [farmId, farmId, farmId];
    const expSql =
      `SELECT u.unit_id AS unit_id, e.amount AS amt
       FROM expenses e
       JOIN ${unitTable} u ON u.${unitKey} = e.flock_id
       WHERE u.farm_id = ? AND ${mw('e.module_type')}
         AND e.expense_id IN (${this.internalExpenseIdsSql()})` +
      this.dateClause('e.date', range, expParams);

    const medParams: any[] = [farmId, farmId, 'medicine', farmId];
    const medSql =
      `SELECT u.unit_id AS unit_id, me.total_amount AS amt
       FROM medicine_entries me
       JOIN ${unitTable} u ON u.${unitKey} = me.flock_id
       WHERE u.farm_id = ? AND ${mw('me.module_type')}
         AND (me.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(me.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('me.date', range, medParams);

    const feedParams: any[] = [farmId, farmId, 'feed', farmId];
    const feedSql =
      `SELECT u.unit_id AS unit_id, fe.total_amount AS amt
       FROM feed_entries fe
       JOIN ${unitTable} u ON u.${unitKey} = fe.flock_id
       WHERE u.farm_id = ? AND ${mw('fe.module_type')}
         AND (fe.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(fe.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('fe.date', range, feedParams);

    const chickParams: any[] = [farmId, farmId, 'chick', farmId];
    const chickSql =
      `SELECT u.unit_id AS unit_id, ce.total_amount AS amt
       FROM chick_entries ce
       JOIN ${unitTable} u ON u.${unitKey} = ce.flock_id
       WHERE u.farm_id = ? AND ${mw('ce.module_type')}
         AND (ce.entry_id IN (${this.internalRefIdsSql()})
              OR COALESCE(ce.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('ce.date', range, chickParams);

    const vaccJoinCol = layer ? 'batch_id' : 'flock_id';
    const vaccModuleWhere = layer ? 'v.batch_id IS NOT NULL' : 'v.batch_id IS NULL AND v.flock_id IS NOT NULL';
    const vaccParams: any[] = [farmId, farmId, 'vaccination', farmId];
    const vaccSql =
      `SELECT u.unit_id AS unit_id, v.cost AS amt
       FROM vaccinations v
       JOIN ${unitTable} u ON u.${unitKey} = v.${vaccJoinCol}
       WHERE u.farm_id = ? AND ${vaccModuleWhere}
         AND (v.vaccination_id IN (${this.internalRefIdsSql()})
              OR COALESCE(v.bill_id, 0) IN (${this.internalBillIdsSql()}))` +
      this.dateClause('v.date', range, vaccParams);

    const params = [...expParams, ...medParams, ...feedParams, ...chickParams, ...vaccParams];
    const sql =
      `SELECT unit_id, COALESCE(SUM(amt), 0) AS amount, COUNT(*) AS row_count
       FROM (
         ${expSql}
         UNION ALL
         ${medSql}
         UNION ALL
         ${feedSql}
         UNION ALL
         ${chickSql}
         UNION ALL
         ${vaccSql}
       )
       GROUP BY unit_id`;
    return [sql, params];
  }

  // ── Asset / personal queries ─────────────────────────────────────────────

  /** Money in from asset sales — the full sale price, not the gain over cost. */
  private qAssetSales(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(COALESCE(a.sale_amount,0)), 0) AS amount
       FROM assets a
       WHERE a.farm_id = ? AND COALESCE(a.status,'active') = 'sold'` +
      this.dateClause('a.sale_date', range, params);
    return [sql, params];
  }

  /**
   * Assets still held, at their full agreed price. This is a stock, not a
   * flow, so only the upper bound of the range applies — "what was owned as
   * at range.to".
   */
  private qAssetsActive(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(COALESCE(a.total_price, a.purchase_amount, 0)), 0) AS amount
       FROM assets a
       WHERE a.farm_id = ? AND COALESCE(a.status,'active') = 'active'` +
      this.dateClause('a.purchase_date', { to: range.to }, params);
    return [sql, params];
  }

  /**
   * Money out for asset installments actually paid in the period.
   *
   * This used to charge an asset's whole price to the purchase date. That was
   * right when assets were bought outright and wrong now that they are paid off
   * over time: the money leaves as each installment is handed over. Legacy
   * assets come out unchanged either way, because the installments migration
   * seeded each one a payment for its full amount dated on its purchase date.
   */
  private qAssetPayments(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(p.amount), 0) AS amount
       FROM asset_payments p
       WHERE p.farm_id = ?` +
      this.dateClause('p.date', range, params);
    return [sql, params];
  }

  /**
   * What is still owed on assets, as at range.to. A stock, not a flow, so only
   * the upper bound applies — both to which assets existed and to which
   * payments had been made by then.
   *
   * Assets that are square or overpaid are excluded rather than netted off, so
   * one overpaid asset cannot mask another's debt.
   */
  private qAssetOutstanding(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [];
    const paidParams: any[] = [];
    const paidClause = this.dateClause('p.date', { to: range.to }, paidParams);
    params.push(...paidParams, farmId);

    const assetParams: any[] = [];
    const assetClause = this.dateClause('a.purchase_date', { to: range.to }, assetParams);
    params.push(...assetParams);

    const sql =
      `SELECT COALESCE(SUM(owed), 0) AS amount
       FROM (
         SELECT COALESCE(a.total_price, a.purchase_amount, 0)
                - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                            WHERE p.asset_id = a.asset_id${paidClause}), 0) AS owed
         FROM assets a
         WHERE a.farm_id = ?${assetClause}
       )
       WHERE owed > 0`;
    return [sql, params];
  }

  /**
   * Bottom-of-dashboard asset totals: everything owned, what has been paid,
   * what has been sold for, and realised profit/loss on the sold ones. Same
   * "as at range.to" stock semantics as qAssetsActive()/qAssetOutstanding()
   * above — an asset (or sale, or payment) dated after range.to has not
   * happened yet as at that date, so it is excluded rather than counted early.
   *
   * A sold asset with no agreed price on file cannot contribute to profitLoss
   * (there is nothing to measure the sale against) — it is counted in
   * excludedFromProfitLoss instead of silently reading as a zero gain.
   */
  private qAssetTotals(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [];
    const assetParams: any[] = [];
    const assetClause = this.dateClause('a.purchase_date', { to: range.to }, assetParams);
    params.push(...assetParams, farmId);

    const paidParams: any[] = [];
    const paidClause = this.dateClause('date', { to: range.to }, paidParams);

    const soldParams: any[] = [];
    const soldClause = this.dateClause('a.sale_date', { to: range.to }, soldParams);

    const sql =
      `SELECT
         COUNT(*) AS asset_count,
         COALESCE(SUM(COALESCE(a.total_price, NULLIF(a.purchase_amount, 0), 0)), 0) AS total_purchase_value,
         (SELECT COALESCE(SUM(amount), 0) FROM asset_payments WHERE farm_id = ?${paidClause}) AS total_paid,
         COALESCE(SUM(CASE WHEN COALESCE(a.status,'active') = 'sold'${soldClause}
                            THEN COALESCE(a.sale_amount, 0) ELSE 0 END), 0) AS total_sold_for,
         COALESCE(SUM(CASE WHEN COALESCE(a.status,'active') = 'sold'${soldClause}
                            AND COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) IS NOT NULL
                            THEN COALESCE(a.sale_amount, 0) - COALESCE(a.total_price, NULLIF(a.purchase_amount, 0))
                            ELSE 0 END), 0) AS profit_loss,
         COALESCE(SUM(CASE WHEN COALESCE(a.status,'active') = 'sold'${soldClause}
                            AND COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) IS NULL
                            THEN 1 ELSE 0 END), 0) AS excluded_count
       FROM assets a
       WHERE a.farm_id = ?${assetClause}`;
    // total_paid's subquery param comes first in the SQL text.
    return [sql, [farmId, ...paidParams, ...soldParams, ...soldParams, ...soldParams, farmId, ...assetParams]];
  }

  /**
   * Owner's drawings. Not a business expense — it is its own line under
   * money out, alongside expenses and asset payments.
   */
  private qPersonalExpenses(farmId: number, range: OverviewDateRange): [string, any[]] {
    const params: any[] = [farmId];
    const sql =
      `SELECT COALESCE(SUM(pe.amount), 0) AS amount
       FROM personal_expenses pe
       WHERE pe.farm_id = ?` +
      this.dateClause('pe.date', range, params);
    return [sql, params];
  }

  /**
   * Distribution's own carried-forward opening balance. Distribution is one
   * business per account, not several — there is no farm_units row to hang
   * this on, so it lives in `app_settings` (key `distribution_opening_balance`)
   * instead, the same generic per-account key/value store that already holds
   * the delete-code PIN. A missing row (nothing saved yet) or a row whose
   * `value` is NULL both come back as an empty/`null` value here and are
   * treated as 0 by `num()`, the same as a NULL `farm_units.opening_balance`.
   */
  private qDistributionOpeningBalance(farmId: number): [string, any[]] {
    const sql = `SELECT value FROM app_settings WHERE farm_id = ? AND key = 'distribution_opening_balance'`;
    return [sql, [farmId]];
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  private async loadUnits(farmId: number, warnings: string[]): Promise<any[]> {
    const res = await this.db.get(
      `SELECT unit_id, unit_name, module_type, opening_balance FROM farm_units
       WHERE farm_id = ? ORDER BY module_type ASC, unit_name ASC`,
      [farmId]
    );
    if (!res?.success) {
      warnings.push('Could not load farms: ' + friendlySqlError(res?.error, 'unknown error'));
      return [];
    }
    return res.data || [];
  }

  // ── Per-farm assembly ────────────────────────────────────────────────────

  /**
   * Profit per `farm_units` row. Flocks and batches with no `unit_id` — every
   * record created before step 4 added the column — fall into an "Unassigned"
   * bucket per module rather than being dropped. Distribution is farm-level
   * with no unit at all, so it gets its own row.
   *
   * This is a per-business-unit view, so unlike the headline it does NOT
   * eliminate internal transfers: `parts.broilerExpenses`/`layerExpenses`
   * include `qInternalCostByUnit()` on top of the headline-eliminated
   * figures (a farm genuinely bought that feed/medicine from distribution),
   * and `distributionRevenue` here is the ALL-bills collected figure
   * (`qDistributionBillsAll()`, own-farm sales included — distribution
   * really did sell it), matching what `distribution-report.component.ts`
   * shows for that business. Each side of an internal transfer lands on its
   * real row instead of cancelling out, so these rows will NOT sum to the
   * headline Profit/Loss — the caption under the table says so.
   */
  private buildPerFarm(
    units: any[],
    parts: {
      broilerRevenue: UnitRow[][];
      layerRevenue: UnitRow[][];
      broilerExpenses: UnitRow[][];
      layerExpenses: UnitRow[][];
    },
    distributionRevenue: number,
    distributionExpenses: number,
    distributionOpeningBalance: number
  ): OverviewFarmProfit[] {
    const buckets = new Map<string, OverviewFarmProfit>();

    const key = (module: ModuleKey, unitId: number | null) => `${module}:${unitId ?? 'none'}`;

    const bucket = (module: ModuleKey, unitId: number | null): OverviewFarmProfit => {
      const k = key(module, unitId);
      let b = buckets.get(k);
      if (!b) {
        const unit = unitId != null ? units.find(u => u.unit_id === unitId) : null;
        b = {
          unitId,
          unitName: unit?.unit_name || (unitId != null ? `Farm #${unitId}` : 'Unassigned'),
          moduleType: module,
          revenue: 0,
          expenses: 0,
          profit: 0,
          openingBalance: this.num(unit?.opening_balance)
        };
        buckets.set(k, b);
      }
      return b;
    };

    // Seed every known unit so a farm with no activity still shows as zero
    // rather than silently vanishing from the dashboard.
    for (const u of units) {
      const module: ModuleKey = u.module_type === 'layer' ? 'layer' : 'broiler';
      bucket(module, u.unit_id);
    }

    const apply = (groups: UnitRow[][], module: ModuleKey, field: 'revenue' | 'expenses') => {
      for (const rows of groups) {
        for (const row of rows) {
          bucket(module, row.unitId)[field] += row.amount;
        }
      }
    };

    apply(parts.broilerRevenue, 'broiler', 'revenue');
    apply(parts.layerRevenue, 'layer', 'revenue');
    apply(parts.broilerExpenses, 'broiler', 'expenses');
    apply(parts.layerExpenses, 'layer', 'expenses');

    if (distributionRevenue !== 0 || distributionExpenses !== 0 || distributionOpeningBalance !== 0) {
      const dist = bucket('distribution', null);
      dist.unitName = 'Distribution';
      dist.revenue += distributionRevenue;
      dist.expenses += distributionExpenses;
      // Not accumulated like revenue/expenses — this bucket is created once,
      // so a plain assignment is exactly "counted once", matching how every
      // farm_units row's own opening_balance is assigned at bucket() above.
      dist.openingBalance = distributionOpeningBalance;
    }

    const out = Array.from(buckets.values());
    for (const b of out) b.profit = b.revenue - b.expenses;

    return out.sort((a, b) => b.profit - a.profit);
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  /**
   * Appends the range predicates and pushes their params. `column` is always a
   * literal from this file — never user input — so interpolating it is safe;
   * the bounds themselves go in as `?` params.
   */
  private dateClause(column: string, range: OverviewDateRange, params: any[]): string {
    let sql = '';
    if (range.from) { sql += ` AND ${column} >= ?`; params.push(range.from); }
    if (range.to) { sql += ` AND ${column} <= ?`; params.push(range.to); }
    return sql;
  }

  /** Runs a grouped query. `db.get()` reports failure in `.success`, it does not throw. */
  private async unitRows([sql, params]: [string, any[]], warnings: string[]): Promise<UnitRow[]> {
    const res = await this.db.get(sql, params);
    if (!res?.success) {
      warnings.push('Consolidation query failed: ' + friendlySqlError(res?.error, 'unknown error'));
      return [];
    }
    return (res.data || []).map((r: any) => ({
      unitId: r.unit_id ?? null,
      amount: this.num(r.amount),
      rowCount: this.num(r.row_count)
    }));
  }

  /** Runs an ungrouped aggregate and returns its single row (empty on failure). */
  private async scalarRow([sql, params]: [string, any[]], warnings: string[]): Promise<Record<string, any>> {
    const res = await this.db.get(sql, params);
    if (!res?.success) {
      warnings.push('Consolidation query failed: ' + friendlySqlError(res?.error, 'unknown error'));
      return {};
    }
    return (res.data && res.data[0]) || {};
  }

  private sum(rows: UnitRow[]): number {
    return rows.reduce((s, r) => s + r.amount, 0);
  }

  private num(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private emptySummary(range: OverviewDateRange, warnings: string[]): OverviewSummary {
    return {
      range,
      revenue: { total: 0, broiler: 0, layer: 0, distribution: 0, distributionUnpaid: 0 },
      expenses: {
        total: 0, general: 0, medicine: 0, feed: 0, chicks: 0, vaccination: 0, labour: 0,
        ledgerDebits: 0, costOfGoodsSold: 0, purchases: 0, purchaseReturns: 0,
        distributionExpenses: 0,
        byModule: { broiler: 0, layer: 0, distribution: 0 }
      },
      inventory: { value: 0, unpricedUnits: 0 },
      moneyIn: { total: 0, revenue: 0, assetSales: 0 },
      moneyOut: { total: 0, expenses: 0, personal: 0, assetPayments: 0 },
      profit: 0,
      openingBalance: 0,
      profitWithOpeningBalance: 0,
      assets: {
        activeValue: 0, outstanding: 0,
        totals: { count: 0, purchaseValue: 0, paid: 0, soldFor: 0, profitLoss: 0, excludedFromProfitLoss: 0 }
      },
      perFarm: [],
      internalTransfers: {
        billCount: 0, revenueExcluded: 0, expenseExcluded: 0, expenseRowCount: 0,
        unsettledInternal: 0
      },
      warnings
    };
  }
}
