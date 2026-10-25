import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';

/**
 * CASH IN HAND and TOTAL BANK BALANCE — the two halves of where the account's
 * money is sitting right now.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONE SERVICE AND NOT THREE GETTERS
 * ─────────────────────────────────────────────────────────────────────────
 * Three screens print these figures — the Overview dashboard, the Farm Report
 * and the Distribution Report — and the client reconciles them against the
 * notes in the drawer. Two screens disagreeing about how much cash he has is
 * worse than neither showing it, which is the same reasoning that keeps
 * `customerSettlementOps()` and `totalCustomerOutstanding` single-sourced. So
 * the definition lives here once and every screen reads it; there is
 * deliberately no second query anywhere that computes either figure another
 * way.
 *
 * BOTH FIGURES ARE BALANCES AT A POINT IN TIME, not flows across a period.
 * By default that point is TODAY and no date filtering happens at all — the
 * same choice the Distribution Report's two outstanding cards make, and they
 * sit beside those.
 *
 * AS OF A DATE. `getCashPosition(farmId, asOf)` moves that point backwards:
 * every movement dated ON OR BEFORE `asOf` counts and nothing after it does.
 * The Farm Report prints its footer that way, so "as of 31-03-2026 you had
 * Rs. X in cash" is answerable without the client mentally undoing six months
 * of later transactions.
 *
 * `asOf` IS A RANGE-TO FILTER AND NOTHING ELSE. There is deliberately no
 * `from` — a balance is a stock, so it is everything up to a date, never a
 * slice between two. Passing the Farm Report's `dateFrom` here would report
 * the cash *generated in* the period, which is a different (and much smaller)
 * number than the cash the client has.
 *
 * Mechanically it is ONE optional parameter bound into the one statement:
 * every term carries `<its own date column> <= COALESCE(?, '9999-12-31')`, so
 * the SQL text and the parameter list are IDENTICAL whether or not a date is
 * given and a NULL simply lets everything through. The undated figure is
 * therefore byte-identically the one this service always returned.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TOTAL BANK BALANCE
 * ─────────────────────────────────────────────────────────────────────────
 * `SUM(bank_accounts.current_balance)` over the owner's own HOUSE accounts —
 * `customer_id IS NULL`, the split documented on `bank_accounts.customer_id`.
 * That is exactly the figure Overview > Bank lists, so the card and that
 * screen cannot disagree. A customer's deposit account is somebody else's
 * money held on their behalf and is not part of what the owner has.
 *
 * `current_balance` is a cache, but it is the cache the whole app treats as
 * the balance, rebuilt by `rebuildBankBalanceOp()` on every movement and
 * asserted to equal `SUM(debit - credit)` over its own ledger by
 * `verify_bank_withdrawals.js`. Reading the ledger instead here would be a
 * second definition of a bank balance, which is the thing to avoid.
 *
 * WITH AN `asOf` THERE IS NO CACHE TO READ — `current_balance` only ever
 * describes now — so the dated call sums the account's OWN LEDGER up to that
 * date, `SUM(debit - credit)` over `bank_ledger`. That is not a second
 * definition: it is the SAME definition, the one `bankBalanceSql()` writes
 * into every balance rebuild and the one `verify_bank_withdrawals.js` pins
 * the cache equal to, simply stopped at a date. With no date the cache is
 * still what is read, so the undated figure cannot drift from Overview > Bank.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CASH IN HAND — DERIVED, WITH NO COLUMN OF ITS OWN
 * ─────────────────────────────────────────────────────────────────────────
 * There is no cash ledger and no `opening_cash`, by instruction. Cash in hand
 * is therefore computed from the source tables: every movement the app records
 * a PAYMENT SOURCE for, signed by its direction, where that source is not a
 * named bank account.
 *
 * THE RULE, and it is the exact complement of the bank mechanism: a row moves
 * cash when `payment_source <> 'bank'` — so no `bank_ledger` entry was written
 * for it — AND its own `payment_type` says the money actually changed hands in
 * cash. The nine tables of `BANK_SOURCES` plus the four named bank paths
 * (`asset_payments`, `personal_expenses`, `internal_settlements`, and a bill's
 * house receipt) are precisely the rows that carry a source, so they are
 * precisely the rows that can be cash.
 *
 * WHY `payment_source = 'cash'` IS NOT ENOUGH ON ITS OWN. `bankSourceFields()`
 * writes `payment_source = 'cash'` for every row that is not bank-sourced —
 * including a row the user labelled CREDIT. A credit sale, an unpaid wage and
 * an unpaid purchase order all carry `payment_source = 'cash'` and have moved
 * no money at all; counting them would report money in the drawer that the
 * client has not been given yet. So each term also tests the table's own
 * `payment_type`:
 *
 *   - `sales`, `egg_sales`, `hen_sales`, `labour_payments` offer cash/bank/credit
 *   - `expenses` offers cash/bank/cheque
 *   - `purchase_orders` offers 'cash' = Paid (Debit) and 'credit' = Unpaid
 *   - `income` and the layer Expenses screen have no `payment_type` selector
 *     and drive `payment_source` directly, so for those the source alone is
 *     the test
 *
 * A `payment_type = 'cheque'` expense is in NEITHER total, and that is honest:
 * a cheque is drawn on a bank, but no account was named so no `bank_ledger`
 * row exists, and it never came out of the drawer either. The same goes for a
 * LEGACY row saying `payment_type = 'bank'` with `payment_source = 'cash'` —
 * the structural exemption every pre-mechanism row relies on. Nothing was
 * posted for it and it is not cash.
 *
 * WHAT IS NOT COUNTED, and why the figure is a cash POSITION rather than a
 * complete cash book: `feed_entries`, `medicine_entries`, `vaccinations`,
 * `ledger_entries` and `layer_ledger_entries` carry real costs and have NO
 * payment column of any kind. The client cannot record a source against them,
 * so there is nothing to claim they were paid in cash with; asserting it would
 * invent a withdrawal the user never recorded. They are real spending that
 * this figure does not see, which is why the card is labelled "from recorded
 * cash transactions". Give one of those tables a `payment_source` and it gets
 * a term here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CUSTOMER SIDE: `bills.amount_paid`, LESS WHAT WENT TO A BANK
 * ─────────────────────────────────────────────────────────────────────────
 * `bills.amount_paid` is the authoritative record of money received against a
 * bill, and it is raised through FOUR doors: the bill's own receipt at save
 * time, a Customer Ledger payment, a receive voucher, and an internal
 * settlement. So it is counted ONCE, in full, and the bank-attributed portion
 * is then taken back off — rather than adding `receive_vouchers.amount`
 * alongside it, which would count a voucher receipt twice.
 *
 * That is also why the Customer Ledger screen's own payments are counted at
 * all: `customer_ledger` has no `payment_source` column, so a payment entered
 * there has no recorded source and is cash by the same default every other
 * table uses. It reaches this figure through `amount_paid` and nowhere else.
 *
 * The five corrections, and why each is read where it is:
 *
 *   - A BILL'S HOUSE RECEIPT is read off `bank_ledger` (`bill_payment_in`
 *     debits), not off `bills.payment_source`: the bill's own columns say how
 *     ITS receipt was taken, but `amount_paid` may have been raised by later
 *     settlements since, so deducting `amount_paid` would take back more than
 *     the bank ever got. The entry holds the receipt itself and is regenerated
 *     on edit, so it is always exactly right.
 *   - A DEPOSIT-PAID BILL (`payment_account_kind = 'customer'`) is read the
 *     same way, as the `'payment'` credits `deductCustomerBank()` writes on
 *     the CUSTOMER'S account. That money came out of the deposit the customer
 *     already held, not out of the drawer.
 *   - A BANK REFUND on a sales return is the mirror of that and is added BACK:
 *     `sales-returns.component.ts` lowers `amount_paid` and credits the
 *     customer's account (`reference_type = 'return'`), so without this the
 *     refund would come out of the cash drawer. A CASH refund lowers
 *     `amount_paid` with no entry, and correctly does reduce cash.
 *   - RECEIVE VOUCHERS and INTERNAL SETTLEMENTS are read off their OWN tables,
 *     not off `bank_ledger`, and that difference is load-bearing. An internal
 *     settlement whose two ends are the SAME bank account writes zero ledger
 *     rows on purpose (see `saveInternalSettlement()`), so a deduction driven
 *     off `bank_ledger` would find nothing and credit the drawer with money
 *     that never left the bank. The settlement row always says where the money
 *     went.
 *
 * INTERNAL SETTLEMENTS therefore appear twice and net correctly: the FROM side
 * is cash out of the farm's drawer when `from_account = 'cash'`, and the TO
 * side is the `amount_paid` credit above, kept only when `to_account = 'cash'`.
 * Cash->Cash nets to zero, Bank->Cash is a straight +, Cash->Bank a straight
 * -, and Bank->Bank zero either way.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE TERM `asOf` CANNOT FILTER IN PLACE: `bills.amount_paid`
 * ─────────────────────────────────────────────────────────────────────────
 * Every other term sits on a table whose row carries the date the money
 * moved, so `<= asOf` is the whole story. `bills.amount_paid` does not: it is
 * a RUNNING TOTAL raised by four doors over time, and the only date on the
 * row is `bill_date` — the date of the CHARGE, not of any receipt against it.
 * Filtering on `bill_date` would count a bill raised in March and settled in
 * September as fully collected in March.
 *
 * So `bills_paid_in` stays unfiltered and a companion term,
 * `bills_paid_after_asof`, takes back the receipts dated after the cut-off.
 * All four doors write a `customer_ledger` CREDIT carrying the date the money
 * was taken — the bill's own receipt, a Customer Ledger payment, a receive
 * voucher and an internal settlement — which is the dated statement of the
 * very figure `amount_paid` caches, and the pair the ledger-reversal
 * invariant already holds equal. With no `asOf` the term is structurally
 * zero (nothing is dated after '9999-12-31'), so the undated figure is
 * unchanged.
 *
 * Its one known edge, stated rather than papered over: a SALES RETURN rebuilds
 * its bill's `'payment'` credit row and re-dates it to the return date, so a
 * return recorded AFTER the cut-off takes that bill's whole receipt out of an
 * as-of figure instead of restoring the pre-return amount. It is a report of a
 * past date being corrected by a later event; the TODAY figure, which is what
 * the client reconciles against the drawer, is exact.
 */

/**
 * The token `cashSql()` returns for the optional cut-off `?`, as opposed to
 * `'farm_id'` for every other one. Exported so the verify script binds the
 * statement exactly the way the service does.
 */
export const AS_OF_PARAM = 'as_of';

/**
 * The token `farmCashSql()` returns for its unit `?`s. A null unit lets every
 * farm through, so the statement never changes shape.
 */
export const UNIT_PARAM = 'unit_id';

/** One signed term of the cash derivation, for display and for verification. */
export interface CashComponent {
  /** Stable key — the source table and direction, e.g. `layer_expenses_out`. */
  key: string;
  /** Signed contribution to cash in hand: positive is money in. */
  amount: number;
}

export interface CashPosition {
  /** Derived cash in hand across every recorded cash movement. */
  cashInHand: number;
  /** SUM of every HOUSE bank account's current balance. */
  totalBankBalance: number;
  /** Every term that fed `cashInHand`, signed, in declaration order. */
  components: CashComponent[];
  /**
   * The cut-off both figures are stated as of — `YYYY-MM-DD`, or null when
   * they are as at today. Carried on the result so a screen labels its block
   * from the figure it is printing rather than from its own form state.
   */
  asOf: string | null;
  /** Non-fatal problems (a failed query), so a card never silently reads 0. */
  warnings: string[];
}

/**
 * CASH FROM ONE FARM'S OWN RECORDED TRANSACTIONS — a different quantity from
 * `CashPosition.cashInHand`, and deliberately named so.
 *
 * `cashInHand` above is the DRAWER: every cash movement the whole login
 * account has recorded, which is what the client reconciles against the notes
 * in his hand. There is one drawer behind every farm, so it cannot be split
 * per farm without ceasing to be a drawer balance.
 *
 * This is the NET CASH ONE FARM GENERATED: its own sales and income less its
 * own expenses and wages, up to the cut-off. The account-level money —
 * distribution's collections and purchases, the vouchers, the assets, the
 * personal expenses — belongs to no single farm and is simply not in it. So
 * the two figures are not expected to agree, cannot be added together, and the
 * Farm Report labels this one as what it is.
 */
export interface FarmCashPosition {
  /** Net cash this farm's own recorded transactions produced, up to `asOf`. */
  farmCashInHand: number;
  /** Every term that fed it, signed, in declaration order. */
  components: CashComponent[];
  /** The module the figure covers. */
  module: 'broiler' | 'layer';
  /** The farm unit, or null for every unit of that module on the account. */
  unitId: number | null;
  /** The cut-off, or null for today. */
  asOf: string | null;
  warnings: string[];
}

@Injectable({ providedIn: 'root' })
export class CashPositionService {

  constructor(private db: DatabaseService) {}

  /**
   * Both figures for one login account.
   *
   * `asOf` is an optional `YYYY-MM-DD` CUT-OFF: every movement dated on or
   * before it counts and nothing after it does. Omit it for the figures as at
   * today — the Overview dashboard and the Distribution Report both do, and
   * get exactly the query this service always ran.
   *
   * Read-only. A failed read is reported in `warnings` and contributes 0
   * rather than throwing, so one broken query cannot blank a dashboard — the
   * same contract `overview.service.ts` has.
   */
  async getCashPosition(farmId: number, asOf: string | null = null): Promise<CashPosition> {
    const warnings: string[] = [];
    // An empty form field arrives as '' — treat it as "no cut-off" rather
    // than letting it into a comparison where it excludes every row.
    const cutOff = asOf ? String(asOf).slice(0, 10) : null;

    if (!farmId) {
      return {
        cashInHand: 0,
        totalBankBalance: 0,
        components: [],
        warnings: ['No farm account is active — nothing to total.'],
        asOf: cutOff
      };
    }

    const [components, bank] = await Promise.all([
      this.readComponents(farmId, cutOff, warnings),
      this.readBankTotal(farmId, cutOff, warnings)
    ]);

    return {
      cashInHand: components.reduce((sum, c) => sum + c.amount, 0),
      totalBankBalance: bank,
      components,
      warnings,
      asOf: cutOff
    };
  }

  /**
   * The net cash ONE FARM's own recorded transactions produced, up to `asOf`.
   *
   * NOT a second opinion on `cashInHand`, and the reason it is a separate
   * method rather than a parameter on `getCashPosition()`: it answers a
   * different question. See `FarmCashPosition` above. `cashSql()` is untouched
   * and the account-wide figure is byte-for-byte the one Overview and the
   * Distribution Report have always read.
   *
   * `unitId` null means every farm unit of that module on the account.
   */
  async getFarmCashPosition(
    farmId: number,
    module: 'broiler' | 'layer',
    unitId: number | null = null,
    asOf: string | null = null
  ): Promise<FarmCashPosition> {
    const warnings: string[] = [];
    const cutOff = asOf ? String(asOf).slice(0, 10) : null;

    if (!farmId) {
      return {
        farmCashInHand: 0, components: [], module, unitId, asOf: cutOff,
        warnings: ['No farm account is active — nothing to total.']
      };
    }

    const [sql, params] = this.farmCashSql(module);
    const res = await this.db.get(sql, params.map(p =>
      p === AS_OF_PARAM ? cutOff : (p === UNIT_PARAM ? unitId : farmId)));

    if (!res.success) {
      warnings.push("This farm's cash could not be derived: " + res.error);
      return { farmCashInHand: 0, components: [], module, unitId, asOf: cutOff, warnings };
    }

    const components: CashComponent[] = (res.data || []).map((r: any) => ({
      key: String(r.component_key),
      amount: Number(r.amount) || 0
    }));

    return {
      farmCashInHand: components.reduce((sum, c) => sum + c.amount, 0),
      components,
      module,
      unitId,
      asOf: cutOff,
      warnings
    };
  }

  /**
   * The per-farm derivation, as SQL, in ONE statement — the same shape
   * `cashSql()` has and the same `upTo` cut-off, over the SUBSET of terms a
   * farm can be held responsible for.
   *
   * WHICH TERMS, AND WHY ONLY THESE. A term belongs here when its row can be
   * traced to a farm unit: the broiler tables reach one through `flocks`, the
   * layer tables through `batches`. Everything else in `cashSql()` is
   * account-level — `bills`, `purchase_orders`, the two voucher tables,
   * `expense_ledger`, `asset_payments`, `assets`, `personal_expenses`,
   * `internal_settlements` and every bank correction — and attributing any of
   * it to a farm would be an invention. That is exactly why the result is
   * labelled "cash from this farm's own transactions" and not "cash in hand".
   *
   * The unit filter is `(? IS NULL OR u.unit_id = ?)`, so the statement text
   * and the parameter list are identical whether or not a unit is given — the
   * same device the cut-off uses.
   */
  farmCashSql(module: 'broiler' | 'layer'): [string, string[]] {
    const paidInCash = (a: string) =>
      `COALESCE(${a}.payment_type,'cash') = 'cash' AND COALESCE(${a}.payment_source,'cash') <> 'bank'`;
    const sourceIsCash = (a: string) =>
      `COALESCE(${a}.payment_source,'cash') <> 'bank'`;
    const upTo = (col: string) => `${col} <= COALESCE(?, '9999-12-31')`;
    /** Every unit of the module when no unit is named. */
    const inUnit = `(? IS NULL OR u.unit_id = ?)`;

    const FARM = 'farm_id';
    /** farm_id, then the cut-off, then the unit pair — in statement order. */
    const SCOPED = [FARM, AS_OF_PARAM, UNIT_PARAM, UNIT_PARAM];

    const broilerTerms: [string, string, string[]][] = [
      ['broiler_sales_in',
       `SELECT COALESCE(SUM(s.total_amount), 0) AS amount
        FROM sales s
        JOIN flocks u ON u.flock_id = s.flock_id
        WHERE u.farm_id = ? AND COALESCE(s.module_type,'broiler') = 'broiler'
          AND ${paidInCash('s')} AND ${upTo('s.date')} AND ${inUnit}`, SCOPED],

      ['broiler_income_in',
       `SELECT COALESCE(SUM(i.amount), 0) AS amount
        FROM income i
        JOIN flocks u ON u.flock_id = i.flock_id
        WHERE u.farm_id = ? AND COALESCE(i.module_type,'broiler') = 'broiler'
          AND COALESCE(i.source,'manual') = 'manual'
          AND ${sourceIsCash('i')} AND ${upTo('i.date')} AND ${inUnit}`, SCOPED],

      ['broiler_expenses_out',
       `SELECT -COALESCE(SUM(e.amount), 0) AS amount
        FROM expenses e
        JOIN flocks u ON u.flock_id = e.flock_id
        WHERE u.farm_id = ? AND COALESCE(e.module_type,'broiler') = 'broiler'
          AND ${paidInCash('e')} AND ${upTo('e.date')} AND ${inUnit}`, SCOPED],

      ['broiler_labour_out',
       `SELECT -COALESCE(SUM(lp.amount), 0) AS amount
        FROM labour_payments lp
        JOIN flocks u ON u.flock_id = lp.flock_id
        WHERE u.farm_id = ? AND COALESCE(lp.module_type,'broiler') = 'broiler'
          AND ${paidInCash('lp')} AND ${upTo('lp.date')} AND ${inUnit}`, SCOPED]
    ];

    const layerTerms: [string, string, string[]][] = [
      ['egg_sales_in',
       `SELECT COALESCE(SUM(es.total_amount), 0) AS amount
        FROM egg_sales es
        JOIN batches u ON u.batch_id = es.batch_id
        WHERE u.farm_id = ? AND ${paidInCash('es')} AND ${upTo('es.date')} AND ${inUnit}`, SCOPED],

      ['hen_sales_in',
       `SELECT COALESCE(SUM(hs.total_amount), 0) AS amount
        FROM hen_sales hs
        JOIN batches u ON u.batch_id = hs.batch_id
        WHERE u.farm_id = ? AND ${paidInCash('hs')} AND ${upTo('hs.date')} AND ${inUnit}`, SCOPED],

      ['layer_income_in',
       `SELECT COALESCE(SUM(i.amount), 0) AS amount
        FROM income i
        JOIN batches u ON u.batch_id = i.flock_id
        WHERE u.farm_id = ? AND i.module_type = 'layer'
          AND COALESCE(i.source,'manual') = 'manual'
          AND ${sourceIsCash('i')} AND ${upTo('i.date')} AND ${inUnit}`, SCOPED],

      ['layer_expenses_out',
       `SELECT -COALESCE(SUM(e.amount), 0) AS amount
        FROM expenses e
        JOIN batches u ON u.batch_id = e.flock_id
        WHERE u.farm_id = ? AND e.module_type = 'layer'
          AND ${paidInCash('e')} AND ${upTo('e.date')} AND ${inUnit}`, SCOPED],

      ['layer_labour_out',
       `SELECT -COALESCE(SUM(lp.amount), 0) AS amount
        FROM labour_payments lp
        JOIN batches u ON u.batch_id = lp.flock_id
        WHERE u.farm_id = ? AND lp.module_type = 'layer'
          AND ${paidInCash('lp')} AND ${upTo('lp.date')} AND ${inUnit}`, SCOPED]
    ];

    const terms = module === 'layer' ? layerTerms : broilerTerms;

    // The key is INTERPOLATED, never bound: a TypeScript literal from the list
    // above, never a value off a row or a form. Same reasoning as `cashSql()`.
    const sql = terms
      .map(([key, body]) => `SELECT '${key}' AS component_key, amount FROM (${body})`)
      .join('\nUNION ALL\n');

    return [sql, terms.flatMap(([, , params]) => params)];
  }

  // ── Total bank balance ────────────────────────────────────────────────────

  /**
   * HOUSE accounts only — `customer_id IS NULL`. A row with a customer is that
   * customer's deposit held by the farm, not the owner's money.
   */
  private async readBankTotal(farmId: number, asOf: string | null, warnings: string[]): Promise<number> {
    // With a cut-off the cached balance is no help — it only ever describes
    // now — so the account's own ledger is summed up to that date. Same
    // definition, stopped earlier; see the class comment.
    const res = asOf
      ? await this.db.get(
          `SELECT COALESCE(SUM(bl.debit - bl.credit), 0) AS amount
           FROM bank_ledger bl
           JOIN bank_accounts ba ON ba.bank_id = bl.bank_id
           WHERE ba.farm_id = ? AND ba.customer_id IS NULL
             AND bl.transaction_date <= ?`,
          [farmId, asOf]
        )
      : await this.db.get(
          `SELECT COALESCE(SUM(current_balance), 0) AS amount
           FROM bank_accounts
           WHERE farm_id = ? AND customer_id IS NULL`,
          [farmId]
        );
    if (!res.success) {
      warnings.push('Total bank balance could not be read: ' + res.error);
      return 0;
    }
    return Number((res.data || [])[0]?.amount) || 0;
  }

  // ── Cash in hand ──────────────────────────────────────────────────────────

  private async readComponents(farmId: number, asOf: string | null, warnings: string[]): Promise<CashComponent[]> {
    const [sql, params] = this.cashSql();
    const res = await this.db.get(sql, params.map(p => p === AS_OF_PARAM ? asOf : farmId));

    if (!res.success) {
      warnings.push('Cash in hand could not be derived: ' + res.error);
      return [];
    }

    return (res.data || []).map((r: any) => ({
      key: String(r.component_key),
      amount: Number(r.amount) || 0
    }));
  }

  /**
   * The derivation, as SQL, in ONE statement.
   *
   * A single `UNION ALL` rather than a query per table: these are read on
   * every load of three screens and `db.get()` is one IPC round trip each.
   * Every branch carries its own key, so a figure that looks wrong can be
   * traced to the table that produced it — which is also what the verify
   * script asserts term by term.
   *
   * Returns the statement plus one TOKEN per `?` it carries, in order: either
   * `'farm_id'` or `AS_OF_PARAM` for the optional cut-off, which is all the
   * caller needs to bind them without parsing the SQL. The statement does NOT
   * change shape when a date is given — the cut-off is a bound parameter and a
   * NULL simply lets every row through. Public and dependency-free so
   * `verify_cash_and_bank_totals.js` can lift and execute it unchanged rather
   * than restating it.
   *
   * Scoping is per table and matches the rest of the app: broiler rows reach
   * `farm_id` through `flocks`, layer rows through `batches`, and the shared
   * tables carry the `module_type` guard that keeps a colliding `flock_id` and
   * `batch_id` apart (see the collision landmine in CLAUDE.md). The
   * `labour_payments` terms deliberately do NOT join `labour` — a deleted
   * worker's payments must still count, because the money really left.
   */
  cashSql(): [string, string[]] {
    /** A row whose own `payment_type` must say the cash actually moved. */
    const paidInCash = (a: string) =>
      `COALESCE(${a}.payment_type,'cash') = 'cash' AND COALESCE(${a}.payment_source,'cash') <> 'bank'`;
    /** A row whose screen drives `payment_source` directly, with no label. */
    const sourceIsCash = (a: string) =>
      `COALESCE(${a}.payment_source,'cash') <> 'bank'`;
    /**
     * The cut-off, as a range-TO test on the table's own date column. A NULL
     * cut-off lets every row through, which is what keeps the SQL text and the
     * parameter list identical whether or not a date was asked for.
     */
    const upTo = (col: string) => `${col} <= COALESCE(?, '9999-12-31')`;

    // Each term declares the `?`s it carries, IN ORDER, so the caller can bind
    // them without parsing the statement. Every term but `bills_paid_in` takes
    // the cut-off; that one has no date of its own (see the class comment) and
    // is corrected by `bills_paid_after_asof` at the bottom instead.
    const FARM = 'farm_id';
    const DATED = [FARM, AS_OF_PARAM];

    const terms: [string, string, string[]][] = [

      // ── MONEY IN ──────────────────────────────────────────────────────────

      ['broiler_sales_in',
       `SELECT COALESCE(SUM(s.total_amount), 0) AS amount
        FROM sales s
        JOIN flocks f ON f.flock_id = s.flock_id
        WHERE f.farm_id = ? AND COALESCE(s.module_type,'broiler') = 'broiler'
          AND ${paidInCash('s')} AND ${upTo('s.date')}`, DATED],

      ['egg_sales_in',
       `SELECT COALESCE(SUM(es.total_amount), 0) AS amount
        FROM egg_sales es
        JOIN batches b ON b.batch_id = es.batch_id
        WHERE b.farm_id = ? AND ${paidInCash('es')} AND ${upTo('es.date')}`, DATED],

      ['hen_sales_in',
       `SELECT COALESCE(SUM(hs.total_amount), 0) AS amount
        FROM hen_sales hs
        JOIN batches b ON b.batch_id = hs.batch_id
        WHERE b.farm_id = ? AND ${paidInCash('hs')} AND ${upTo('hs.date')}`, DATED],

      // MANUAL income rows only. The `source` = sale/egg_sale/hen_sale rows are
      // daily mirrors of the three sale tables above, rebuilt on every change;
      // counting them would take every cash sale twice. The same exclusion
      // `isBankable()` makes on the screen and `qBroilerIncome()` in
      // overview.service.ts makes for revenue.
      ['broiler_income_in',
       `SELECT COALESCE(SUM(i.amount), 0) AS amount
        FROM income i
        JOIN flocks f ON f.flock_id = i.flock_id
        WHERE f.farm_id = ? AND COALESCE(i.module_type,'broiler') = 'broiler'
          AND COALESCE(i.source,'manual') = 'manual'
          AND ${sourceIsCash('i')} AND ${upTo('i.date')}`, DATED],

      ['layer_income_in',
       `SELECT COALESCE(SUM(i.amount), 0) AS amount
        FROM income i
        JOIN batches b ON b.batch_id = i.flock_id
        WHERE b.farm_id = ? AND i.module_type = 'layer'
          AND COALESCE(i.source,'manual') = 'manual'
          AND ${sourceIsCash('i')} AND ${upTo('i.date')}`, DATED],

      // SELLING AN ASSET brings money in, and until the Sell form grew a
      // Cash/Bank selector it brought it in nowhere: `assets.sale_amount` was
      // recorded and no figure moved. `sale_payment_source` is the sale's OWN
      // source — never `assets.payment_source`, which says how the asset was
      // originally PAID FOR, in the other direction.
      //
      // `sourceIsCash` rather than `paidInCash`: there is no `payment_type` on
      // a sale, so the source is the whole test, and a NULL (every asset sold
      // before the selector existed) reads as cash — which is true, because no
      // bank entry was ever posted for it.
      ['asset_sales_in',
       `SELECT COALESCE(SUM(a.sale_amount), 0) AS amount
        FROM assets a
        WHERE a.farm_id = ? AND a.status = 'sold'
          AND COALESCE(a.sale_payment_source,'cash') <> 'bank'
          AND ${upTo('a.sale_date')}`, DATED],

      // Every rupee received against a bill, through all four doors. The
      // bank-attributed part comes straight back off in the five corrections
      // below. MAX(...,0) because an overpayment is money really received,
      // while a negative `amount_paid` would be a data error, not a refund.
      //
      // DELIBERATELY UNDATED: `amount_paid` is a running total and `bill_date`
      // is the date of the CHARGE, not of any receipt against it. The cut-off
      // is applied by `bills_paid_after_asof` at the bottom instead.
      ['bills_paid_in',
       `SELECT COALESCE(SUM(MAX(COALESCE(bl.amount_paid, 0), 0)), 0) AS amount
        FROM bills bl
        WHERE bl.farm_id = ?`, [FARM]],

      // ── MONEY OUT ─────────────────────────────────────────────────────────

      ['broiler_expenses_out',
       `SELECT -COALESCE(SUM(e.amount), 0) AS amount
        FROM expenses e
        JOIN flocks f ON f.flock_id = e.flock_id
        WHERE f.farm_id = ? AND COALESCE(e.module_type,'broiler') = 'broiler'
          AND ${paidInCash('e')} AND ${upTo('e.date')}`, DATED],

      // The layer Expenses screen writes the same table with module_type
      // 'layer' — there is no `layer_expenses` table — and drives
      // `payment_source` directly, leaving `payment_type` at its 'cash'
      // default, so `paidInCash` is the right test on both sides.
      ['layer_expenses_out',
       `SELECT -COALESCE(SUM(e.amount), 0) AS amount
        FROM expenses e
        JOIN batches b ON b.batch_id = e.flock_id
        WHERE b.farm_id = ? AND e.module_type = 'layer'
          AND ${paidInCash('e')} AND ${upTo('e.date')}`, DATED],

      ['broiler_labour_out',
       `SELECT -COALESCE(SUM(lp.amount), 0) AS amount
        FROM labour_payments lp
        JOIN flocks f ON f.flock_id = lp.flock_id
        WHERE f.farm_id = ? AND COALESCE(lp.module_type,'broiler') = 'broiler'
          AND ${paidInCash('lp')} AND ${upTo('lp.date')}`, DATED],

      ['layer_labour_out',
       `SELECT -COALESCE(SUM(lp.amount), 0) AS amount
        FROM labour_payments lp
        JOIN batches b ON b.batch_id = lp.flock_id
        WHERE b.farm_id = ? AND lp.module_type = 'layer'
          AND ${paidInCash('lp')} AND ${upTo('lp.date')}`, DATED],

      // `payment_type = 'cash'` here means PAID (Debit), not a source — the
      // deliberate exception documented in BANK_SOURCES. An unpaid order moved
      // no money, which is exactly what this test excludes.
      ['purchase_orders_out',
       `SELECT -COALESCE(SUM(po.total_amount), 0) AS amount
        FROM purchase_orders po
        WHERE po.farm_id = ? AND ${paidInCash('po')} AND ${upTo('po.date')}`, DATED],

      // THE DISTRIBUTION BUSINESS'S OWN RUNNING COSTS — rent, fuel, salaries.
      // `paidInCash` is the right test for the same reason it is on
      // purchase_orders: this table's `payment_type` is 'cash' (paid) vs
      // 'credit' (unpaid), a settlement status, so an unpaid expense has moved
      // nothing and is excluded by exactly that test. It had no term at all
      // until the table could record WHICH account paid.
      ['expense_ledger_out',
       `SELECT -COALESCE(SUM(el.amount), 0) AS amount
        FROM expense_ledger el
        WHERE el.farm_id = ? AND ${paidInCash('el')} AND ${upTo('el.transaction_date')}`, DATED],

      ['payment_vouchers_out',
       `SELECT -COALESCE(SUM(pv.amount), 0) AS amount
        FROM payment_vouchers pv
        WHERE pv.farm_id = ? AND ${sourceIsCash('pv')} AND ${upTo('pv.date')}`, DATED],

      ['asset_payments_out',
       `SELECT -COALESCE(SUM(ap.amount), 0) AS amount
        FROM asset_payments ap
        WHERE ap.farm_id = ? AND ${sourceIsCash('ap')} AND ${upTo('ap.date')}`, DATED],

      ['personal_expenses_out',
       `SELECT -COALESCE(SUM(pe.amount), 0) AS amount
        FROM personal_expenses pe
        WHERE pe.farm_id = ? AND ${sourceIsCash('pe')} AND ${upTo('pe.date')}`, DATED],

      // The FROM leg: the owner's farm handing cash to his own distribution
      // business. Its TO leg is inside `bills_paid_in` and is removed again by
      // `internal_settlement_to_bank` below when it landed in an account.
      ['internal_settlements_out',
       `SELECT -COALESCE(SUM(isl.amount), 0) AS amount
        FROM internal_settlements isl
        WHERE isl.farm_id = ? AND COALESCE(isl.from_account,'cash') <> 'bank'
          AND ${upTo('isl.date')}`, DATED],

      // ── LOANS AND ADVANCES: FOUR TERMS, TWO EACH WAY ──────────────────────
      //
      // A loan is NEITHER income nor an expense — nothing about it reaches any
      // profit figure — but it absolutely moves money, which is why it has
      // terms here and nowhere else. The direction is a property of the LOAN,
      // so each side needs its own term rather than one signed expression:
      //
      //   'given'     principal out of the drawer, repayments back into it
      //   'received'  principal into the drawer, repayments back out of it
      //
      // `sourceIsCash` is the whole test on all four: these tables have no
      // `payment_type`, so the source is the only thing that says where the
      // money went, and a NULL reads as cash — which is true, since no bank
      // entry was posted for it.
      ['loans_given_out',
       `SELECT -COALESCE(SUM(l.principal), 0) AS amount
        FROM loans l
        WHERE l.farm_id = ? AND COALESCE(l.direction,'given') = 'given'
          AND ${sourceIsCash('l')} AND ${upTo('l.date')}`, DATED],

      ['loans_received_in',
       `SELECT COALESCE(SUM(l.principal), 0) AS amount
        FROM loans l
        WHERE l.farm_id = ? AND COALESCE(l.direction,'given') = 'received'
          AND ${sourceIsCash('l')} AND ${upTo('l.date')}`, DATED],

      // A repayment's own source, not the loan's: the client may lend in cash
      // and be repaid by transfer, and the row that moved the money is the one
      // that says how.
      ['loan_repayments_in',
       `SELECT COALESCE(SUM(lp.amount), 0) AS amount
        FROM loan_payments lp
        JOIN loans l ON l.loan_id = lp.loan_id
        WHERE lp.farm_id = ? AND COALESCE(l.direction,'given') = 'given'
          AND ${sourceIsCash('lp')} AND ${upTo('lp.date')}`, DATED],

      ['loan_repayments_out',
       `SELECT -COALESCE(SUM(lp.amount), 0) AS amount
        FROM loan_payments lp
        JOIN loans l ON l.loan_id = lp.loan_id
        WHERE lp.farm_id = ? AND COALESCE(l.direction,'given') = 'received'
          AND ${sourceIsCash('lp')} AND ${upTo('lp.date')}`, DATED],

      // ── THE BANK-ATTRIBUTED PART OF `bills_paid_in`, TAKEN BACK OFF ───────

      // A bill received into one of the owner's own accounts.
      ['bill_house_receipt_banked',
       `SELECT -COALESCE(SUM(bkl.debit), 0) AS amount
        FROM bank_ledger bkl
        JOIN bank_accounts ba ON ba.bank_id = bkl.bank_id
        WHERE ba.farm_id = ? AND bkl.reference_type = 'bill_payment_in'
          AND ${upTo('bkl.transaction_date')}`, DATED],

      // A bill settled out of the deposit the customer already held with the
      // farm — `deductCustomerBank()`, on the CUSTOMER's account.
      ['customer_deposit_paid',
       `SELECT -COALESCE(SUM(bkl.credit), 0) AS amount
        FROM bank_ledger bkl
        JOIN bank_accounts ba ON ba.bank_id = bkl.bank_id
        WHERE ba.farm_id = ? AND ba.customer_id IS NOT NULL
          AND bkl.reference_type = 'payment'
          AND ${upTo('bkl.transaction_date')}`, DATED],

      // The mirror of it: a sales return refunded to the customer's deposit
      // lowers `amount_paid` without touching the drawer, so the drop is added
      // back. A CASH refund has no entry and correctly does reduce cash.
      ['customer_bank_refund',
       `SELECT COALESCE(SUM(bkl.credit), 0) AS amount
        FROM bank_ledger bkl
        JOIN bank_accounts ba ON ba.bank_id = bkl.bank_id
        WHERE ba.farm_id = ? AND ba.customer_id IS NOT NULL
          AND bkl.reference_type = 'return'
          AND ${upTo('bkl.transaction_date')}`, DATED],

      // Read off the voucher, not off `bank_ledger`: one voucher is one money
      // event whatever its FIFO spill touched, and the table says where it went.
      ['receive_voucher_banked',
       `SELECT -COALESCE(SUM(rv.amount), 0) AS amount
        FROM receive_vouchers rv
        WHERE rv.farm_id = ? AND COALESCE(rv.payment_source,'cash') = 'bank'
          AND ${upTo('rv.date')}`, DATED],

      // Read off the settlement for the reason in the class comment: a
      // same-account settlement writes NO ledger row, so `bank_ledger` cannot
      // be the source of truth for where this money went.
      ['internal_settlement_to_bank',
       `SELECT -COALESCE(SUM(isl.amount), 0) AS amount
        FROM internal_settlements isl
        WHERE isl.farm_id = ? AND COALESCE(isl.to_account,'cash') = 'bank'
          AND ${upTo('isl.date')}`, DATED],

      // ── THE CUT-OFF FOR `bills_paid_in` ───────────────────────────────────
      //
      // Receipts dated AFTER the cut-off, taken back off the running total
      // `bills_paid_in` counted in full. Every door that raises `amount_paid`
      // writes one of these credits on the day the money was taken, so this is
      // that figure's dated statement — the pair the ledger-reversal invariant
      // already holds equal. With no cut-off nothing is dated after
      // '9999-12-31', the term is zero, and the undated result is byte-for-byte
      // the one this service always returned.
      ['bills_paid_after_asof',
       `SELECT -COALESCE(SUM(cl.credit), 0) AS amount
        FROM customer_ledger cl
        JOIN customers c ON c.customer_id = cl.customer_id
        WHERE c.farm_id = ? AND cl.credit > 0
          AND NOT (${upTo('cl.transaction_date')})`, DATED],

      // ── MOVING CASH BETWEEN THE DRAWER AND A HOUSE ACCOUNT ────────────────
      //
      // The client banked cash and watched the bank total rise while Cash in
      // Hand did not move. It was the one money movement in the app with a
      // bank side and no cash side: Overview > Bank writes the `bank_ledger`
      // row through `addBankLedgerEntry()`, the balance follows, and no term
      // here read those rows — so the cash left the drawer as far as he was
      // concerned and nowhere as far as the app was.
      //
      // These two terms are that cash side. A manual DEPOSIT takes notes out
      // of the drawer and puts them in the account; a manual WITHDRAWAL does
      // the reverse. Together with the bank half the pair nets to zero, which
      // is what a transfer should do: the money changed place, not amount.
      //
      // WHY THESE ROWS CAN BE READ THAT WAY. `reference_type` is 'deposit' or
      // 'withdrawal' only for the Bank Ledger screen's OWN form — every other
      // writer stamps its own type ('bill_payment_in', 'asset_payment',
      // 'loan', …) and is already accounted for by its own term. That form is
      // also the only way in this app to move money between the drawer and an
      // account, so these rows cannot mean anything else.
      //
      // 'opening' is EXCLUDED and must stay excluded: an opening balance is
      // the account's starting state, not money that crossed from the drawer.
      // Counting it would show an account opened with Rs 500,000 as Rs 500,000
      // of cash spent. Rows with a NULL or empty reference_type are excluded
      // for the opposite reason — nothing writes one today, so any that exist
      // predate this and their intent is unrecorded; the same structural
      // exemption legacy `payment_source` rows get.
      //
      // HOUSE ACCOUNTS ONLY (`customer_id IS NULL`). A deposit into a
      // customer's deposit account is that customer's money arriving, not the
      // owner's cash leaving his drawer.
      ['bank_manual_deposit_out',
       `SELECT -COALESCE(SUM(bkl.debit), 0) AS amount
        FROM bank_ledger bkl
        JOIN bank_accounts ba ON ba.bank_id = bkl.bank_id
        WHERE ba.farm_id = ? AND ba.customer_id IS NULL
          AND bkl.reference_type = 'deposit'
          AND ${upTo('bkl.transaction_date')}`, DATED],

      ['bank_manual_withdrawal_in',
       `SELECT COALESCE(SUM(bkl.credit), 0) AS amount
        FROM bank_ledger bkl
        JOIN bank_accounts ba ON ba.bank_id = bkl.bank_id
        WHERE ba.farm_id = ? AND ba.customer_id IS NULL
          AND bkl.reference_type = 'withdrawal'
          AND ${upTo('bkl.transaction_date')}`, DATED]
    ];

    // The key is INTERPOLATED, never bound: each one is a TypeScript literal
    // in the list above, never a value off a row or a form — the same
    // reasoning as `nextLayerBillNumberSql()`. Every `?` in the statement is
    // either a farm_id or the cut-off, and every one of them is bound.
    const sql = terms
      .map(([key, body]) => `SELECT '${key}' AS component_key, amount FROM (${body})`)
      .join('\nUNION ALL\n');

    return [sql, terms.flatMap(([, , params]) => params)];
  }
}
