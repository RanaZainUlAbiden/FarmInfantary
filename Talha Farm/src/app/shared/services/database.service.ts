import { Injectable, NgZone } from '@angular/core';

import { toLocalDateString } from '../utils/date.util';
import { friendlySqlError } from '../utils/sql-error.util';
import { LayerBillSource } from '../utils/bill-source.util';
/**
 * One statement in a batch. A params entry of `{ $lastId: n }` is replaced, in
 * the main process, with the id inserted by operation `n` of the same batch —
 * `n < 0` counts back from the current operation, so `{ $lastId: -1 }` means
 * "the row the previous statement just inserted".
 */
export interface DbBatchOp {
  sql: string;
  params?: any[];
}

/**
 * A table whose rows can be paid or received through a bank account, named by
 * the table itself. See the `BANK_SOURCES` block further down for what each one
 * is and why `assets` / `asset_payments` / `personal_expenses` are not in here
 * (they predate this and have their own named paths).
 */
export type BankSourceKey =
  | 'sales' | 'egg_sales' | 'hen_sales' | 'income'
  | 'expenses' | 'labour_payments' | 'purchase_orders'
  | 'receive_vouchers' | 'payment_vouchers'
  | 'expense_ledger';

/**
 * One bill a settlement landed on: how much of the payment it took, and the
 * `amount_paid` it ends up holding. Returned by `customerSettlementOps()` so a
 * caller can show or print which bills its payment actually settled.
 */
export interface CustomerAllocation {
  bill_id: number;
  payAmount: number;
  newPaid: number;
}

/**
 * What `customerSettlementOps()` hands back: the statements to run, and which
 * bills the payment landed on so a caller can print them. `unapplied` is what
 * would not fit on any bill.
 *
 * Named rather than written inline on the method for the same reason
 * `BankCascadeReversal` below is — the verify scripts lift these method bodies
 * out of this file as text, and their extractor finds a body by its first
 * brace, which an inline object return type would be.
 */
export interface CustomerSettlement {
  ops: DbBatchOp[];
  allocations: CustomerAllocation[];
  unapplied: number;
}

/**
 * The two loan headline figures. Named rather than written inline on
 * `getLoanTotals()` for the reason every interface around here is: the verify
 * scripts lift method bodies out of this file as TEXT, and their extractor
 * finds a body by its first brace — which an inline object return type is.
 */
export interface LoanTotals {
  /** Still owed TO the owner, on loans he made. */
  receivable: number;
  /** What the owner owes, on money left with him or lent to him. */
  payable: number;
  error?: string;
}

/** What `customerUnwindOps()` hands back. Named for the same reason. */
export interface CustomerUnwind {
  success: boolean;
  error?: string;
  ops?: DbBatchOp[];
}

/**
 * Which sale table an AUTO-SETTLEMENT was created from. The same three strings
 * `BANK_SOURCES` uses as the `ref` of those tables, and for the same reason an
 * id alone will not do: the three primary keys are separate AUTOINCREMENT
 * sequences that all start at 1.
 */
export type AutoSettleSource = 'broiler_sale' | 'egg_sale' | 'hen_sale';

/**
 * One flock or batch, the own-farm customer that stands for the farm unit it
 * sits in, and what that farm currently owes distribution. What a sale screen
 * needs to know before it can offer to auto-settle.
 */
export interface AutoSettleTarget {
  /** `flock_id` or `batch_id` — whichever the screen asked about. */
  owner_id: number;
  customer_id: number;
  customer_name: string;
  unit_id: number | null;
  /** The app's one definition of a debt: SUM(MAX(total_amount - amount_paid, 0)). */
  outstanding: number;
}

/**
 * What a cascade gets back when it un-makes the auto-settlements of the sales
 * it is about to delete. Named for the same reason as `BankCascadeReversal`,
 * whose shape it mirrors.
 */
export interface AutoSettleCascadeReversal {
  success: boolean;
  error?: string;
  ops?: DbBatchOp[];
}

/**
 * What `getOwnFarmDebtByOwner()` hands back. Named for the same reason as the
 * rest: an inline return type's braces are the first the verify scripts'
 * extractor meets, so it would lift the TYPE and call it the method body.
 */
export interface OwnFarmDebtLookup {
  success: boolean;
  error?: string;
  data: AutoSettleTarget[];
}

/**
 * What a sale screen's auto-settle bar offers: the amount it would settle, what
 * the farm owes in total, the account it would settle from and whose farm it
 * is. Named rather than written inline on the three identical getters for the
 * same reason as the interfaces above — the verify scripts lift those getter
 * bodies out of the components as text, and their extractor finds a body by its
 * first brace, which an inline return type would be.
 */
export interface AutoSettlePreview {
  amount: number;
  debt: number;
  /** `bankOptionLabel()` text, or 'the chosen accounts' when rows span two. */
  account: string;
  /** The own-farm customer's name, or 'your farms' when rows span two. */
  farms: string;
}

/**
 * What `buildAutoSettleOps()` hands back. Named rather than written inline on
 * the method for the same reason the interfaces above are — the verify scripts
 * lift these method bodies out of this file as text and their extractor finds a
 * body by its first brace.
 *
 * `bills` is the unpaid list WITH this settlement's allocation already applied,
 * for a caller banking several rows into one farm's debt in one save: every
 * read happens before any statement runs, so the second row would otherwise
 * allocate against the first row's stale `amount_paid`. It is the forward twin
 * of the shared `takenBack` accumulator on `customerUnwindOps()`.
 */
export interface AutoSettleResult {
  success: boolean;
  error?: string;
  ops: DbBatchOp[];
  settledAmount: number;
  /** The bills this settlement took to fully paid. For the verify script. */
  clearedBillIds: number[];
  allocations: CustomerAllocation[];
  bills: any[];
}

/**
 * The receivable one unpaid layer sale raises, as the sale's own screen
 * describes it. Named for the same reason as the interfaces above.
 */
export interface LayerSaleReceivable {
  /** 'egg_sale' or 'hen_sale' — which table the sale is in. */
  source: LayerBillSource;
  /** The farm the batch belongs to; `bills` is farm-scoped. */
  farm_id: number;
  customer_id: number;
  customer_name: string;
  date: string;
  /** The sale's full amount. A layer sale has no part-payment field. */
  amount: number;
  /**
   * The batch operation that inserted the sale, so `source_id` can be bound
   * with `{ $lastId: n }` and no id has to make a round trip. Omitted when the
   * sale's id is already known (the edit path).
   */
  saleOp?: number;
  sale_id?: number;
}

/**
 * What saving a voucher hands back. `allocations` is which bills a receive
 * voucher actually settled, so the screen can print them on it. Named for the
 * same extractor reason as the two above.
 */
export interface VoucherSaveResult {
  success: boolean;
  error?: string;
  allocations?: CustomerAllocation[];
}

/**
 * One account and what a pending save would do to it: `delta` is the SIGNED
 * change to `SUM(debit - credit)`, so money out is negative and money in
 * positive. The reversal half of an edit is a delta too — removing a credit
 * raises the balance.
 */
export interface BankDelta {
  bankId: number | null | undefined;
  delta: number;
}

/**
 * Whether a save may go ahead. `error` is already the sentence the user reads,
 * because it has to name the account and both figures and nothing above this
 * knows all three.
 */
export interface BankGuardResult {
  success: boolean;
  error?: string;
}

/**
 * What a cascade gets back: the ops to run ahead of its own deletes, or the
 * reason the accounts could not be read. Named rather than written inline on
 * `bankCascadeReversalOps` so the verify script can lift that method out of
 * this file — its extractor finds a method body by its first brace.
 */
export interface BankCascadeReversal {
  success: boolean;
  error?: string;
  ops?: DbBatchOp[];
}

declare global {
  interface Window {
    electronAPI: {
      dbRun: (sql: string, params?: any[]) => Promise<any>;
      dbGet: (sql: string, params?: any[]) => Promise<any>;
      dbRunBatch: (ops: DbBatchOp[]) => Promise<any>;
      dbBeginTransaction: () => Promise<any>;
      dbCommitTransaction: () => Promise<any>;
      dbRollbackTransaction: () => Promise<any>;
      getMachineId: () => Promise<string>;
      backupDatabase: () => Promise<any>;
      restoreDatabase: () => Promise<any>;
      getAutoBackupPath: () => Promise<string | null>;
      resetAutoBackupPath: () => Promise<any>;
    };
  }
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseService {
  async backupDatabase(): Promise<any> {
    return window.electronAPI.backupDatabase();
  }

  async restoreDatabase(): Promise<any> {
    return window.electronAPI.restoreDatabase();
  }

  async getAutoBackupPath(): Promise<string | null> {
    return window.electronAPI.getAutoBackupPath();
  }

  async resetAutoBackupPath(): Promise<any> {
    return window.electronAPI.resetAutoBackupPath();
  }

  constructor(private zone: NgZone) {}

  // ── CORE METHODS ──────────────────────────────────────────

  run(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbRun(sql, params)
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }


  get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbGet(sql, params)
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  /**
   * Runs an ordered list of statements atomically: either all of them commit or
   * none of them do, and the database file is written once instead of once per
   * statement. Use it for a run of writes with no reads in between; where a
   * later statement needs an id an earlier one inserted, reference it with
   * `{ $lastId: n }` rather than making a round trip for it.
   */
  runBatch(ops: DbBatchOp[]): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbRunBatch(ops)
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  beginTransaction(): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbBeginTransaction()
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  commitTransaction(): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbCommitTransaction()
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  rollbackTransaction(): Promise<any> {
    return new Promise((resolve, reject) => {
      window.electronAPI.dbRollbackTransaction()
        .then((res: any) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  /**
   * Runs `work` inside one database transaction. Everything it writes commits
   * together, and the database file is written once, on commit; if `work`
   * throws, the whole thing is rolled back and the error is re-thrown for the
   * caller to report.
   *
   * Reads issued inside `work` see the transaction's own uncommitted writes,
   * so a step that has to read back what an earlier step wrote still works.
   *
   * Note that run()/get() report failures as `{ success: false }` instead of
   * throwing — check those results and throw, or a failed write will pass
   * unnoticed and the transaction will commit around it.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const started = await this.beginTransaction();
    if (!started || !started.success) {
      throw new Error(friendlySqlError(started?.error, 'Could not start a database transaction'));
    }

    let result: T;
    try {
      result = await work();
    } catch (err) {
      const rolledBack = await this.rollbackTransaction();
      if (!rolledBack || !rolledBack.success) {
        console.error('Rollback failed after a transaction error:', rolledBack?.error);
      }
      throw err;
    }

    // commitTransaction() rolls back by itself if the COMMIT fails, so nothing
    // is left half-applied here either.
    const committed = await this.commitTransaction();
    if (!committed || !committed.success) {
      throw new Error(friendlySqlError(committed?.error, 'Could not commit the database transaction'));
    }

    return result;
  }

  getMachineId(): Promise<string> {
    return new Promise((resolve, reject) => {
      window.electronAPI.getMachineId()
        .then((res: string) => this.zone.run(() => resolve(res)))
        .catch((err: any) => this.zone.run(() => reject(err)));
    });
  }

  // ── BATCH METHODS ──────────────────────────────────────────

  async getBatchesByProduct(productId: number, farmId: number): Promise<any> {
    return this.get(
      `SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry,
        CASE 
          WHEN b.status = 'expired' THEN 'expired'
          WHEN julianday(b.expiry_date) - julianday('now') <= 90 AND b.quantity > 0 THEN 'expiring'
          WHEN b.quantity <= 0 THEN 'depleted'
          ELSE 'active'
        END as calculated_status
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.product_id = ? AND b.farm_id = ?
      ORDER BY b.expiry_date ASC`,
      [productId, farmId]
    );
  }

  async addBatch(batchData: {
    product_id: number;
    farm_id: number;
    batch_code?: string;
    manufacturing_date: string;
    expiry_date: string;
    quantity: number;
    purchase_price?: number;
  }): Promise<any> {
    const { product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price } = batchData;
    
    let finalBatchCode = batch_code;
    if (!finalBatchCode) {
      const result = await this.get('SELECT COUNT(*) as count FROM product_batches WHERE product_id = ?', [product_id]);
      const count = (result.success && result.data && result.data.length > 0) ? result.data[0].count + 1 : 1;
      finalBatchCode = `BATCH-${String(product_id).padStart(3, '0')}-${String(count).padStart(3, '0')}`;
    }

    const sql = `
      INSERT INTO product_batches 
      (product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `;
    
    const result = await this.run(sql, [
      product_id,
      farm_id,
      finalBatchCode,
      manufacturing_date,
      expiry_date,
      quantity,
      purchase_price || 0
    ]);

    if (result.success) {
      // The batch row and the 'purchase' row recording where its stock came
      // from are ONE write. This used to report success with only the first of
      // them done — the same silent loss the Inventory save suffered, one level
      // up: the caller is told the stock is accounted for and nothing says
      // otherwise. Both failure modes are reported now.
      //
      // Note this function is not atomic by itself: it is two run() calls, so a
      // failure here leaves the batch row behind unless the caller is inside a
      // db.transaction(). inventory, purchase-orders and sales-orders all are;
      // distribution-batch is not, and there the caller is told but the orphan
      // batch stays.
      const batchId = result.lastId;

      // `product_batches` is in PRIMARY_KEY_MAP, so a missing lastId means the
      // insert did not land the way it reported. Writing the stock-in row
      // against a null batch_id, or skipping it and calling that success, both
      // lose the stock.
      if (!batchId) {
        return {
          success: false,
          error: 'The stock batch was written but its id did not come back, so the stock-in entry could not be recorded.'
        };
      }

      const logged = await this.addBatchTransaction(
        batchId,
        product_id,
        'purchase',
        quantity,
        toLocalDateString(),
        null,
        'Initial batch addition'
      );
      if (!logged || !logged.success) {
        return {
          success: false,
          error: logged?.error || 'Could not record the stock-in entry for the new batch.'
        };
      }

      return { success: true, batch_id: batchId, batch_code: finalBatchCode };
    }

    return result;
  }

  async updateBatch(batchId: number, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.batch_code !== undefined) { fields.push('batch_code = ?'); values.push(data.batch_code); }
    if (data.manufacturing_date !== undefined) { fields.push('manufacturing_date = ?'); values.push(data.manufacturing_date); }
    if (data.expiry_date !== undefined) { fields.push('expiry_date = ?'); values.push(data.expiry_date); }
    if (data.quantity !== undefined) { fields.push('quantity = ?'); values.push(data.quantity); }
    if (data.purchase_price !== undefined) { fields.push('purchase_price = ?'); values.push(data.purchase_price); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }

    if (fields.length === 0) {
      return { success: false, error: 'No fields to update' };
    }

    values.push(batchId);
    const sql = `UPDATE product_batches SET ${fields.join(', ')} WHERE batch_id = ?`;
    return this.run(sql, values);
  }

  async deleteBatch(batchId: number): Promise<any> {
    const checkResult = await this.get('SELECT COUNT(*) as count FROM batch_transactions WHERE batch_id = ?', [batchId]);
    const hasTransactions = checkResult.success && checkResult.data && checkResult.data.length > 0 && checkResult.data[0].count > 0;

    if (hasTransactions) {
      // A soft delete must actually remove the stock, not just relabel it —
      // otherwise quantity-driven stock calculations (getTotalStock, etc.)
      // keep counting it as if nothing happened. Zero the quantity and log
      // the removal so there's still an audit trail.
      const batchResult = await this.get('SELECT product_id, quantity FROM product_batches WHERE batch_id = ?', [batchId]);
      const batch = batchResult.success && batchResult.data && batchResult.data.length > 0 ? batchResult.data[0] : null;
      const qty = batch ? Number(batch.quantity) : 0;

      const result = await this.run('UPDATE product_batches SET status = "depleted", quantity = 0 WHERE batch_id = ?', [batchId]);

      if (batch && qty > 0) {
        await this.addBatchTransaction(
          batchId,
          batch.product_id,
          'adjustment',
          qty,
          toLocalDateString(),
          null,
          'Batch deleted — stock zeroed'
        );
      }

      return result;
    } else {
      return this.run('DELETE FROM product_batches WHERE batch_id = ?', [batchId]);
    }
  }

  // 🔥 FIXED: getTotalStock - robust status checking includes NULL/empty status
  async getTotalStock(productId: number): Promise<number> {
    const result = await this.get(
      `SELECT COALESCE(SUM(quantity), 0) as total 
       FROM product_batches 
       WHERE product_id = ? 
         AND quantity > 0
         AND expiry_date >= date('now')`,
      [productId]
    );
    return result.success && result.data && result.data.length > 0 ? result.data[0].total : 0;
  }

  // 🔥 NEW: Debug method to check batch status
  async debugGetTotalStock(productId: number): Promise<any> {
    return this.get(
      `SELECT 
        batch_id,
        batch_code,
        quantity,
        status,
        expiry_date,
        julianday(expiry_date) - julianday('now') as days_until_expiry
       FROM product_batches 
       WHERE product_id = ?`,
      [productId]
    );
  }

  async getExpiringBatches(farmId: number, monthsThreshold: number = 3): Promise<any> {
    return this.get(
      `SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry,
        CAST((julianday(b.expiry_date) - julianday('now')) / 30.44 AS INTEGER) as months_until_expiry
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.farm_id = ? 
        AND b.quantity > 0
        AND julianday(b.expiry_date) - julianday('now') <= (? * 30.44)
        AND julianday(b.expiry_date) - julianday('now') > 0
      ORDER BY b.expiry_date ASC`,
      [farmId, monthsThreshold]
    );
  }

  async hasExpiringBatches(productId: number, monthsThreshold: number = 3): Promise<boolean> {
    const result = await this.get(
      `SELECT COUNT(*) as count
       FROM product_batches
       WHERE product_id = ?
         AND quantity > 0
         AND julianday(expiry_date) - julianday('now') <= (? * 30.44)
         AND julianday(expiry_date) - julianday('now') > 0`,
      [productId, monthsThreshold]
    );
    return result.success && result.data && result.data.length > 0 && result.data[0].count > 0;
  }

  /**
   * Deletes a product and the stock lots that exist only to hold it — and
   * REFUSES once the product has been transacted.
   *
   * Cost of goods sold is derived from `batch_transactions` joined to
   * `product_batches.purchase_price` (`overview.service.ts` `qDistributionCogs`,
   * and the same shape in `distribution-report.component.ts`), and bill lines
   * those draws do not cover are re-priced off the `products` row itself
   * (`productRateCte`). Deleting a sold product therefore does not just remove a
   * name from a list — it rewrites the cost side of bills already counted in
   * every report, and it does it silently. `deleteBatch()` already refuses to
   * hard-delete a single batch that has transactions for the same reason; this
   * path used to hard-delete exactly those batches from above, and orphaned
   * their transactions on top.
   *
   * What blocks a delete is any record OUTSIDE the product's own stock-keeping:
   * a bill line, a sales-return line, a purchase order, a legacy sales order, or
   * a batch movement that is not plain stock arriving ('sale', 'return',
   * 'adjustment'). What is cascaded is only the rest — the product's batches and
   * the `'purchase'` rows recording stock into them, which is bookkeeping no
   * report reads as a cost.
   *
   * The three deletes are one `runBatch` because `batch_transactions` is a child
   * of both other tables: run loose, a failure between them left transactions
   * pointing at batches that no longer existed, which is what shipped.
   */
  async deleteProduct(productId: number, farmId: number): Promise<any> {
    const res = await this.get(
      `SELECT
         (SELECT product_name FROM products
           WHERE product_id = ? AND farm_id = ?) AS product_name,
         (SELECT COUNT(*) FROM bill_items         WHERE product_id = ?) AS sold,
         (SELECT COUNT(*) FROM sales_return_items WHERE product_id = ?) AS returned,
         (SELECT COUNT(*) FROM purchase_orders    WHERE product_id = ?) AS purchased,
         (SELECT COUNT(*) FROM sales_orders       WHERE product_id = ?) AS ordered,
         (SELECT COUNT(*) FROM batch_transactions
           WHERE product_id = ? AND COALESCE(type, '') <> 'purchase') AS moved`,
      [productId, farmId, productId, productId, productId, productId, productId]
    );
    if (!res.success) return res;

    const row = res.data && res.data[0];
    if (!row || row.product_name == null) {
      return { success: false, error: 'That product no longer exists.' };
    }

    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const blockers: string[] = [];
    if (Number(row.sold) > 0) blockers.push(plural(Number(row.sold), 'bill line', 'bill lines'));
    if (Number(row.returned) > 0) blockers.push(plural(Number(row.returned), 'sales return', 'sales returns'));
    if (Number(row.purchased) > 0) blockers.push(plural(Number(row.purchased), 'purchase order', 'purchase orders'));
    if (Number(row.ordered) > 0) blockers.push(plural(Number(row.ordered), 'sales order', 'sales orders'));
    if (Number(row.moved) > 0) blockers.push(plural(Number(row.moved), 'stock movement', 'stock movements'));

    if (blockers.length > 0) {
      return {
        success: false,
        error: `"${row.product_name}" has been traded and cannot be deleted — it still has ` +
               `${blockers.join(', ')}. Deleting it would rewrite the cost of goods sold on records ` +
               `that are already in your reports. Edit the product instead, or remove those records first.`
      };
    }

    return this.runBatch([
      { sql: 'DELETE FROM batch_transactions WHERE product_id = ?', params: [productId] },
      { sql: 'DELETE FROM product_batches WHERE product_id = ?', params: [productId] },
      { sql: 'DELETE FROM products WHERE product_id = ? AND farm_id = ?', params: [productId, farmId] }
    ]);
  }

  async addBatchTransaction(
    batchId: number,
    productId: number,
    type: string,
    quantity: number,
    transactionDate: string,
    referenceId: number | null = null,
    notes: string = ''
  ): Promise<any> {
    return this.run(
      `INSERT INTO batch_transactions 
       (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [batchId, productId, type, quantity, transactionDate, referenceId, notes]
    );
  }

  async getBatchTransactions(batchId: number): Promise<any> {
    return this.get(
      `SELECT * FROM batch_transactions 
       WHERE batch_id = ? 
       ORDER BY transaction_date DESC, created_at DESC`,
      [batchId]
    );
  }

  async getBatchById(batchId: number): Promise<any> {
    const result = await this.get(
      `SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.batch_id = ?`,
      [batchId]
    );
    return result.success && result.data && result.data.length > 0 ? result.data[0] : null;
  }

  async updateBatchStatuses(): Promise<any> {
    return this.run(`
      UPDATE product_batches SET status = 'expired' 
      WHERE expiry_date < date('now') AND (status IN ('active', 'expiring') OR status IS NULL OR status = '');
      
      UPDATE product_batches SET status = 'depleted' 
      WHERE quantity <= 0 AND (status IN ('active', 'expiring') OR status IS NULL OR status = '');
      
      UPDATE product_batches SET status = 'expiring' 
      WHERE expiry_date >= date('now') 
        AND expiry_date <= date('now', '+3 months')
        AND quantity > 0
        AND (status = 'active' OR status IS NULL OR status = '');
    `, []);
  }

  async migrateExistingStock(farmId: number): Promise<any> {
    const products = await this.get(
      'SELECT product_id, product_name, current_stock, cost_price FROM products WHERE farm_id = ? AND current_stock > 0',
      [farmId]
    );
    
    if (!products.success || !products.data) {
      return { success: false, error: 'Failed to fetch products' };
    }

    let migrated = 0;
    const today = toLocalDateString();
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const expiryDate = toLocalDateString(oneYearLater);

    for (const product of products.data) {
      const checkResult = await this.get('SELECT COUNT(*) as count FROM product_batches WHERE product_id = ?', [product.product_id]);
      const hasBatches = checkResult.success && checkResult.data && checkResult.data.length > 0 && checkResult.data[0].count > 0;

      if (!hasBatches && product.current_stock > 0) {
        const batchCode = `BATCH-${String(product.product_id).padStart(3, '0')}-001`;
        
        const result = await this.run(
          `INSERT INTO product_batches 
           (product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          [product.product_id, farmId, batchCode, today, expiryDate, product.current_stock, product.cost_price || 0]
        );

        if (result.success) {
          const batchId = result.lastId;
          
          if (batchId) {
            await this.addBatchTransaction(
              batchId,
              product.product_id,
              'purchase',
              product.current_stock,
              today,
              null,
              'Migrated from existing stock'
            );
            migrated++;
          }
        }
      }
    }

    return { success: true, migrated };
  }

  // ── CUSTOMER LEDGER METHODS ──────────────────────────────

  async getCustomerLedger(customerId: number): Promise<any> {
    return this.get(
      `SELECT * FROM customer_ledger 
       WHERE customer_id = ? 
       ORDER BY transaction_date ASC, ledger_id ASC`,
      [customerId]
    );
  }

  async getCustomerLedgerWithBalance(customerId: number): Promise<any> {
    return this.get(
      `SELECT 
        l.ledger_id,
        l.customer_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.voucher_id,
        l.internal_settlement_id,
        l.created_at,
        c.customer_name,
        c.phone,
        c.address,
        (SELECT COALESCE(SUM(cl.debit - cl.credit), 0)
         FROM customer_ledger cl
         WHERE cl.customer_id = l.customer_id
           AND (
             cl.transaction_date < l.transaction_date OR
             (cl.transaction_date = l.transaction_date AND cl.ledger_id <= l.ledger_id)
           )) as balance
       FROM customer_ledger l
       INNER JOIN customers c ON l.customer_id = c.customer_id
       WHERE l.customer_id = ?
       ORDER BY l.transaction_date ASC, l.ledger_id ASC`,
      [customerId]
    );
  }

  async addCustomerLedgerEntry(entry: {
    customer_id: number;
    transaction_date: string;
    description: string;
    debit?: number;
    credit?: number;
    reference_type?: string;
    reference_id?: number;
  }): Promise<any> {
    const { customer_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id } = entry;
    
    return this.run(
      `INSERT INTO customer_ledger 
       (customer_id, transaction_date, description, debit, credit, balance, reference_type, reference_id)
       VALUES (?, ?, ?, ?, ?, 
         (SELECT COALESCE(SUM(debit - credit), 0) FROM customer_ledger WHERE customer_id = ?) + ? - ?,
         ?, ?)`,
      [customer_id, transaction_date, description, debit, credit, customer_id, debit, credit, reference_type || null, reference_id || null]
    );
  }

  /**
   * Re-derives a customer's cached balance from the bills it is owed on — the
   * customer-side twin of `rebuildBankBalanceOp`. Returned as a batch op so the
   * write that invalidated the balance and the recompute commit together;
   * `updateCustomerOutstandingBalance()` is the same statement on its own.
   */
  private rebuildCustomerBalanceOp(customerId: number): DbBatchOp {
    return {
      sql: `UPDATE customers SET outstanding_balance =
              (SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0)
               FROM bills WHERE customer_id = ?)
            WHERE customer_id = ?`,
      params: [customerId, customerId]
    };
  }

  async updateCustomerOutstandingBalance(customerId: number): Promise<any> {
    const op = this.rebuildCustomerBalanceOp(customerId);
    return this.run(op.sql, op.params);
  }

  /**
   * A customer's unpaid bills, oldest first — the allocation order every
   * settlement walks.
   *
   * The same read `customer-ledger.component.ts` has always done inline, moved
   * here SO THAT THE TWO DOORS ONTO THE SETTLEMENT CANNOT DISAGREE ABOUT WHICH
   * BILL IS OLDEST. The Receive Voucher screen settles through the same
   * `customerSettlementOps()` below, and a second copy of this read would be
   * the one place drift could reappear with neither screen looking wrong.
   *
   * No `bill_id` tiebreaker, on purpose: `ORDER BY bill_date ASC` alone is what
   * the screen has always used, and adding one would reorder same-day bills —
   * a behaviour change smuggled into what is otherwise a pure move.
   */
  async getUnpaidBills(customerId: number): Promise<any> {
    return this.get(
      `SELECT * FROM bills
       WHERE customer_id = ?
       AND (COALESCE(amount_paid, 0) < COALESCE(total_amount, 0))
       ORDER BY bill_date ASC`,
      [customerId]
    );
  }

  /**
   * THE FORWARD SETTLEMENT: money received from a customer, applied to their
   * unpaid bills. The exact counterpart of `customerUnwindOps()` below, and the
   * only implementation of it in the app.
   *
   * This was inline in `customer-ledger.component.ts`'s `submitPayment()`,
   * whose reversal was already factored out down here. The Receive Voucher
   * screen is a second door onto the same event — same FIFO allocation, same
   * `bills.amount_paid` updates, same `customer_ledger` credits, same balance
   * recompute — so it moved to sit beside the reversal rather than being
   * written twice. Two implementations would drift, and would then disagree
   * about a customer's balance with nothing on either screen to say which was
   * right.
   *
   * THE ALLOCATION. `amount` is applied oldest bill first. If `bill_id` names
   * one, it is paid first and any remainder spills FIFO across the others
   * rather than being silently discarded, so the full amount always lands on
   * real bills and matches the credit written to the ledger.
   *
   * THE TAGGING, which the reversal depends on. With a `bill_id`, ONE entry is
   * written for the whole amount tagged to that bill — a settlement entered
   * against one bill is still one statement line. Without one, a tagged entry
   * per bill actually paid. Either way `reference_id` names a real bill, so a
   * later Sales Orders bill edit (which regenerates entries by `reference_id`)
   * replaces the payment instead of leaving it double-counted.
   *
   * `bills` is passed in rather than read here: the caller already holds the
   * list it showed the user, and taking it as a parameter is what makes this
   * extraction a pure move with no behavioural delta. Use `getUnpaidBills()`.
   *
   * `voucher_id`, when given, is stamped on every entry written — the N-ary
   * link from one voucher to the several ledger rows its FIFO spill produced,
   * which is how a voucher delete finds its own rows and no others. Omitted,
   * the statement is EXACTLY the one this screen has always written, column
   * list and parameter count included; the column is appended only for a caller
   * that actually has a voucher. Nothing else reads it.
   *
   * `internal_settlement_id` is the same link for the third door,
   * `saveInternalSettlement()` — an own-farm settlement credits bills exactly
   * as a receipt does, and its delete finds its own rows the same way. The two
   * tags are mutually exclusive: a credit row is written by one door or the
   * other, so only ever one column is appended.
   *
   * Returns the ops rather than running them, so a caller can fold its own
   * writes — a voucher row, a bank entry — into the same batch. `unapplied` is
   * what would not fit on any bill; both screens refuse overpayment before
   * calling, so it should never come back above zero.
   */
  customerSettlementOps(opts: {
    customer_id: number;
    amount: number;
    date: string;
    description: string;
    bills: any[];
    bill_id?: number | null;
    voucher_id?: any;
    internal_settlement_id?: any;
  }): CustomerSettlement {
    const customerId = opts.customer_id;
    const selectedBillId = opts.bill_id || null;
    const description = opts.description;
    const paymentAmount = opts.amount;

    let remaining = paymentAmount;

    const payOrder = selectedBillId
      ? [
          ...opts.bills.filter(b => b.bill_id === selectedBillId),
          ...opts.bills.filter(b => b.bill_id !== selectedBillId)
        ]
      : opts.bills;

    const allocations: CustomerAllocation[] = [];

    for (const bill of payOrder) {
      if (remaining <= 0) break;
      const currentPaid = bill.amount_paid || 0;
      const totalAmount = bill.total_amount || 0;
      const outstanding = totalAmount - currentPaid;

      if (outstanding > 0) {
        const payAmount = Math.min(remaining, outstanding);
        allocations.push({
          bill_id: bill.bill_id,
          payAmount,
          newPaid: currentPaid + payAmount
        });
        remaining -= payAmount;
      }
    }

    // Apply the payment to the actual bill(s) — the authoritative change.
    const ops: DbBatchOp[] = allocations.map(a => ({
      sql: 'UPDATE bills SET amount_paid = ? WHERE bill_id = ?',
      params: [a.newPaid, a.bill_id]
    }));

    // ONE tagging mechanism, two possible columns. A credit row comes through
    // one door or the other — a receive voucher, or an internal settlement —
    // and never both, so they are mutually exclusive by construction here
    // rather than by convention at the call sites.
    //
    // The emitted statement is UNCHANGED for both cases that already existed:
    // `', voucher_id'` for a voucher, nothing at all for a plain payment, with
    // the same parameter array in the same order. That is what keeps this a
    // generalisation rather than a behaviour change — see
    // `verify_ledger_payment_reversal.js`, whose output must stay identical
    // across it.
    const tag = (opts.voucher_id !== undefined && opts.voucher_id !== null)
      ? { column: 'voucher_id', value: opts.voucher_id }
      : (opts.internal_settlement_id !== undefined && opts.internal_settlement_id !== null)
        ? { column: 'internal_settlement_id', value: opts.internal_settlement_id }
        : null;
    const tagged = tag !== null;

    const ledgerEntry = (credit: number, referenceId: number): DbBatchOp => ({
      sql: `INSERT INTO customer_ledger
              (customer_id, transaction_date, description, debit, credit, balance, reference_type, reference_id${tagged ? ', ' + tag!.column : ''})
              VALUES (?, ?, ?, 0, ?,
                (SELECT COALESCE(SUM(debit - credit), 0) FROM customer_ledger WHERE customer_id = ?) - ?,
                'payment', ?${tagged ? ', ?' : ''})`,
      params: tagged
        ? [customerId, opts.date, description, credit, customerId, credit, referenceId, tag!.value]
        : [customerId, opts.date, description, credit, customerId, credit, referenceId]
    });

    if (selectedBillId) {
      ops.push(ledgerEntry(paymentAmount, selectedBillId));
    } else {
      // Distributed across multiple bills — log one tagged entry per bill actually paid.
      for (const a of allocations) {
        ops.push(ledgerEntry(a.payAmount, a.bill_id));
      }
    }

    // Recompute AFTER bills are updated, since the balance is derived from
    // bills.amount_paid vs bills.total_amount.
    ops.push(this.rebuildCustomerBalanceOp(customerId));

    return { ops, allocations, unapplied: remaining };
  }

  /**
   * THE REVERSAL: `credit` put back on the bills it was applied to, newest
   * first. Extracted from `deleteCustomerLedgerEntry()` below, which still
   * calls it in its own right — this is the one implementation of the
   * direction, and the voucher delete uses it directly rather than teaching
   * that method about vouchers.
   *
   * `taggedBillId` is the bill the payment was filed against, unwound first.
   * It can hold less than the credit — a settlement entered against one bill
   * spills FIFO across the others and is still logged as one entry — so any
   * remainder comes off the customer's other paid bills newest first, undoing
   * the most recent applications before older ones. A null tag starts at that
   * same newest-first order, which is what a legacy untagged row gets.
   *
   * Each bill gives back at most what it actually holds, so no `amount_paid`
   * can be driven negative. Deliberately does NOT include the balance rebuild:
   * a caller unwinding several rows rebuilds once, after all of them.
   *
   * `takenBack` is for exactly that caller. Every read here happens before any
   * of the returned statements run, so two entries that both drew on one bill
   * would otherwise each be credited from the bill's original `amount_paid` and
   * give back more than it holds. Passing one shared accumulator across the
   * calls nets the earlier give-backs off the later ones. A single-entry caller
   * omits it and gets the arithmetic it always had.
   */
  private async customerUnwindOps(
    customerId: number,
    credit: number,
    taggedBillId: number | null,
    takenBack: { [billId: number]: number } = {}
  ): Promise<CustomerUnwind> {
    if (!(credit > 0)) return { success: true, ops: [] };

    const billsRes = await this.get(
      `SELECT bill_id, COALESCE(amount_paid, 0) AS amount_paid
       FROM bills
       WHERE customer_id = ? AND COALESCE(amount_paid, 0) > 0
       ORDER BY bill_date DESC, bill_id DESC`,
      [customerId]
    );
    if (!billsRes.success) return { success: false, error: billsRes.error };

    const bills: any[] = billsRes.data || [];
    const tagged = taggedBillId == null ? null : Number(taggedBillId);
    const unwindOrder = tagged == null
      ? bills
      : [
          ...bills.filter(b => Number(b.bill_id) === tagged),
          ...bills.filter(b => Number(b.bill_id) !== tagged)
        ];

    const ops: DbBatchOp[] = [];
    let remaining = credit;
    for (const bill of unwindOrder) {
      if (remaining <= 0) break;
      const paid = (Number(bill.amount_paid) || 0) - (takenBack[bill.bill_id] || 0);
      const takeBack = Math.min(remaining, paid);
      if (takeBack <= 0) continue;
      ops.push({
        sql: 'UPDATE bills SET amount_paid = ? WHERE bill_id = ?',
        params: [Math.round((paid - takeBack) * 100) / 100, bill.bill_id]
      });
      takenBack[bill.bill_id] = (takenBack[bill.bill_id] || 0) + takeBack;
      remaining -= takeBack;
    }

    return { success: true, ops };
  }

  /**
   * Un-makes ONE customer_ledger row: the row goes AND what it did to the bills
   * is put back, in a single batch.
   *
   * A customer's balance is not the ledger's running total — it is derived from
   * `bills` (total_amount - amount_paid), and a payment's real effect is the
   * `amount_paid` that `submitPayment()` writes. Deleting the ledger row alone
   * therefore removed the RECORD of the payment and left the MONEY applied: the
   * screen went on showing the settled balance with nothing left on it to say
   * why. Same discipline as the bank withdrawals — reverse, then rebuild, in one
   * runBatch — because the reversal spans `bills`, `customer_ledger` and
   * `customers` and a half-applied reversal is the drift this screen reports.
   *
   * Which bills to put it back on: the row's `reference_id` names the bill the
   * payment was filed against, so that one is unwound first. It can hold more
   * than that bill took — a settlement entered against one bill spills FIFO
   * across the customer's others and is still logged as one entry tagged to the
   * selected bill (see `submitPayment`) — so any remainder is unwound across the
   * customer's other paid bills, newest first, undoing the most recent
   * applications before older ones. An untagged legacy row starts at that same
   * newest-first order. Each bill gives back at most what it actually holds, so
   * no `amount_paid` can be driven negative.
   *
   * A row mirroring a BILL is refused: the debt is the bill, so removing the
   * mirror would not reduce what is owed — it would only hide it. Deleting the
   * bill is the Sales Orders path, which also restores stock and bill_items.
   * The Actions column hides the button for those; this is the same rule where
   * it cannot be bypassed.
   */
  async deleteCustomerLedgerEntry(ledgerId: number): Promise<any> {
    // Read before the batch: once the row is gone nothing says how much to put
    // back or whose balance to rebuild.
    const entryRes = await this.get(
      `SELECT ledger_id, customer_id, COALESCE(debit, 0) AS debit,
              COALESCE(credit, 0) AS credit, reference_type, reference_id, voucher_id,
              internal_settlement_id
       FROM customer_ledger WHERE ledger_id = ?`,
      [ledgerId]
    );
    if (!entryRes.success) return entryRes;

    const entry = entryRes.data && entryRes.data[0];
    if (!entry) return { success: false, error: 'That ledger entry no longer exists.' };

    if ((entry.reference_type || '') === 'bill') {
      return {
        success: false,
        error: 'This entry is the bill itself, not a payment. Delete the bill on the Sales Orders screen to cancel what is owed.'
      };
    }

    // A voucher's line is ONE SIDE of a three-part event — the bills, this
    // ledger row, and a bank deposit — and only `deleteReceiveVoucher()` can
    // un-make all three together. Removing just this row would put the money
    // back on the bills while leaving the voucher listed and its deposit
    // standing on the account, so the bank balance would go on claiming money
    // that is no longer attributed to any debt.
    //
    // This is a PRECONDITION, in the same shape as the bill refusal above — it
    // does not touch `customerUnwindOps()` or fork the reversal, which stays
    // the single implementation of the direction and is shared verbatim with
    // the voucher delete. The Actions column already hides the button for these
    // rows; this is the same rule where the template cannot be bypassed.
    if (entry.voucher_id != null) {
      return {
        success: false,
        error: 'This line belongs to a receive voucher, which also recorded a bank deposit. ' +
               'Delete it on the Receive Voucher screen so both sides are reversed together.'
      };
    }

    // The internal settlement twin of the rule above, and for the identical
    // reason: this row is one side of an event whose other sides are the bills
    // it credited and — unless both ends named the same account — a withdrawal
    // and a deposit. Only `deleteInternalSettlement()` un-makes all of them
    // together. A PRECONDITION again, not a fork: `customerUnwindOps()` stays
    // the single implementation of the reversal and is shared verbatim.
    if (entry.internal_settlement_id != null) {
      return {
        success: false,
        error: 'This line belongs to an internal settlement, which also moved money between accounts. ' +
               'Delete it on the Internal Settlement screen so every side is reversed together.'
      };
    }

    const customerId = Number(entry.customer_id);
    const credit = Number(entry.credit) || 0;

    // The give-back itself is `customerUnwindOps()` above — the one
    // implementation of this direction, shared with the voucher delete. This
    // method knows nothing about vouchers and must not learn: a voucher unwinds
    // its own rows through the same helper, so neither path can drift from the
    // other by branching here.
    const unwound = await this.customerUnwindOps(
      customerId, credit, entry.reference_id == null ? null : Number(entry.reference_id));
    if (!unwound.success) return unwound;

    const ops: DbBatchOp[] = [...(unwound.ops || [])];

    ops.push({ sql: 'DELETE FROM customer_ledger WHERE ledger_id = ?', params: [ledgerId] });
    ops.push(this.rebuildCustomerBalanceOp(customerId));

    return this.runBatch(ops);
  }

  /**
   * The supplier twin, and deliberately a much smaller thing: a supplier's
   * payable IS the ledger (`SUM(credit - debit)` in `getAllSuppliersWithBalance`
   * and `getSupplierBalance()`), with no `bills.amount_paid` equivalent behind
   * it, so removing the row IS the reversal. What this adds is the refusal of a
   * purchase row — the mirror of a purchase order, whose own screen owns it —
   * and a checked result, since `run()` reports failure in `.success`.
   */
  async deleteSupplierLedgerEntry(ledgerId: number): Promise<any> {
    const entryRes = await this.get(
      `SELECT ledger_id, reference_type, voucher_id FROM supplier_ledger WHERE ledger_id = ?`,
      [ledgerId]
    );
    if (!entryRes.success) return entryRes;

    const entry = entryRes.data && entryRes.data[0];
    if (!entry) return { success: false, error: 'That ledger entry no longer exists.' };

    if ((entry.reference_type || '') === 'purchase') {
      return {
        success: false,
        error: 'This entry is the purchase order itself, not a payment. Delete the order on the Purchase Orders screen to cancel what is owed.'
      };
    }

    // The payment voucher twin of the rule in `deleteCustomerLedgerEntry()`:
    // this row is the payable side of an event whose other side is a bank
    // withdrawal, and only `deletePaymentVoucher()` removes both.
    if (entry.voucher_id != null) {
      return {
        success: false,
        error: 'This line belongs to a payment voucher, which also recorded a bank withdrawal. ' +
               'Delete it on the Payment Voucher screen so both sides are reversed together.'
      };
    }

    return this.run('DELETE FROM supplier_ledger WHERE ledger_id = ?', [ledgerId]);
  }

  async getAllCustomersWithBalance(farmId: number): Promise<any> {
    return this.get(
      `SELECT 
        c.*,
        (SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) FROM bills WHERE customer_id = c.customer_id) as outstanding_balance
       FROM customers c
       WHERE c.farm_id = ?
       ORDER BY c.customer_name ASC`,
      [farmId]
    );
  }

  // ── SUPPLIER LEDGER METHODS ──────────────────────────────

  async getSupplierLedger(supplierId: number): Promise<any> {
    return this.get(
      `SELECT * FROM supplier_ledger 
       WHERE supplier_id = ? 
       ORDER BY transaction_date ASC, ledger_id ASC`,
      [supplierId]
    );
  }

  /**
   * A supplier's statement, every row carrying the account the money moved
   * through — or nothing, which reads as Cash.
   *
   * `supplier_ledger` has no `payment_source`/`bank_id` of its own and is not
   * getting one: it is not a `BANK_SOURCES` table, the payable is the rows
   * themselves, and a column here would be a second place for the account to
   * live. The account is therefore DERIVED from whichever row recorded the
   * movement, and there are exactly two:
   *
   *   voucher_id IS NOT NULL   a Payment Voucher — the account is on the
   *                            voucher (`payment_vouchers`), which is the one
   *                            supplier-payment door that attributes a bank
   *                            account. This is read FIRST, so a voucher line
   *                            can never be mistaken for anything else.
   *   reference_type 'purchase'
   *   AND debit > 0            an order paid at the moment it was raised —
   *                            `addToSupplierLedger()` writes ONE row carrying
   *                            both the credit and the debit, so that debit IS
   *                            the payment and its account is the order's.
   *
   * Everything else resolves NULL, which `paymentSourceLabel()` renders as
   * 'Cash': a manual payment from the Supplier Ledger screen (no account
   * anywhere), and every legacy row. There is no backfill — a row is Cash
   * precisely because no account was ever attributed to it, which is true.
   *
   * TWO GATES ON THE purchase_orders JOIN, both load-bearing:
   *
   *   - `reference_type = 'purchase'`. A purchase RETURN also carries the
   *     purchase_id in `reference_id` (`purchase-returns.component.ts`), so
   *     joining on `reference_id` alone hands the return the ORDER's account
   *     and prints a bank name against money that never moved through it.
   *   - `debit > 0`. An unpaid credit order's row moved no money, and its
   *     `purchase_orders.payment_source` describes a payment that has not
   *     happened. Claiming an account for it would show a withdrawal that is
   *     not there.
   *
   * `bank_name` is read live rather than stored, so renaming an account
   * propagates — the same reasoning as `getAssetPayments()`.
   */
  async getSupplierLedgerWithBalance(supplierId: number, farmId: number): Promise<any> {
    return this.get(
      `SELECT
        l.ledger_id,
        l.supplier_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.voucher_id,
        -- The client's own free text about the row, which is the whole reason
        -- the column exists. Payment Voucher writes it and so does this
        -- screen's own payment form, and it was then dropped HERE: this
        -- statement names its columns explicitly, so the notes the template
        -- renders and the PDF prints arrived undefined and every row showed a
        -- dash. Both of that screen's tables and its printed report read the
        -- same ledgerEntries, so this one line feeds all three.
        -- (No backticks in this comment: the statement is a template literal.)
        l.notes,
        l.created_at,
        s.supplier_name,
        s.phone,
        pv.voucher_number,
        COALESCE(pv.payment_source,
                 CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                      THEN po.payment_source END) AS payment_source,
        COALESCE(pv.bank_id,
                 CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                      THEN po.bank_id END) AS bank_id,
        COALESCE(bv.bank_name,
                 CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                      THEN bo.bank_name END) AS bank_name,
        (SELECT COALESCE(SUM(sl.credit - sl.debit), 0)
         FROM supplier_ledger sl
         WHERE sl.supplier_id = l.supplier_id
           AND (
             sl.transaction_date < l.transaction_date OR
             (sl.transaction_date = l.transaction_date AND sl.ledger_id <= l.ledger_id)
           )) as balance
       FROM supplier_ledger l
       INNER JOIN suppliers s ON l.supplier_id = s.supplier_id
       LEFT JOIN payment_vouchers pv ON pv.voucher_id = l.voucher_id
       LEFT JOIN bank_accounts bv ON bv.bank_id = pv.bank_id
       LEFT JOIN purchase_orders po
              ON COALESCE(l.reference_type,'') = 'purchase' AND po.purchase_id = l.reference_id
       LEFT JOIN bank_accounts bo ON bo.bank_id = po.bank_id
       WHERE l.supplier_id = ? AND s.farm_id = ?
       ORDER BY l.transaction_date ASC, l.ledger_id ASC`,
      [supplierId, farmId]
    );
  }

  /**
   * One `supplier_ledger` row, as a batch op so it can join a larger write.
   *
   * The supplier side of a settlement is this single statement — a supplier's
   * payable IS `SUM(credit - debit)` over this table, with no `bills.amount_paid`
   * equivalent behind it, so a debit row is the whole of "the payable went
   * down". The Payment Voucher screen therefore needs exactly this statement
   * folded into its batch, which is why it moved out of
   * `addSupplierLedgerEntry()` below rather than being written a second time.
   *
   * `voucher_id` and `notes` are each appended only for a caller that has one,
   * so a caller with neither — a purchase order's own ledger row — goes on
   * emitting the statement it always has, column list and parameter count
   * included. The two are independent, and they append in a FIXED order
   * (voucher_id, then notes) so the column list and the parameter list cannot
   * fall out of step with each other.
   *
   * `description` is what the row IS and every writer composes it. `notes` is
   * the client's own free text — the cheque number, who collected it — which
   * Payment Voucher captured and had nowhere to put until this column existed.
   */
  private supplierLedgerEntryOp(entry: {
    supplier_id: number;
    transaction_date: string;
    description: string;
    debit?: number;
    credit?: number;
    reference_type?: string;
    reference_id?: number | null;
    voucher_id?: any;
    notes?: string | null;
  }): DbBatchOp {
    const { supplier_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id } = entry;
    const voucherId = entry.voucher_id === undefined ? null : entry.voucher_id;
    const notes = entry.notes === undefined || entry.notes === null || entry.notes === ''
      ? null
      : entry.notes;

    // One entry per optional trailing column, in declaration order. Dropping
    // the absent ones keeps the no-tag statement byte-identical to the one
    // four other callers and two verify scripts already read.
    const extras: [string, any][] = [];
    if (voucherId !== null) extras.push(['voucher_id', voucherId]);
    if (notes !== null) extras.push(['notes', notes]);

    const extraCols = extras.map(([col]) => ', ' + col).join('');
    const extraVals = extras.map(() => ', ?').join('');

    return {
      sql: `INSERT INTO supplier_ledger
       (supplier_id, transaction_date, description, debit, credit, balance, reference_type, reference_id${extraCols})
       VALUES (?, ?, ?, ?, ?,
         (SELECT COALESCE(SUM(credit - debit), 0) FROM supplier_ledger WHERE supplier_id = ?) + ? - ?,
         ?, ?${extraVals})`,
      params: [
        supplier_id, transaction_date, description, debit, credit,
        supplier_id, credit, debit, reference_type || null, reference_id || null,
        ...extras.map(([, value]) => value)
      ]
    };
  }

  async addSupplierLedgerEntry(entry: {
    supplier_id: number;
    transaction_date: string;
    description: string;
    debit?: number;
    credit?: number;
    reference_type?: string;
    reference_id?: number;
    notes?: string | null;
  }): Promise<any> {
    const op = this.supplierLedgerEntryOp(entry);
    return this.run(op.sql, op.params);
  }

  /** A supplier's payable: the ledger itself, derived, never stored. */
  async getSupplierPayable(supplierId: number): Promise<any> {
    return this.get(
      `SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) AS payable
       FROM supplier_ledger WHERE supplier_id = ?`,
      [supplierId]
    );
  }

  /**
   * Every supplier with what was bought, what was paid, and what is still
   * owed — all four figures off `supplier_ledger`, the only book there is.
   *
   * `outstanding_balance` is `SUM(credit - debit)`, DERIVED on every read.
   * There is no `suppliers.outstanding_balance` and there must never be one:
   * a stored balance drifts from the rows behind it, which is the class of bug
   * the customer side was already burned by (see `deleteCustomerLedgerEntry`,
   * where the cached column has to be rebuilt by hand on every path). Here
   * there is nothing to keep in step, and that is the feature. Its subquery is
   * left exactly as it was written, because four screens and two verify
   * scripts read that figure and none of them may move.
   *
   * The other three are a decomposition OF that figure, not a second opinion
   * on it. They partition the rows, so they reconcile exactly:
   *
   *   total_purchased + other_charges - total_paid - total_returned
   *       == outstanding_balance
   *
   * How the buckets fall out of what the writers actually write:
   *
   *   total_purchased  credits on `reference_type = 'purchase'` — the mirror of
   *                    a purchase order. NOT `SUM(purchase_orders.total_amount)`:
   *                    "purchased" has to come off the same book as "paid" and
   *                    "owed", or the three do not reconcile, and an order
   *                    saved with no supplier writes no ledger row at all.
   *   other_charges    credits on anything else. Nothing writes one today; it
   *                    is carried so that a future writer which does cannot
   *                    silently unbalance the identity above.
   *   total_paid       debits EXCEPT returns. Money that actually left, whether
   *                    it left as a Payment Voucher, as a manual ledger
   *                    payment, or at the moment a cash order was raised
   *                    (`addToSupplierLedger` puts that debit on the purchase
   *                    row itself).
   *   total_returned   debits on `reference_type = 'return'`. A purchase return
   *                    reduces the payable but is STOCK SENT BACK, not money
   *                    paid. Folding it into `total_paid` — which `SUM(debit)`
   *                    over every row does — overstates what the farm paid its
   *                    supplier by every rupee ever returned, on the one screen
   *                    built to answer "how much have I paid him".
   */
  async getAllSuppliersWithBalance(farmId: number): Promise<any> {
    return this.get(
      `SELECT
        s.*,
        (SELECT COALESCE(SUM(credit - debit), 0) FROM supplier_ledger WHERE supplier_id = s.supplier_id) as outstanding_balance,
        (SELECT COALESCE(SUM(COALESCE(l.credit, 0)), 0) FROM supplier_ledger l
          WHERE l.supplier_id = s.supplier_id AND COALESCE(l.reference_type,'') = 'purchase') as total_purchased,
        (SELECT COALESCE(SUM(COALESCE(l.credit, 0)), 0) FROM supplier_ledger l
          WHERE l.supplier_id = s.supplier_id AND COALESCE(l.reference_type,'') <> 'purchase') as other_charges,
        (SELECT COALESCE(SUM(COALESCE(l.debit, 0)), 0) FROM supplier_ledger l
          WHERE l.supplier_id = s.supplier_id AND COALESCE(l.reference_type,'') <> 'return') as total_paid,
        (SELECT COALESCE(SUM(COALESCE(l.debit, 0)), 0) FROM supplier_ledger l
          WHERE l.supplier_id = s.supplier_id AND COALESCE(l.reference_type,'') = 'return') as total_returned
       FROM suppliers s
       WHERE s.farm_id = ?
       ORDER BY s.supplier_name ASC`,
      [farmId]
    );
  }

  /**
   * What was paid to suppliers, grouped by the account it was paid from —
   * "kis bank ki hai payment kitni". One row per account, plus one for cash.
   *
   * Same derivation as `getSupplierLedgerWithBalance()` above, including both
   * gates on the `purchase_orders` join, and the same exclusion of returns:
   * this counts money that left, so a return credit-note is not in it.
   *
   * Scoped on `suppliers.farm_id` rather than on the voucher's or the order's
   * own `farm_id`, because the ledger row belongs to the party: that is the
   * one scope that cannot disagree with the payable it is reconciled against.
   * `supplierId` narrows it to one supplier for their own statement.
   */
  async getSupplierPaymentsByAccount(farmId: number, supplierId?: number | null): Promise<any> {
    const scoped = Number(supplierId) || null;
    // Resolved per row in the inner SELECT, grouped in the outer one.
    //
    // NOT grouped directly on the aliases: `payment_source`, `bank_id` and
    // `bank_name` each name a real column on two or more of the joined tables
    // (`payment_vouchers`, `purchase_orders`, `bank_accounts`), so SQLite
    // resolves `GROUP BY payment_source` against those rather than the result
    // column and fails with "ambiguous column name" — at runtime, inside a
    // `.success: false` that a screen would render as simply no data.
    return this.get(
      `SELECT payment_source, bank_id, bank_name,
              COUNT(*) AS payment_count,
              COALESCE(SUM(amount), 0) AS total_paid
       FROM (
         SELECT
           COALESCE(pv.payment_source,
                    CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                         THEN po.payment_source END, 'cash') AS payment_source,
           COALESCE(pv.bank_id,
                    CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                         THEN po.bank_id END) AS bank_id,
           COALESCE(bv.bank_name,
                    CASE WHEN COALESCE(l.reference_type,'') = 'purchase' AND COALESCE(l.debit, 0) > 0
                         THEN bo.bank_name END) AS bank_name,
           COALESCE(l.debit, 0) AS amount
         FROM supplier_ledger l
         INNER JOIN suppliers s ON s.supplier_id = l.supplier_id
         LEFT JOIN payment_vouchers pv ON pv.voucher_id = l.voucher_id
         LEFT JOIN bank_accounts bv ON bv.bank_id = pv.bank_id
         LEFT JOIN purchase_orders po
                ON COALESCE(l.reference_type,'') = 'purchase' AND po.purchase_id = l.reference_id
         LEFT JOIN bank_accounts bo ON bo.bank_id = po.bank_id
         WHERE s.farm_id = ?
           AND (? IS NULL OR l.supplier_id = ?)
           AND COALESCE(l.debit, 0) > 0
           AND COALESCE(l.reference_type,'') <> 'return'
       )
       GROUP BY payment_source, bank_id, bank_name
       ORDER BY total_paid DESC`,
      [farmId, scoped, scoped]
    );
  }

  // ── BANK LEDGER METHODS ──────────────────────────────────
  //
  // `bank_accounts.customer_id` is what splits this one table between the two
  // screens that read it:
  //
  //   customer_id IS NOT NULL   a CUSTOMER's account — Distribution > Bank Ledger
  //   customer_id IS NULL       one of the owner's OWN (house) accounts —
  //                             Overview > Bank, and the only accounts an asset
  //                             payment may be drawn from
  //
  // The column has always been nullable; only the save path insisted on a
  // customer. Callers that want one side pass `scope`; callers that genuinely
  // want every account on the farm (the Account Ledger dashboard's total) leave
  // it off.

  async getBankAccounts(farmId: number, scope?: 'house' | 'customer'): Promise<any> {
    const scopeClause =
      scope === 'house' ? ' AND ba.customer_id IS NULL'
      : scope === 'customer' ? ' AND ba.customer_id IS NOT NULL'
      : '';
    return this.get(
      `SELECT
        ba.*,
        c.customer_name
       FROM bank_accounts ba
       LEFT JOIN customers c ON ba.customer_id = c.customer_id
       WHERE ba.farm_id = ?${scopeClause}
       ORDER BY ba.bank_name ASC`,
      [farmId]
    );
  }

  /**
   * The owner's own accounts — the only ones an asset payment, or any other
   * money the owner actually pays out, may be drawn from. A customer's account
   * holds the customer's money; buying a tractor out of it would be recorded as
   * that customer withdrawing the cash.
   */
  async getHouseBankAccounts(farmId: number): Promise<any> {
    return this.getBankAccounts(farmId, 'house');
  }

  async getBankAccount(bankId: number): Promise<any> {
    const result = await this.get(
      `SELECT 
        ba.*,
        c.customer_name
       FROM bank_accounts ba
       LEFT JOIN customers c ON ba.customer_id = c.customer_id
       WHERE ba.bank_id = ?`,
      [bankId]
    );
    return result.success && result.data && result.data.length > 0 ? result.data[0] : null;
  }

  /**
   * `customer_id` is optional: omitted (or null) this creates one of the
   * owner's own house accounts, which belongs to no customer and is therefore
   * never linked back onto a `customers` row.
   */
  async addBankAccount(account: {
    farm_id: number;
    customer_id?: number | null;
    bank_name: string;
    account_number?: string;
    account_holder?: string;
    opening_balance?: number;
  }): Promise<any> {
    const { farm_id, customer_id, bank_name, account_number, account_holder, opening_balance = 0 } = account;

    const result = await this.run(
      `INSERT INTO bank_accounts
       (farm_id, customer_id, bank_name, account_number, account_holder, opening_balance, current_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [farm_id, customer_id || null, bank_name, account_number || null, account_holder || null, opening_balance, opening_balance]
    );

    if (result.success && result.lastId && opening_balance > 0) {
      await this.addBankLedgerEntry({
        bank_id: result.lastId,
        transaction_date: toLocalDateString(),
        description: 'Opening Balance',
        debit: opening_balance,
        credit: 0,
        reference_type: 'opening',
        reference_id: null
      });
    }

    if (result.success && result.lastId && customer_id) {
      await this.linkCustomerToBank(customer_id, result.lastId);
    }

    return result;
  }

  async updateBankAccount(bankId: number, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.bank_name !== undefined) { fields.push('bank_name = ?'); values.push(data.bank_name); }
    if (data.account_number !== undefined) { fields.push('account_number = ?'); values.push(data.account_number); }
    if (data.account_holder !== undefined) { fields.push('account_holder = ?'); values.push(data.account_holder); }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };

    values.push(bankId);
    const sql = `UPDATE bank_accounts SET ${fields.join(', ')} WHERE bank_id = ?`;
    return this.run(sql, values);
  }

  /**
   * Deletes an account and its whole ledger, refusing while anything still
   * points at it.
   *
   * Foreign keys are declared but never enforced here, so nothing stops either
   * half of this by itself: dropping the account alone strands its `bank_ledger`
   * rows (invisible, but still summed by anything that groups the table), and
   * dropping it while an asset payment names it leaves that payment claiming to
   * have come out of an account that no longer exists — the withdrawal
   * disappears from every balance while the money still counts as paid. So the
   * references are checked first and the two deletes go in one batch.
   */
  async deleteBankAccount(bankId: number): Promise<any> {
    // Every table in BANK_SOURCES blocks the delete too, on the same reasoning:
    // the row still claims the money moved through this account, so dropping the
    // account would erase the entry and leave the claim standing. A record only
    // blocks while it is actually bank-sourced — payment_source = 'bank' — so a
    // legacy row that merely has a stale bank_id and no entry does not.
    const sourced = Object.entries(DatabaseService.BANK_SOURCES);
    const sourceCounts = sourced
      .map(([key, s]) =>
        `(SELECT COUNT(*) FROM ${s.table} WHERE bank_id = ? AND payment_source = 'bank') AS ${key}_count`)
      .join(',\n         ');

    const refs = await this.get(
      `SELECT
         (SELECT COUNT(*) FROM assets            WHERE bank_id = ?) AS asset_count,
         (SELECT COUNT(*) FROM asset_payments    WHERE bank_id = ?) AS payment_count,
         (SELECT COUNT(*) FROM personal_expenses WHERE bank_id = ?) AS personal_count,
         (SELECT COUNT(*) FROM customers         WHERE bank_id = ?) AS customer_count,
         (SELECT COUNT(*) FROM loans
           WHERE bank_id = ? AND payment_source = 'bank') AS loan_count,
         (SELECT COUNT(*) FROM loan_payments
           WHERE bank_id = ? AND payment_source = 'bank') AS loan_payment_count,
         (SELECT COUNT(*) FROM internal_settlements
           WHERE (from_account = 'bank' AND from_bank_id = ?)
              OR (to_account   = 'bank' AND to_bank_id   = ?)) AS settlement_count,
         (SELECT COUNT(*) FROM bills
           WHERE payment_account_kind = 'house' AND payment_source = 'bank'
             AND bank_id = ?) AS bill_count,
         ${sourceCounts}`,
      [bankId, bankId, bankId, bankId, bankId, bankId, bankId, bankId, bankId,
       ...sourced.map(() => bankId)]
    );
    if (!refs.success) return refs;

    const row = (refs.data && refs.data[0]) || {};
    const parts: string[] = [];
    const paymentCount = Number(row.payment_count || 0);
    const assetCount = Number(row.asset_count || 0);
    const personalCount = Number(row.personal_count || 0);
    const customerCount = Number(row.customer_count || 0);
    if (paymentCount > 0) parts.push(`${paymentCount} asset payment(s)`);
    else if (assetCount > 0) parts.push(`${assetCount} asset(s)`);
    if (personalCount > 0) parts.push(`${personalCount} personal expense(s)`);
    if (customerCount > 0) parts.push(`${customerCount} customer(s)`);
    // Not a BANK_SOURCES table, so it is counted by hand — but the reasoning is
    // the same one: the settlement still claims the money moved through this
    // account, and dropping the account would erase its entry while the claim
    // stood. Either end counts, and a settlement whose ends are the same
    // account wrote no entry at all yet still names it.
    const settlementCount = Number(row.settlement_count || 0);
    if (settlementCount > 0) parts.push(`${settlementCount} internal settlement(s)`);
    // Also hand-counted, and also not BANK_SOURCES tables — the direction of a
    // loan's movement is a property of the row, not of the table, so they take
    // the named-path shape (see LOAN_REF). Same reasoning as above: the row
    // still claims the money moved through this account.
    const loanCount = Number(row.loan_count || 0);
    const loanPaymentCount = Number(row.loan_payment_count || 0);
    if (loanCount > 0) parts.push(`${loanCount} loan(s)`);
    if (loanPaymentCount > 0) parts.push(`${loanPaymentCount} loan payment(s)`);
    // Also hand-counted, and also not a BANK_SOURCES table — see the block
    // above `BILL_PAYMENT_IN_REF` for why `bills` cannot be one. Only the HOUSE
    // half is counted here: a deposit-paid bill moved the customer's own money,
    // and that account is already blocked by the `customers` count above, which
    // is what links a deposit account to its customer in the first place.
    const billCount = Number(row.bill_count || 0);
    if (billCount > 0) parts.push(`${billCount} bill payment(s)`);

    const SOURCE_LABELS: Record<string, string> = {
      sales: 'broiler sale(s)',
      egg_sales: 'egg sale(s)',
      hen_sales: 'hen sale(s)',
      income: 'income entr(ies)',
      expenses: 'expense(s)',
      labour_payments: 'labour payment(s)',
      purchase_orders: 'purchase order(s)',
      receive_vouchers: 'receive voucher(s)',
      payment_vouchers: 'payment voucher(s)',
      expense_ledger: 'distribution expense(s)'
    };
    for (const [key] of sourced) {
      const n = Number(row[`${key}_count`] || 0);
      if (n > 0) parts.push(`${n} ${SOURCE_LABELS[key] || key}`);
    }

    if (parts.length > 0) {
      return {
        success: false,
        error: `Cannot delete this bank account — ${parts.join(', ')} went through it. ` +
               'Deleting it would erase those entries while the records still count as settled.'
      };
    }

    return this.runBatch([
      { sql: 'DELETE FROM bank_ledger WHERE bank_id = ?', params: [bankId] },
      { sql: 'DELETE FROM bank_accounts WHERE bank_id = ?', params: [bankId] }
    ]);
  }

  async getBankLedger(bankId: number): Promise<any> {
    return this.get(
      `SELECT * FROM bank_ledger 
       WHERE bank_id = ? 
       ORDER BY transaction_date ASC, ledger_id ASC`,
      [bankId]
    );
  }

  async getBankLedgerWithBalance(bankId: number): Promise<any> {
    return this.get(
      `SELECT 
        l.ledger_id,
        l.bank_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.transaction_number,
        l.created_at,
        b.bank_name,
        b.account_number,
        (SELECT COALESCE(SUM(bl.debit - bl.credit), 0)
         FROM bank_ledger bl
         WHERE bl.bank_id = l.bank_id
           AND (
             bl.transaction_date < l.transaction_date OR
             (bl.transaction_date = l.transaction_date AND bl.ledger_id <= l.ledger_id)
           )) as balance
       FROM bank_ledger l
       INNER JOIN bank_accounts b ON l.bank_id = b.bank_id
       WHERE l.bank_id = ?
       ORDER BY l.transaction_date ASC, l.ledger_id ASC`,
      [bankId]
    );
  }
// ── BANK LEDGER ENTRY ──────────────────────────────────────

/**
 * Writes one bank_ledger row and re-derives the account's cached
 * `current_balance` from the ledger — both in a single batch.
 *
 * This used to be a read, then two separate `run()` calls with the second one
 * unchecked. Three things were wrong with that, all of them breaking the
 * invariant that `bank_accounts.current_balance` equals SUM(debit - credit)
 * over its own ledger:
 *
 *   - the two writes were not atomic, so a failure between them left a ledger
 *     row the cached balance did not know about;
 *   - the balance UPDATE's result was discarded, so that failure was silent;
 *   - the new balance was computed in JS from a value read BEFORE the insert,
 *     which is stale the moment anything else writes to the same account.
 *
 * The balance is now computed inside the statement with `bankBalanceSql()` and
 * the cached figure rebuilt with `rebuildBankBalanceOp()` — the same two
 * helpers the asset-payment and personal-expense paths use, so all the
 * bank-touching code now agrees on how a balance is arrived at.
 *
 * A `runBatch` issued inside an open transaction becomes a SAVEPOINT, so the
 * callers that run this inside `db.transaction()` still compose.
 */
async addBankLedgerEntry(entry: {
  bank_id: number;
  transaction_date: string;
  description: string;
  debit?: number;
  credit?: number;
  reference_type?: string;
  reference_id?: number | null;
  transaction_number?: string;
}): Promise<any> {
  const { bank_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id, transaction_number } = entry;

  const result = await this.runBatch([
    {
      sql: `INSERT INTO bank_ledger
            (bank_id, transaction_date, description, debit, credit, balance, reference_type, reference_id, transaction_number)
            VALUES (?, ?, ?, ?, ?, ${this.bankBalanceSql()} + ? - ?, ?, ?, ?)`,
      params: [bank_id, transaction_date, description, debit, credit,
               bank_id, debit, credit,
               reference_type || null, reference_id || null, transaction_number || null]
    },
    this.rebuildBankBalanceOp(bank_id)
  ]);

  if (!result?.success) return result;

  // Keep the old contract: callers expect `lastId` to be the ledger row's id.
  // runBatch reports the LAST statement's id, which here is the balance UPDATE.
  return { success: true, lastId: result.results?.[0]?.lastId ?? null };
}

  // ── CUSTOMER BANK ACCOUNT METHODS ──────────────────────────

  async getCustomerBankAccount(customerId: number): Promise<any> {
    return this.get(
      `SELECT ba.* 
       FROM bank_accounts ba
       INNER JOIN customers c ON c.bank_id = ba.bank_id
       WHERE c.customer_id = ?`,
      [customerId]
    );
  }

  async getCustomerBankBalance(customerId: number): Promise<number> {
    const result = await this.get(
      `SELECT ba.current_balance 
       FROM bank_accounts ba
       INNER JOIN customers c ON c.bank_id = ba.bank_id
       WHERE c.customer_id = ?`,
      [customerId]
    );
    return result.success && result.data && result.data.length > 0 ? result.data[0].current_balance : 0;
  }

  async deductCustomerBank(customerId: number, amount: number, description: string): Promise<any> {
    const bankResult = await this.getCustomerBankAccount(customerId);
    if (!bankResult.success || !bankResult.data || bankResult.data.length === 0) {
      return { success: false, error: 'Customer has no bank account' };
    }
    
    const bank = bankResult.data[0];
    
    return this.addBankLedgerEntry({
      bank_id: bank.bank_id,
      transaction_date: toLocalDateString(),
      description: description,
      debit: 0,
      credit: amount,
      reference_type: 'payment',
      reference_id: null
    });
  }

  async linkCustomerToBank(customerId: number, bankId: number): Promise<any> {
    return this.run(
      `UPDATE customers SET bank_id = ? WHERE customer_id = ?`,
      [bankId, customerId]
    );
  }

  async getCustomersWithBankAccounts(farmId: number): Promise<any> {
    return this.get(
      `SELECT 
        c.*,
        ba.bank_id,
        ba.bank_name,
        ba.current_balance
       FROM customers c
       LEFT JOIN bank_accounts ba ON c.bank_id = ba.bank_id
       WHERE c.farm_id = ?
       ORDER BY c.customer_name ASC`,
      [farmId]
    );
  }

  // ── EXPENSE LEDGER METHODS ──────────────────────────────────

  async getExpenses(farmId: number, startDate?: string, endDate?: string): Promise<any> {
    let sql = 'SELECT * FROM expense_ledger WHERE farm_id = ?';
    const params: any[] = [farmId];
    if (startDate && endDate) {
      sql += ' AND transaction_date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    }
    sql += ' ORDER BY transaction_date DESC';
    return this.get(sql, params);
  }

  /**
   * A DISTRIBUTION expense, and the bank withdrawal for it when it was paid out
   * of an account.
   *
   * `expense_ledger` is the tenth `BANK_SOURCES` table. It offered the user a
   * payment type long before it could record WHICH account paid, so a bank
   * expense moved nothing and the recorded balance drifted from the real one —
   * which is exactly what the client noticed. The entry, the overdraw guard and
   * the balance rebuild are the same mechanism the other nine use.
   *
   * `payment_type` here is 'cash' (paid) vs 'credit' (unpaid) — a SETTLEMENT
   * STATUS, the `purchase_orders` shape, not a source. So the caller passes
   * `payment_source`/`bank_id` as their own pair, and an unpaid expense carries
   * no entry whatever that pair says.
   */
  async addExpense(expense: {
    farm_id: number;
    transaction_date: string;
    description: string;
    amount: number;
    category?: string;
    payment_type?: string;
    notes?: string;
    payment_source?: string | null;
    bank_id?: number | null;
  }): Promise<any> {
    const { farm_id, transaction_date, description, amount, category, payment_type, notes } = expense;
    const amt = Number(amount) || 0;

    // Refused BEFORE the batch, so a refusal leaves nothing to roll back.
    const guard = await this.checkBankSourceInserts('expense_ledger', [
      { payment_source: expense.payment_source, bank_id: expense.bank_id, amount: amt }
    ]);
    if (!guard.success) return guard;

    const insert: DbBatchOp = {
      sql: `INSERT INTO expense_ledger
       (farm_id, transaction_date, description, amount, category, payment_type, notes, payment_source, bank_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [farm_id, transaction_date, description, amt, category || null,
               payment_type || 'cash', notes || null,
               expense.payment_source || 'cash', expense.bank_id ?? null]
    };

    const entry = this.bankSourceInsertOps('expense_ledger', {
      payment_source: expense.payment_source,
      bank_id: expense.bank_id,
      date: transaction_date,
      description: `Expense - ${description}`,
      amount: amt
    });

    // Nothing banked: ONE statement, so `lastId` still comes back the way every
    // caller of this method has always read it.
    if (entry.length === 0) return this.run(insert.sql, insert.params);

    return this.runBatch([
      insert,
      ...entry,
      ...this.bankRebuildOps([this.bankIdOf(expense.payment_source, expense.bank_id)])
    ]);
  }

  /**
   * Editing one. The withdrawal is reversed and re-posted through the one
   * shared implementation, so all five transitions (amount, date, cash to bank,
   * bank to cash, bank A to bank B) are covered by the same shape every other
   * bank-sourced screen gets.
   *
   * A partial update still has to produce a complete entry, so the fields the
   * entry needs - date, description, amount - fall back to the row's current
   * values, exactly as `updatePersonalExpense()` does. Naming only `bank_id`
   * means "move the account", not "make it cash".
   */
  async updateExpense(expenseId: number, data: any): Promise<any> {
    const current = await this.get(
      'SELECT * FROM expense_ledger WHERE expense_id = ?', [expenseId]);
    if (!current.success) return current;
    if (!current.data || current.data.length === 0) {
      return { success: false, error: 'Expense not found' };
    }
    const row = current.data[0];

    const fields: string[] = [];
    const values: any[] = [];

    if (data.transaction_date !== undefined) { fields.push('transaction_date = ?'); values.push(data.transaction_date); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.amount !== undefined) { fields.push('amount = ?'); values.push(data.amount); }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
    if (data.payment_type !== undefined) { fields.push('payment_type = ?'); values.push(data.payment_type); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.payment_source !== undefined) { fields.push('payment_source = ?'); values.push(data.payment_source); }
    if (data.bank_id !== undefined) { fields.push('bank_id = ?'); values.push(data.bank_id); }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };
    values.push(expenseId);

    const update: DbBatchOp = {
      sql: `UPDATE expense_ledger SET ${fields.join(', ')} WHERE expense_id = ?`,
      params: values
    };

    const nextSource = data.payment_source !== undefined ? data.payment_source : row.payment_source;
    const nextBank   = data.bank_id !== undefined ? data.bank_id : row.bank_id;
    const nextDate   = data.transaction_date !== undefined ? data.transaction_date : row.transaction_date;
    const nextDesc   = data.description !== undefined ? data.description : row.description;
    const nextAmount = data.amount !== undefined ? data.amount : row.amount;

    return this.saveBankSourceEdit('expense_ledger', expenseId, update, {
      payment_source: nextSource,
      bank_id: nextBank,
      date: nextDate,
      description: `Expense - ${nextDesc}`,
      amount: Number(nextAmount) || 0
    });
  }

  /** The row and its withdrawal go together, or neither does. */
  async deleteExpense(expenseId: number): Promise<any> {
    return this.deleteBankSourced('expense_ledger', expenseId, [
      { sql: 'DELETE FROM expense_ledger WHERE expense_id = ?', params: [expenseId] }
    ]);
  }

  async getExpenseCategories(farmId: number): Promise<any> {
    return this.get(
      `SELECT category, SUM(amount) as total, COUNT(*) as count
       FROM expense_ledger
       WHERE farm_id = ?
       GROUP BY category
       ORDER BY total DESC`,
      [farmId]
    );
  }

// ── CATEGORY METHODS ──────────────────────────────────

async getCategories(farmId: number, type: string = 'product'): Promise<any> {
  return this.get('SELECT * FROM categories WHERE farm_id = ? AND category_type = ? ORDER BY category_name ASC', [farmId, type]);
}

async addCategory(farmId: number, categoryName: string, type: string = 'product'): Promise<any> {
  return this.run('INSERT INTO categories (farm_id, category_name, category_type) VALUES (?, ?, ?)', [farmId, categoryName.toLowerCase().trim(), type]);
}

async deleteCategory(categoryId: number): Promise<any> {
  return this.run('DELETE FROM categories WHERE category_id = ?', [categoryId]);
}

  // 🔥 NEW: Force update batch statuses for a specific product
  async forceUpdateBatchStatuses(productId: number): Promise<any> {
    return this.run(`
      UPDATE product_batches 
      SET status = 'expired' 
      WHERE product_id = ? AND expiry_date < date('now') 
        AND (status IN ('active', 'expiring') OR status IS NULL OR status = '');
      
      UPDATE product_batches 
      SET status = 'depleted' 
      WHERE product_id = ? AND quantity <= 0 
        AND (status IN ('active', 'expiring') OR status IS NULL OR status = '');
      
      UPDATE product_batches 
      SET status = 'expiring' 
      WHERE product_id = ? 
        AND expiry_date >= date('now') 
        AND expiry_date <= date('now', '+3 months')
        AND quantity > 0
        AND (status = 'active' OR status IS NULL OR status = '');
    `, [productId, productId, productId]);
  }

  // 🔥 NEW: Get all batches with their calculated status
  async getAllBatchesWithStatus(farmId: number): Promise<any> {
    return this.get(
      `SELECT 
        b.*,
        p.product_name,
        CASE 
          WHEN b.status = 'expired' THEN 'expired'
          WHEN julianday(b.expiry_date) - julianday('now') <= 90 AND b.quantity > 0 THEN 'expiring'
          WHEN b.quantity <= 0 THEN 'depleted'
          WHEN b.status IS NULL OR b.status = '' THEN 'active'
          ELSE b.status
        END as calculated_status
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.farm_id = ?
      ORDER BY p.product_name ASC, b.expiry_date ASC`,
      [farmId]
    );
  }

  // ── FARM UNIT METHODS ──────────────────────────────────────
  // "Farm" in the UI. `farms` is the login account, so the physical-site level
  // is farm_units. Everything here routes through run()/get(), so preload.js
  // needs no new bridge method.

  async getFarmUnits(farmId: number, moduleType?: string): Promise<any> {
    let sql = 'SELECT * FROM farm_units WHERE farm_id = ?';
    const params: any[] = [farmId];
    if (moduleType) {
      sql += ' AND module_type = ?';
      params.push(moduleType);
    }
    sql += ' ORDER BY unit_name ASC';
    return this.get(sql, params);
  }

  async addFarmUnit(unit: {
    farm_id: number;
    module_type: string;
    unit_name: string;
    location?: string;
    notes?: string;
    status?: string;
    opening_balance?: number;
  }): Promise<any> {
    const { farm_id, module_type, unit_name, location, notes, status, opening_balance } = unit;
    if (!farm_id || !module_type || !unit_name) {
      return { success: false, error: 'farm_id, module_type and unit_name are required' };
    }
    return this.run(
      `INSERT INTO farm_units (farm_id, module_type, unit_name, location, notes, status, opening_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [farm_id, module_type, unit_name, location || null, notes || null, status || 'active', opening_balance || 0]
    );
  }

  async updateFarmUnit(unitId: number, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.unit_name !== undefined) { fields.push('unit_name = ?'); values.push(data.unit_name); }
    if (data.location !== undefined) { fields.push('location = ?'); values.push(data.location); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.module_type !== undefined) { fields.push('module_type = ?'); values.push(data.module_type); }
    if (data.opening_balance !== undefined) { fields.push('opening_balance = ?'); values.push(data.opening_balance); }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };

    values.push(unitId);
    return this.run(`UPDATE farm_units SET ${fields.join(', ')} WHERE unit_id = ?`, values);
  }

  async deleteFarmUnit(unitId: number): Promise<any> {
    // Foreign keys are declared but never enforced in this database, so this
    // check is the only thing preventing flocks/batches from being orphaned.
    const flockCheck = await this.get('SELECT COUNT(*) AS count FROM flocks WHERE unit_id = ?', [unitId]);
    if (!flockCheck.success) return flockCheck;
    const batchCheck = await this.get('SELECT COUNT(*) AS count FROM batches WHERE unit_id = ?', [unitId]);
    if (!batchCheck.success) return batchCheck;

    const flockCount = flockCheck.data?.[0]?.count ?? 0;
    const batchCount = batchCheck.data?.[0]?.count ?? 0;

    if (flockCount > 0 || batchCount > 0) {
      const parts: string[] = [];
      if (flockCount > 0) parts.push(`${flockCount} flock(s)`);
      if (batchCount > 0) parts.push(`${batchCount} batch(es)`);
      return {
        success: false,
        error: `Cannot delete this farm — ${parts.join(' and ')} still assigned to it. Move or delete them first.`
      };
    }

    return this.run('DELETE FROM farm_units WHERE unit_id = ?', [unitId]);
  }

  // ── ASSET PAYMENTS AGAINST A BANK ACCOUNT ───────────────────
  //
  // Money the owner pays out by bank — an asset installment, a personal expense
  // — LEFT a bank account, and it has to show up as a withdrawal in that
  // account's ledger. It used not to: `payment_source = 'bank'` and `bank_id`
  // were written and nothing else happened, so the recorded balance climbed
  // while the real one fell, and the figure had to be pulled off the Overview
  // dashboard rather than shown wrong.
  //
  // Every path below that writes a bank-sourced row therefore writes a matching
  // `bank_ledger` credit in the SAME batch, and every path that removes or
  // changes one adjusts the ledger and rebuilds the balance in the same batch.
  // The link is `reference_type` + `reference_id` = the source row's primary
  // key, which is what lets a reversal find its entry.
  //
  // The invariant, in one line: for every row with `payment_source = 'bank'` in
  // either table there is exactly one `bank_ledger` row carrying that table's
  // reference_type and that row's id, and every `bank_accounts.current_balance`
  // equals SUM(debit - credit) over its own ledger.
  //
  // `scripts/verify/verify_bank_withdrawals.js` asserts all of it, after
  // every single mutation, against real source.

  /** Marks a bank_ledger row as the mirror of one asset installment. */
  private static readonly ASSET_PAYMENT_REF = 'asset_payment';

  /** Marks a bank_ledger row as the mirror of one personal expense. */
  private static readonly PERSONAL_EXPENSE_REF = 'personal_expense';

  /**
   * Marks a bank_ledger row as the PROCEEDS of one asset sale — money IN, so a
   * debit and a `DEP-` number.
   *
   * A separate type from ASSET_PAYMENT_REF even though both hang off an asset,
   * for the reason the two internal-settlement types are separate: every
   * reversal here reads `bank_ledger` by `(reference_type, reference_id)`, and
   * an asset's payments and its sale would otherwise come back together with
   * opposite signs and nothing to tell them apart. The reference_id is the
   * ASSET's id — an asset is sold once, so one entry per asset.
   */
  private static readonly ASSET_SALE_REF = 'asset_sale';

  /**
   * LOANS AND ADVANCES. Two reference types, one per table, NOT one per
   * direction — because the direction is a property of the LOAN, not of the
   * mechanism, and every reversal reads `bank_ledger` by
   * `(reference_type, reference_id)`.
   *
   * That lookup stays unambiguous with two: `loans.loan_id` and
   * `loan_payments.payment_id` are separate AUTOINCREMENT sequences that both
   * start at 1, so an id alone would be ambiguous between them — the same
   * collision `bills.source`/`source_id` solves — but a type each keeps every
   * pair unique. Within one type there is exactly one entry per row, which is
   * what makes a reversal a single DELETE.
   *
   * This is why loans are NOT a `BANK_SOURCES` table: that mechanism declares
   * ONE direction per table, and here the direction flips per row. Lending
   * money out is a withdrawal; being lent money is a deposit; and the
   * repayments run the opposite way again. Same shape as `assets` and
   * `internal_settlements`, which are named paths for the same reason.
   */
  private static readonly LOAN_REF = 'loan';
  private static readonly LOAN_PAYMENT_REF = 'loan_payment';

  /**
   * The two halves of one internal settlement: money out of the account the
   * farm paid FROM, money into the account distribution received it INTO.
   *
   * TWO reference_types rather than one, because every reversal in this file
   * reads `bank_ledger` by `(reference_type, reference_id)` and both halves
   * carry the same `settlement_id`. One shared type would make that lookup
   * return two rows of opposite sign with nothing to tell them apart, and the
   * "exactly one entry per source row" invariant unstateable. With two, each
   * pair is unique, each half is identifiable, and the existing
   * `idx_bank_ledger_reference` index serves both.
   */
  private static readonly INTERNAL_SETTLEMENT_OUT_REF = 'internal_settlement_out';
  private static readonly INTERNAL_SETTLEMENT_IN_REF = 'internal_settlement_in';

  /**
   * A running-balance expression, computed inside the statement rather than
   * read first, because a `runBatch` cannot take a read between its writes.
   * Consumes ONE `?` (bank_id).
   */
  private bankBalanceSql(): string {
    return `(SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl WHERE bl.bank_id = ?)`;
  }

  /**
   * The next `WD-####` / `DEP-####` transaction number for an account, computed
   * in SQL so it works inside a batch. Consumes ONE `?` (bank_id). Mirrors
   * `generateTransactionNumber()` in bank-ledger.component.ts — same two
   * prefixes, and the same way the number is allowed to grow past four digits
   * rather than wrap. MAX() over the parsed number, not the last row, so it
   * cannot hand out a number that already exists.
   *
   * The prefix is interpolated rather than bound. It is a TypeScript literal
   * union, not a value off a row or a form, so there is no injection surface —
   * and it has to be, because the two prefixes are different lengths and
   * `substr()` needs to skip past the hyphen of whichever one is in play.
   */
  private nextTransactionNumberSql(prefix: 'WD' | 'DEP'): string {
    const digitsFrom = prefix.length + 2;   // 'WD-' -> 4, 'DEP-' -> 5
    return `(SELECT '${prefix}-' || CASE WHEN length(CAST(n AS TEXT)) >= 4
                                  THEN CAST(n AS TEXT)
                                  ELSE substr('0000' || CAST(n AS TEXT), -4) END
             FROM (SELECT COALESCE(MAX(CAST(substr(bl.transaction_number, ${digitsFrom}) AS INTEGER)), 0) + 1 AS n
                   FROM bank_ledger bl
                   WHERE bl.bank_id = ? AND bl.transaction_number LIKE '${prefix}-%'))`;
  }

  /** Kept for the withdrawal-only callers that predate money-in. */
  private nextWithdrawalNumberSql(): string {
    return this.nextTransactionNumberSql('WD');
  }

  /**
   * The statements that move `amount` through a bank account: the ledger entry,
   * and — unless `deferBalance` says the caller will do it later — the
   * account's cached `current_balance` recomputed from the ledger it now
   * includes.
   *
   * `direction` is which way the money went, and it is the only thing that
   * differs between a payment out and a receipt in: `'out'` writes a credit and
   * takes a `WD-` number, `'in'` writes a debit and takes a `DEP-` number.
   * Balance is `SUM(debit - credit)` everywhere, so the running `balance`
   * column follows from the same expression with the sign flipped. Money-in
   * exists because six of the nine source tables are sales and income, not
   * payments; it is the same mechanism, not a second one.
   *
   * `referenceId` may be a literal id or a `{ $lastId: n }` marker, so this
   * composes with the batch that inserts the source row itself.
   *
   * `transactionNumber` lets an edit re-post an entry under the number it
   * already had, so a line the client noted against a receipt keeps its
   * reference. Left out, a fresh one is generated.
   *
   * `deferBalance` matters when one batch touches an account more than once (an
   * edit that deletes an entry and writes a new one, or a multi-row save that
   * banks several rows into the same account): rebuilding in the middle would
   * cache a balance that the next statement immediately invalidates, so those
   * callers rebuild once at the end instead.
   */
  private bankEntryOps(opts: {
    bankId: number;
    date: string;
    description: string;
    amount: number;
    referenceType: string;
    referenceId: any;
    direction?: 'in' | 'out';
    transactionNumber?: string | null;
    deferBalance?: boolean;
  }): DbBatchOp[] {
    const { bankId, date, description, amount, referenceType, referenceId,
            transactionNumber, deferBalance } = opts;
    const incoming = opts.direction === 'in';

    // A number carried over from the row being replaced is bound as a value;
    // otherwise the next one is derived in SQL, since a batch cannot read.
    const numberSql = transactionNumber
      ? '?'
      : this.nextTransactionNumberSql(incoming ? 'DEP' : 'WD');
    const numberParam = transactionNumber ? transactionNumber : bankId;

    const ops: DbBatchOp[] = [{
      sql: `INSERT INTO bank_ledger
              (bank_id, transaction_date, description, debit, credit, balance,
               reference_type, reference_id, transaction_number)
            VALUES (?, ?, ?, ${incoming ? '?, 0' : '0, ?'},
                    ${this.bankBalanceSql()} ${incoming ? '+' : '-'} ?, ?, ?, ${numberSql})`,
      params: [bankId, date, description, amount, bankId, amount,
               referenceType, referenceId, numberParam]
    }];

    if (!deferBalance) ops.push(this.rebuildBankBalanceOp(bankId));
    return ops;
  }

  /**
   * Money out, which is all `asset_payments` and `personal_expenses` ever do.
   * Kept as the name those paths already read by.
   */
  private bankWithdrawalOps(opts: {
    bankId: number;
    date: string;
    description: string;
    amount: number;
    referenceType: string;
    referenceId: any;
    transactionNumber?: string | null;
    deferBalance?: boolean;
  }): DbBatchOp[] {
    return this.bankEntryOps({ ...opts, direction: 'out' });
  }

  /** Re-derives an account's cached balance from its ledger. */
  private rebuildBankBalanceOp(bankId: number): DbBatchOp {
    return {
      sql: `UPDATE bank_accounts SET current_balance = ${this.bankBalanceSql()} WHERE bank_id = ?`,
      params: [bankId, bankId]
    };
  }

  /**
   * Removes the ledger entries mirroring the given source rows and rebuilds
   * every affected account's balance. `bankIds` has to be collected by a read
   * BEFORE the batch — once the entries are gone there is nothing left to
   * identify which accounts to rebuild.
   *
   * `deferBalance` is for the edit path, which re-posts into one of those
   * accounts straight afterwards and rebuilds once at the end.
   */
  private bankReversalOps(
    referenceType: string,
    idsSql: string,
    idsParams: any[],
    bankIds: number[],
    deferBalance = false
  ): DbBatchOp[] {
    if (bankIds.length === 0) return [];
    const ops: DbBatchOp[] = [{
      sql: `DELETE FROM bank_ledger
            WHERE reference_type = ? AND reference_id IN (${idsSql})`,
      params: [referenceType, ...idsParams]
    }];
    if (!deferBalance) ops.push(...bankIds.map(id => this.rebuildBankBalanceOp(id)));
    return ops;
  }

  // ── NO ACCOUNT MAY BE TAKEN BELOW ZERO ──────────────────────
  //
  // A bank account is a real account with real money in it. Paying out more
  // than it holds is not something the app can record truthfully: the ledger
  // would show a withdrawal the bank never honoured, and every figure derived
  // from the balance — Overview's Bank card, the account's own statement, the
  // Distribution report — would be quietly wrong from that line on.
  //
  // So a save that would take an account below zero is REFUSED, at the point
  // of save, before the batch runs. Nothing is written and the user is told
  // which account and by how much it falls short.
  //
  // THREE THINGS THIS DELIBERATELY DOES NOT DO:
  //
  //   - It does not block a DELETE. Removing a withdrawal puts money back, and
  //     removing a deposit is the un-making of a record the user has already
  //     decided was wrong; refusing it would strand a row that cannot be
  //     corrected. Every reversal path therefore skips the guard entirely.
  //   - It does not clear or block an account ALREADY negative. Balances went
  //     below zero before this existed and the client keeps them: they are
  //     shown on Overview > Bank in red with a warning, and a deposit clears
  //     them. An edit that leaves such an account no worse off than it was is
  //     allowed through — see the `worse` test below.
  //   - It does not read `bank_accounts.current_balance`. That column is a
  //     CACHE of the ledger, rebuilt by `rebuildBankBalanceOp()`; the ledger
  //     is the fact. Guarding on the cache would mean a save refused — or
  //     allowed — on a figure that a mid-batch rebuild had not yet corrected.
  //
  // THE SHAPE IS A NET DELTA PER ACCOUNT, not "an outgoing amount". An edit
  // reverses its old entry and posts a new one in the same batch, and a save
  // can bank several rows into one account; checking each statement alone
  // would refuse an edit that lowers a withdrawal and let through a pair that
  // together overdraw. Summing the signed effects per account is the only test
  // that matches what the batch will actually leave behind.

  /** Rs figures as they read in a refusal: grouped, and never 1234.5600001. */
  private bankAmountText(amount: number): string {
    return (Math.round(amount * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /**
   * The net effect the bank_ledger entries mirroring one source row currently
   * have on their account, i.e. `SUM(debit - credit)` over them. An edit's
   * reversal delta is the negative of this.
   *
   * Read off the ledger rather than recomputed from the row's own amount and
   * its table's declared direction, because the entry is what the batch will
   * delete — and a legacy row that carries no entry correctly contributes 0.
   */
  private async bankEntryEffect(referenceType: string, id: number): Promise<number> {
    const res = await this.get(
      `SELECT COALESCE(SUM(bl.debit - bl.credit), 0) AS effect FROM bank_ledger bl
       WHERE bl.reference_type = ? AND bl.reference_id = ?`,
      [referenceType, id]
    );
    if (!res.success) return 0;
    return Number((res.data && res.data[0]?.effect) || 0);
  }

  /**
   * THE GUARD. Given what a save is about to do to one or more accounts,
   * either `{ success: true }` or the sentence explaining which account cannot
   * stand it.
   *
   * Nulls, zero deltas and duplicate accounts are all handled, so a caller can
   * hand over the raw list it built while assembling its batch — the same way
   * `bankRebuildOps()` takes the raw list of accounts a save touched.
   *
   * `worse` is what keeps an already-negative account usable: a save is only
   * refused if it DRAWS on the account (`delta < 0`) and the result is below
   * zero. An edit that moves nothing, or that pays money in, is never refused,
   * whatever the account stands at.
   *
   * The 0.005 tolerance is half a paisa, the same one every other balance
   * comparison in this file uses: float dust in a sum of rupees must not be
   * the thing that refuses a save that is exactly square.
   */
  async checkBankBalances(deltas: BankDelta[]): Promise<BankGuardResult> {
    const net = new Map<number, number>();
    for (const d of deltas || []) {
      const id = Number(d?.bankId) || 0;
      if (!id) continue;
      net.set(id, (net.get(id) || 0) + (Number(d?.delta) || 0));
    }

    // Only accounts money is actually leaving can fail, so nothing else is
    // even read.
    const drawn = Array.from(net.entries()).filter(([, delta]) => delta < -0.005);
    if (drawn.length === 0) return { success: true };

    const ids = drawn.map(([id]) => id);
    const res = await this.get(
      `SELECT ba.bank_id, ba.bank_name,
              (SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl
                WHERE bl.bank_id = ba.bank_id) AS balance
       FROM bank_accounts ba WHERE ba.bank_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    if (!res.success) return { success: false, error: res.error };

    const byId = new Map<number, any>(
      (res.data || []).map((r: any) => [Number(r.bank_id), r])
    );

    for (const [id, delta] of drawn) {
      const row = byId.get(id);
      // An account the save names but the database does not hold is not this
      // guard's refusal to make — `bankSourceError()` on the form and the
      // screens' own validation own that message.
      if (!row) continue;

      const balance = Number(row.balance) || 0;
      if (balance + delta < -0.005) {
        const name = row.bank_name || `Account #${id}`;
        return {
          success: false,
          error: `${name} does not have enough balance. ` +
                 `Current: Rs. ${this.bankAmountText(balance)}, ` +
                 `needed: Rs. ${this.bankAmountText(-delta)}.`
        };
      }
    }

    return { success: true };
  }

  // ── THE OTHER SEVEN BANK-SOURCED TABLES ─────────────────────
  //
  // Assets and personal expenses were the first two things that could be paid
  // by bank, and the three helpers above were written for them. Every screen
  // where money is received or paid now carries the same Cash/Bank selector, so
  // seven more tables feed the same mechanism — four of them sales and income,
  // which is why `bankEntryOps` grew a direction rather than growing a twin.
  //
  // The invariant is unchanged and now spans all nine: for every row with
  // `payment_source = 'bank'` there is exactly one `bank_ledger` row carrying
  // that table's reference_type and that row's primary key, and every
  // `bank_accounts.current_balance` equals SUM(debit - credit) over its own
  // ledger. `scripts/verify/verify_bank_withdrawals.js` drives its sweep off
  // the list below, so a table declared here cannot escape being checked.
  //
  // WHAT payment_source IS NOT. Six of these tables already carried a
  // `payment_type`, and four of those already offered the user a "Bank" option
  // — free text, no account, no ledger effect, and no report anywhere filters
  // on it. That column keeps meaning exactly what it did: the label the user
  // put on the row. `payment_source` is the separate, normalized fact that
  // money moved through a NAMED account, and it is the only thing this
  // mechanism reads. The two are wired together in the UI — picking "Bank"
  // reveals the account dropdown and sets both — but they are not the same
  // claim, and the difference is what makes legacy rows safe: a row saved
  // before this existed says payment_type = 'bank' and payment_source = 'cash',
  // which is true. No deposit was ever posted for it.
  //
  // `purchase_orders` is the exception to that wiring and deliberately so: its
  // payment_type is "Paid (Debit)" vs "Unpaid (Credit)" — a settlement status
  // that drives the supplier ledger, not a source. Adding 'bank' to it would
  // flip `isPaid` and move the supplier payable. There the Cash/Bank selector
  // is its own control, shown only on a paid order.
  //
  // `income` takes the selector on MANUAL rows only. Its `source` =
  // sale/egg_sale/hen_sale rows are daily mirrors rebuilt from `sales`,
  // `egg_sales` and `hen_sales`, which carry the selector themselves — banking
  // both sides would deposit every bank sale twice.

  /**
   * Every table that can be the source of a bank movement, and how a ledger row
   * points back at it. One entry per TABLE, not per screen: `expenses` is
   * written by the broiler and the layer Expenses screens and `income` and
   * `labour_payments` by both modules, but a primary key is unique across the
   * table either way, so one reference_type covers them.
   *
   * None of these reference_types collides with the ones already in use
   * ('opening', 'deposit', 'withdrawal', 'payment', 'asset_payment',
   * 'personal_expense'), and `canDeleteEntry()` in bank-ledger.component.ts is
   * an allowlist of the three the Bank Ledger screen writes itself — so none of
   * these entries can be hand-deleted from that screen, which is correct. They
   * are reversed by editing or deleting the row they mirror.
   */
  private static readonly BANK_SOURCES = {
    sales:           { table: 'sales',           pk: 'sale_id',     ref: 'broiler_sale',   dir: 'in'  },
    egg_sales:       { table: 'egg_sales',       pk: 'egg_sale_id', ref: 'egg_sale',       dir: 'in'  },
    hen_sales:       { table: 'hen_sales',       pk: 'hen_sale_id', ref: 'hen_sale',       dir: 'in'  },
    income:          { table: 'income',          pk: 'income_id',   ref: 'farm_income',    dir: 'in'  },
    expenses:        { table: 'expenses',        pk: 'expense_id',  ref: 'farm_expense',   dir: 'out' },
    labour_payments: { table: 'labour_payments', pk: 'payment_id',  ref: 'labour_payment', dir: 'out' },
    purchase_orders: { table: 'purchase_orders', pk: 'purchase_id', ref: 'purchase_order', dir: 'out' },
    // The two vouchers. A voucher row IS the money event — one per voucher,
    // which is what lets the entry key to it even though the settlement it
    // drives can touch several bills. Receive is money in, payment money out,
    // so they are two tables rather than one with a type column: direction is
    // declared here, per table.
    receive_vouchers: { table: 'receive_vouchers', pk: 'voucher_id',  ref: 'receive_voucher', dir: 'in'  },
    payment_vouchers: { table: 'payment_vouchers', pk: 'voucher_id',  ref: 'payment_voucher', dir: 'out' },
    // The DISTRIBUTION business's own running costs — rent, fuel, salaries —
    // which are a different book from the farm `expenses` table two rows up and
    // need their own reference_type for it: the two primary keys are separate
    // AUTOINCREMENT sequences that both start at 1, so one shared type would
    // make a farm expense and a distribution expense indistinguishable to every
    // reversal here.
    //
    // It had a `payment_type` offering "Bank" long before this, with no account
    // behind it and no ledger effect — exactly the gap the client noticed. That
    // column still means only "what the user labelled the row"; `payment_source`
    // is the normalized fact that money moved through a NAMED account.
    expense_ledger:   { table: 'expense_ledger',   pk: 'expense_id',  ref: 'distribution_expense', dir: 'out' }
  } as const;

  private bankSource(key: BankSourceKey) {
    const spec = DatabaseService.BANK_SOURCES[key];
    if (!spec) throw new Error(`Unknown bank source table: ${key}`);
    return spec;
  }

  /**
   * The ops that post one row's bank movement, for a row being INSERTED in the
   * same batch. Returns [] when the row is not bank-sourced, so a caller can
   * splice this in unconditionally.
   *
   * `referenceId` defaults to `{ $lastId: -1 }` — the id of the statement
   * immediately before this one — which is the shape every multi-row save
   * wants: `[insert row][its entry][insert row][its entry]…`. `$lastId`
   * offsets count back over ALL ops, not just inserts, so interleaving stays
   * correct for any number of rows.
   *
   * The balance is always deferred. A save that banks several rows into one
   * account would otherwise rebuild it once per row, caching figures the next
   * statement invalidates; `bankRebuildOps()` closes the batch instead.
   */
  bankSourceInsertOps(key: BankSourceKey, row: {
    payment_source?: string | null;
    bank_id?: number | null;
    date: string;
    description: string;
    amount: number;
    referenceId?: any;
  }): DbBatchOp[] {
    const spec = this.bankSource(key);
    const bankId = this.bankIdOf(row.payment_source, row.bank_id);
    if (!bankId) return [];

    return this.bankEntryOps({
      bankId,
      date: row.date,
      description: row.description,
      amount: Number(row.amount) || 0,
      referenceType: spec.ref,
      referenceId: row.referenceId === undefined ? { $lastId: -1 } : row.referenceId,
      direction: spec.dir,
      deferBalance: true
    });
  }

  /**
   * The signed effect one bank-sourced row has on its account: minus the
   * amount for a table declared `'out'`, plus it for one declared `'in'`.
   * Zero for a row that is not bank-sourced, so it drops out of the sum.
   */
  private bankSourceDelta(key: BankSourceKey, row: {
    payment_source?: string | null;
    bank_id?: number | null;
    amount: any;
  }): BankDelta {
    const spec = this.bankSource(key);
    const bankId = this.bankIdOf(row.payment_source, row.bank_id);
    const amount = Number(row.amount) || 0;
    return { bankId, delta: spec.dir === 'out' ? -amount : amount };
  }

  /**
   * THE PRECHECK every insert path calls before it runs its batch: would these
   * rows, together, take any account below zero?
   *
   * Takes the WHOLE list of rows a save is about to write rather than one at a
   * time, which is the point — three expenses of 40,000 against an account
   * holding 100,000 are each affordable and are not affordable together, and
   * they land in one batch.
   *
   * It has to be a separate call rather than folded into
   * `bankSourceInsertOps()` because that one is synchronous by necessity: it is
   * spliced into a batch being assembled, and a `runBatch` cannot take a read
   * between its statements. So the read happens here, first, and the batch
   * either runs untouched or never runs at all.
   */
  async checkBankSourceInserts(key: BankSourceKey, rows: Array<{
    payment_source?: string | null;
    bank_id?: number | null;
    amount: any;
  }>): Promise<BankGuardResult> {
    return this.checkBankBalances((rows || []).map(r => this.bankSourceDelta(key, r)));
  }

  /**
   * One `current_balance` rebuild per distinct account, to close a batch whose
   * entry ops all deferred theirs. Nulls and duplicates are dropped, so callers
   * can hand it the raw list of accounts the save touched.
   */
  bankRebuildOps(bankIds: (number | null | undefined)[]): DbBatchOp[] {
    const distinct = Array.from(new Set(
      bankIds.map(b => Number(b) || 0).filter(b => b > 0)
    ));
    return distinct.map(b => this.rebuildBankBalanceOp(b));
  }

  /**
   * `payment_source` and `bank_id` reduced to the one thing the mechanism
   * needs: the account this row moved money through, or null for cash. A
   * 'bank' row with no account is cash — the screens refuse to save that
   * combination, and this is the second line of defence.
   */
  private bankIdOf(paymentSource?: string | null, bankId?: number | null): number | null {
    if (paymentSource !== 'bank') return null;
    return Number(bankId) || null;
  }

  /**
   * What the bank paths need to know about a row before it is changed: which
   * account it drew on, and the number its entry carries. Both have to be read
   * BEFORE the batch — once the entry is gone there is nothing left to say
   * which balance to rebuild or which number to keep.
   */
  private async bankSourceExisting(key: BankSourceKey, id: number): Promise<any> {
    const spec = this.bankSource(key);
    const res = await this.get(
      `SELECT s.payment_source, s.bank_id,
              (SELECT bl.transaction_number FROM bank_ledger bl
                WHERE bl.reference_type = ? AND bl.reference_id = s.${spec.pk}
                LIMIT 1) AS ledger_number
       FROM ${spec.table} s WHERE s.${spec.pk} = ?`,
      [spec.ref, id]
    );
    if (!res.success) return res;
    if (!res.data || res.data.length === 0) {
      return { success: false, error: 'That record no longer exists.' };
    }
    return { success: true, row: res.data[0] };
  }

  /**
   * EDITING a bank-sourced row. The withdrawal or deposit is REVERSED AND
   * RE-POSTED rather than patched — the same shape `updatePersonalExpense()`
   * documents at length, factored out so the other seven tables get it without
   * seven chances to forget a transition. One shape covers all five:
   *
   *   amount changed, same account  the net movement is the difference
   *   date changed                  re-posted on the new date
   *   cash -> bank                  nothing to delete, one entry written
   *   bank -> cash                  entry deleted, none written, row intact
   *   bank A -> bank B              deleted from A, written to B, BOTH rebuilt
   *
   * Ordering is load-bearing. The delete and the insert both come before any
   * rebuild, and the rebuild covers the UNION of the old and new accounts —
   * rebuilding A in the middle caches a figure the next statement invalidates,
   * and rebuilding only B leaves A counting an entry it no longer has.
   *
   * The old entry's number is carried over when the account has not changed, so
   * a line noted against a receipt keeps its reference. Moving to another
   * account takes a fresh one: the number belongs to the old account's sequence
   * and could collide in the new one.
   *
   * `update` is the caller's own UPDATE statement, which must set
   * payment_source and bank_id itself along with whatever else changed — the
   * screens own their SQL here, as they do everywhere else in this app. Extra
   * `before`/`after` ops let a caller fold its own writes into the same batch.
   *
   * A row whose payment_source is 'bank' but which carries no ledger entry —
   * written before any of this existed — simply has nothing to delete. Correct:
   * no entry was ever posted for it.
   */
  async saveBankSourceEdit(
    key: BankSourceKey,
    id: number,
    update: DbBatchOp,
    next: {
      payment_source?: string | null;
      bank_id?: number | null;
      date: string;
      description: string;
      amount: number;
    },
    extra?: { before?: DbBatchOp[]; after?: DbBatchOp[] }
  ): Promise<any> {
    const spec = this.bankSource(key);
    const existing = await this.bankSourceExisting(key, id);
    if (!existing.success) return existing;

    const oldBank = this.bankIdOf(existing.row.payment_source, existing.row.bank_id);
    const newBank = this.bankIdOf(next.payment_source, next.bank_id);

    // No account may be left below zero. Both halves of the edit count: the
    // reversal is read off the ledger (so removing a withdrawal is money back
    // and removing a deposit is money gone), and the re-post takes its sign
    // from the table's declared direction. Checked over the union, because an
    // edit that moves an account's worth of money from A to B can overdraw A
    // even though B ends up richer.
    const guard = await this.checkBankBalances([
      { bankId: oldBank, delta: oldBank ? -(await this.bankEntryEffect(spec.ref, id)) : 0 },
      this.bankSourceDelta(key, { payment_source: next.payment_source, bank_id: next.bank_id, amount: next.amount })
    ]);
    if (!guard.success) return guard;

    const ops: DbBatchOp[] = [...(extra?.before || [])];

    if (oldBank) {
      ops.push(...this.bankReversalOps(spec.ref, '?', [id], [oldBank], true));
    }

    ops.push(update);

    if (newBank) {
      ops.push(...this.bankEntryOps({
        bankId: newBank,
        date: next.date,
        description: next.description,
        amount: Number(next.amount) || 0,
        referenceType: spec.ref,
        referenceId: id,
        direction: spec.dir,
        transactionNumber: (oldBank === newBank) ? (existing.row.ledger_number || null) : null,
        deferBalance: true
      }));
    }

    ops.push(...(extra?.after || []));
    ops.push(...this.bankRebuildOps([oldBank, newBank]));

    return this.runBatch(ops);
  }

  /**
   * DELETING a bank-sourced row: the entry goes with it and the account is
   * rebuilt, in one batch with the caller's own deletes. The money never left,
   * so the balance must not go on saying it did.
   */
  async deleteBankSourced(key: BankSourceKey, id: number, del: DbBatchOp[]): Promise<any> {
    const spec = this.bankSource(key);
    const existing = await this.bankSourceExisting(key, id);
    if (!existing.success) return existing;

    const bankId = this.bankIdOf(existing.row.payment_source, existing.row.bank_id);
    if (!bankId) return this.runBatch(del);

    return this.runBatch([
      ...this.bankReversalOps(spec.ref, '?', [id], [bankId]),
      ...del
    ]);
  }

  /**
   * The ops a CASCADE needs: every entry belonging to the rows a `WHERE` clause
   * is about to delete, plus a rebuild of each account they drew on.
   *
   * Closing a flock or a batch deletes its expenses, income, sales, labour
   * payments, egg sales and hen sales outright (foreign keys are declared but
   * `PRAGMA foreign_keys` is never on, so nothing cascades and every child row
   * goes by hand). Without this, those deletes would leave `bank_ledger` rows
   * pointing at records that no longer exist and every balance they touched
   * overstated — the exact drift this mechanism exists to prevent, arriving by
   * the one path that never shows a form.
   *
   * `scopeSql` / `scopeParams` are the caller's own scoping, passed through
   * verbatim so the module_type guard that keeps colliding flock and batch ids
   * apart is written once, by the screen that owns it, and used identically for
   * the reversal and the delete.
   *
   * Returns the ops to run BEFORE the caller's deletes — the accounts are read
   * here, while the rows are still there to be read.
   */
  async bankCascadeReversalOps(
    key: BankSourceKey,
    scopeSql: string,
    scopeParams: any[]
  ): Promise<BankCascadeReversal> {
    const spec = this.bankSource(key);
    const res = await this.get(
      `SELECT DISTINCT bank_id FROM ${spec.table}
       WHERE payment_source = 'bank' AND bank_id IS NOT NULL AND (${scopeSql})`,
      scopeParams
    );
    if (!res.success) return { success: false, error: res.error };

    const bankIds = (res.data || [])
      .map((r: any) => Number(r.bank_id) || 0)
      .filter((n: number) => n > 0);
    if (bankIds.length === 0) return { success: true, ops: [] };

    // Deleting by the same scope rather than by a list of ids read out here:
    // one statement whatever the row count, and it cannot disagree with the
    // caller's delete, which uses that identical clause.
    return {
      success: true,
      ops: [
        {
          sql: `DELETE FROM bank_ledger
                WHERE reference_type = ?
                  AND reference_id IN (SELECT ${spec.pk} FROM ${spec.table} WHERE ${scopeSql})`,
          params: [spec.ref, ...scopeParams]
        },
        ...this.bankRebuildOps(bankIds)
      ]
    };
  }

  // ── AN UNPAID LAYER SALE'S RECEIVABLE ───────────────────────
  //
  // An egg or hen sale made on credit to a named customer raises a REAL
  // `bills` row. Not because a layer sale is a distribution sale — it is not,
  // and `bill-source.util.ts` keeps it out of every distribution figure — but
  // because a customer's balance in this app IS
  //
  //     Σ MAX(bills.total_amount − bills.amount_paid, 0)
  //
  // and there is exactly one of that expression. `customers.
  // outstanding_balance`, `getAllCustomersWithBalance()`, the Customer Ledger
  // screen, the Receive Voucher screen, the Internal Settlement screen and
  // `customerSettlementOps()` all read it. A receivable that is not a bill is
  // therefore not a receivable: it would print on the statement, move no
  // balance, and be refused by every settlement door as an overpayment
  // against nothing.
  //
  // So this writes the same three things Sales Orders writes for an unpaid
  // bill — the bill, its `customer_ledger` 'bill' debit, and the balance
  // recompute — and nothing else. No `bill_items` (there is no product), no
  // stock movement, no internal transfer. Settlement then works through the
  // existing doors with no change at all: the sale's bill is just another
  // unpaid bill in the FIFO.
  //
  // THE REVENUE IS NOT DOUBLE-COUNTED. The sale books its own revenue in the
  // layer module through the daily `income` mirror, which is what the layer
  // report and Overview's layer figures read. The bill is excluded from every
  // distribution figure — see the distribution-only filter and the reader list in
  // bill-source.util.ts.
  //
  // WHEN THERE IS NO BILL. A cash or bank sale is paid in full the moment it
  // is made, and a walk-in sale has nobody to owe. Both raise nothing; the
  // screens' receivable builder returns null and these methods are no-ops. A
  // layer sale has no part-payment field, so 'credit' is the only unpaid case
  // and the bill is always for the full amount.

  /** The `BILL-###` counterpart for a receivable, per source prefix. */
  private layerBillPrefix(source: LayerBillSource): string {
    return source === 'hen_sale' ? 'HEN' : 'EGG';
  }

  /**
   * The next `EGG-###` / `HEN-###` number, computed in SQL so it works inside
   * a batch that has no room for a read — and so that several sales saved
   * together each get a distinct one, since each statement's subquery sees the
   * rows the earlier statements of the same transaction inserted.
   *
   * A separate prefix per source, which also keeps these clear of Sales
   * Orders' own `BILL-%` sequence: that screen computes its next number with
   * `WHERE bill_number LIKE 'BILL-%'`, so neither can ever hand out the
   * other's. Consumes ONE `?` (farm_id).
   *
   * The prefix is interpolated rather than bound because it is a TypeScript
   * literal, never a value off a row or a form — the same reasoning as
   * `nextTransactionNumberSql()`.
   */
  private nextLayerBillNumberSql(source: LayerBillSource): string {
    const prefix = this.layerBillPrefix(source);
    const from = prefix.length + 2;   // 'EGG-' -> 5
    return `(SELECT '${prefix}-' || CASE WHEN length(CAST(n AS TEXT)) >= 3
                                    THEN CAST(n AS TEXT)
                                    ELSE substr('000' || CAST(n AS TEXT), -3) END
             FROM (SELECT COALESCE(MAX(CAST(substr(b.bill_number, ${from}) AS INTEGER)), 0) + 1 AS n
                   FROM bills b
                   WHERE b.farm_id = ? AND b.bill_number LIKE '${prefix}-%'))`;
  }

  /**
   * The ops that raise one layer sale's receivable, or [] when it has none.
   *
   * `saleOp` is the index of the operation that inserted the sale in the SAME
   * batch, so `source_id` binds with `{ $lastId: saleOp }` — an ABSOLUTE
   * index, not the usual `-1`, because a multi-row save interleaves each
   * sale's bank deposit between the inserts and a relative offset would move
   * with it. `startIndex` is where these ops themselves land, so the ledger
   * debit can name the bill the same way.
   */
  layerReceivableOps(r: LayerSaleReceivable, startIndex: number): DbBatchOp[] {
    const amount = Number(r.amount) || 0;
    if (!r.customer_id || !(amount > 0)) return [];

    const sourceId = r.saleOp !== undefined ? { $lastId: r.saleOp } : (r.sale_id ?? null);

    return [
      {
        sql: `INSERT INTO bills
                (farm_id, bill_number, customer_id, customer_name, bill_date, subtotal,
                 total_amount, amount_paid, payment_type, status, source, source_id)
              VALUES (?, ${this.nextLayerBillNumberSql(r.source)}, ?, ?, ?, ?, ?, 0, 'credit', 'completed', ?, ?)`,
        params: [r.farm_id, r.farm_id, r.customer_id, r.customer_name || '', r.date,
                 amount, amount, r.source, sourceId]
      },
      // The same 'bill' mirror Sales Orders writes for its own bills, so the
      // Customer Ledger statement reads identically whichever raised the debt
      // — and so a later settlement, which regenerates entries by
      // `reference_id`, finds it.
      {
        // The description is CONCATENATED IN SQL — `? || ?` with the sale's id
        // as the second half — because on the save path that id does not exist
        // yet in TypeScript: it arrives as a `{ $lastId }` marker the main
        // process resolves mid-batch. Building the string here instead would
        // give every freshly-saved receivable a statement line with no sale
        // number on it, and only edited ones a complete one.
        sql: `INSERT INTO customer_ledger
                (customer_id, transaction_date, description, debit, credit, balance,
                 reference_type, reference_id)
              VALUES (?, ?, ? || ?, ?, 0,
                (SELECT COALESCE(SUM(debit - credit), 0) FROM customer_ledger WHERE customer_id = ?) + ?,
                'bill', ?)`,
        params: [r.customer_id, r.date, this.layerReceivableLabel(r), sourceId, amount,
                 r.customer_id, amount, { $lastId: startIndex }]
      },
      this.rebuildCustomerBalanceOp(r.customer_id)
    ];
  }

  /**
   * The text half of how the receivable reads on the customer's statement; the
   * sale's id is concatenated onto it in SQL — see the INSERT above.
   */
  private layerReceivableLabel(r: LayerSaleReceivable): string {
    return (r.source === 'hen_sale' ? 'Hen sale #' : 'Egg sale #');
  }

  /**
   * What a layer sale's bill currently holds, read BEFORE anything changes it:
   * its id, its amount and how much of it has been settled.
   *
   * The settled figure is the precondition both screens check. Once a customer
   * has paid against this bill, the payment is a `customer_ledger` credit
   * tagged to it — possibly written by a Receive Voucher, which also moved
   * money through a bank account. Editing or deleting the sale underneath that
   * would take the debt away while the payment stood, so the screens refuse
   * and say to reverse the payment first. That is the same shape as
   * `deleteCustomerLedgerEntry()` refusing a voucher-tagged row.
   */
  async layerSaleBill(source: LayerBillSource, saleId: number): Promise<any> {
    const res = await this.get(
      `SELECT bill_id, bill_number, customer_id, total_amount, COALESCE(amount_paid, 0) AS amount_paid
       FROM bills WHERE source = ? AND source_id = ?`,
      [source, saleId]
    );
    if (!res.success) return res;
    return { success: true, bill: (res.data && res.data[0]) || null };
  }

  /**
   * The ops that remove a layer sale's receivable and recompute the customer's
   * balance, or [] when it has none.
   *
   * Both the bill and its ledger entries go, which is exactly what the Sales
   * Orders delete does for its own bills: the debt no longer exists, so
   * nothing may go on saying it does. `bill` is what `layerSaleBill()` read
   * before the caller started writing — once the row is gone there is nothing
   * left to say whose balance to rebuild.
   */
  layerReceivableReversalOps(bill: any): DbBatchOp[] {
    if (!bill || !bill.bill_id) return [];
    return [
      { sql: `DELETE FROM customer_ledger WHERE reference_id = ? AND reference_type IN ('bill', 'payment')`,
        params: [bill.bill_id] },
      { sql: 'DELETE FROM bills WHERE bill_id = ?', params: [bill.bill_id] },
      this.rebuildCustomerBalanceOp(bill.customer_id)
    ];
  }

  // ── A DISTRIBUTION BILL'S BANK RECEIPT ──────────────────────
  //
  // A bill's payment can land on either KIND of account, and that is the whole
  // difficulty. The customer may pay into one of the OWNER'S OWN house
  // accounts — a plain receipt, money in — or the payment may be taken from
  // the deposit that customer already holds with the farm, which is money OUT
  // of the customer's own account and the axis this screen has always had
  // (`deductCustomerBank()`, written as reference_type 'payment' with a NULL
  // reference_id, delta-adjusted on edit by `applyBankPaymentChange()`).
  //
  // WHY `bills` IS NOT A BANK_SOURCES TABLE. Same reason as
  // `internal_settlements`, and it fails the shape twice over:
  //
  //   - ONE DIRECTION PER TABLE. A house receipt is 'in'; drawing down a
  //     customer deposit is 'out'. `BANK_SOURCES` declares the direction per
  //     table, so one table cannot be both.
  //   - THE REFERENCE PAIR. The customer-deposit entry is keyed to NOTHING —
  //     reference_type 'payment' with reference_id NULL — so
  //     `bankSourceExisting()` and `bankReversalOps()`, which both match on
  //     reference_id, cannot find it. Declaring `bills` would make the
  //     mechanism's "exactly one entry per payment_source = 'bank' row"
  //     invariant false for every deposit-paid bill the moment it is stated,
  //     and `verify_bank_withdrawals.js` asserts exactly that invariant over
  //     every declared table.
  //
  // The alternative — writing payment_source = 'customer_bank' on a
  // deposit-paid bill so the sweep skips it — was rejected deliberately. That
  // money really did move through a named account, which is precisely what
  // payment_source means; saying otherwise to slip past an invariant is the
  // kind of structural lie this file exists to avoid, and it would make
  // `paymentSourceLabel()` print "Cash" for a bill paid out of a bank.
  //
  // So the house half takes the named-path shape `assets`,
  // `personal_expenses` and `internal_settlements` have: its own
  // reference_type, keyed to the bill, composed out of the same primitives
  // (`bankEntryOps`, `bankReversalOps`, `bankRebuildOps`) that back
  // `BANK_SOURCES` itself. The screen supplies only its own bill SQL, exactly
  // as `bankSourceInsertOps()` arranges for the nine declared tables.
  //
  // `payment_account_kind` is what tells a saved row's two cases apart —
  // 'house' or 'customer' — and the discriminator has to be that column rather
  // than payment_type, which reads 'bank' for both. See the ALTER block in
  // electron/database.js.

  /**
   * Marks a bank_ledger row as money RECEIVED into one of the owner's own
   * accounts against one bill. Keyed to `bills.bill_id`.
   *
   * Distinct from 'payment', which is the customer-deposit axis and belongs to
   * the customer's account, not the owner's.
   */
  private static readonly BILL_PAYMENT_IN_REF = 'bill_payment_in';

  /**
   * The ops that post one bill's house receipt, or [] when the bill was not
   * received into a house account (cash, internal, or a customer deposit).
   *
   * `billId` is a literal here rather than a `{ $lastId: -1 }` marker: the bill
   * save reads its id back inside its own transaction before it gets here, and
   * the entry is written in a batch of its own.
   *
   * The balance is NOT deferred — a bill touches one account once, so there is
   * no mid-batch rebuild to invalidate.
   */
  billHouseReceiptOps(bill: {
    payment_account_kind?: string | null;
    payment_source?: string | null;
    bank_id?: number | null;
    billId: number;
    date: string;
    description: string;
    amount: number;
  }): DbBatchOp[] {
    const bankId = this.houseBankIdOf(bill);
    if (!bankId || !(Number(bill.amount) > 0)) return [];

    return this.bankEntryOps({
      bankId,
      date: bill.date,
      description: bill.description,
      amount: Number(bill.amount) || 0,
      referenceType: DatabaseService.BILL_PAYMENT_IN_REF,
      referenceId: bill.billId,
      direction: 'in'
    });
  }

  /**
   * THE PRECHECK for a bill's house receipt, covering the edit as well as the
   * insert.
   *
   * A receipt is money IN, so a new bill can never overdraw anything. An EDIT
   * can: the save reverses whatever receipt the bill carried and posts the new
   * one, so reducing a 900,000 receipt to 10,000 takes 890,000 back out of the
   * account, and moving the receipt to another account takes all of it. Both
   * are netted here, over the union, exactly as `saveBankSourceEdit()` does.
   *
   * `billId` is 0 or null for a bill being created — there is nothing to
   * reverse, and the new receipt alone is never negative.
   */
  async checkBillHouseReceipt(bill: {
    payment_account_kind?: string | null;
    payment_source?: string | null;
    bank_id?: number | null;
    billId?: number | null;
    amount: number;
  }): Promise<BankGuardResult> {
    const newBank = this.houseBankIdOf(bill);
    const billId = Number(bill.billId) || 0;

    const existing = billId
      ? await this.bankEntryEffect(DatabaseService.BILL_PAYMENT_IN_REF, billId)
      : 0;
    const oldBankRes = billId
      ? await this.get(
          `SELECT DISTINCT bank_id FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`,
          [DatabaseService.BILL_PAYMENT_IN_REF, billId])
      : { success: true, data: [] };
    if (!oldBankRes.success) return { success: false, error: oldBankRes.error };
    const oldBank = Number((oldBankRes.data || [])[0]?.bank_id) || null;

    return this.checkBankBalances([
      { bankId: oldBank, delta: -existing },
      { bankId: newBank, delta: Number(bill.amount) > 0 ? Number(bill.amount) : 0 }
    ]);
  }

  /**
   * The ops that remove a bill's house receipt and rebuild the account it was
   * on, or [] when there is none.
   *
   * The account is read HERE, before the caller runs anything: once the entry
   * is gone there is nothing left to say which balance to rebuild. Same shape
   * as `bankCascadeReversalOps()` for the same reason.
   *
   * The return type is the named `BankCascadeReversal` rather than an inline
   * object, for the reason that interface documents: the verify scripts lift
   * these bodies out of this file as text and find a body by its first brace.
   *
   * Read off `bank_ledger` rather than off the bill, because the edit path
   * calls this with the bill row still holding whatever it held — and because a
   * bill that claims a house account but carries no entry (written before any
   * of this existed) then simply has nothing to reverse, which is correct.
   */
  async billHouseReversalOps(billId: number): Promise<BankCascadeReversal> {
    const res = await this.get(
      `SELECT DISTINCT bank_id FROM bank_ledger
       WHERE reference_type = ? AND reference_id = ?`,
      [DatabaseService.BILL_PAYMENT_IN_REF, billId]
    );
    if (!res.success) return { success: false, error: res.error, ops: [] };

    const bankIds = (res.data || [])
      .map((r: any) => Number(r.bank_id) || 0)
      .filter((n: number) => n > 0);
    if (bankIds.length === 0) return { success: true, ops: [] };

    return {
      success: true,
      ops: this.bankReversalOps(DatabaseService.BILL_PAYMENT_IN_REF, '?', [billId], bankIds)
    };
  }

  /**
   * The house account this bill was received into, or null.
   *
   * Narrower than `bankIdOf()`: a bill needs payment_account_kind = 'house' as
   * well as payment_source = 'bank', because a deposit-paid bill is honestly
   * bank-sourced too and must NOT get an entry of this kind.
   */
  private houseBankIdOf(bill: {
    payment_account_kind?: string | null;
    payment_source?: string | null;
    bank_id?: number | null;
  }): number | null {
    if (bill?.payment_account_kind !== 'house') return null;
    return this.bankIdOf(bill.payment_source ?? 'bank', bill.bank_id);
  }

  // ── RECEIVE / PAYMENT VOUCHERS ──────────────────────────────
  //
  // A voucher is a SHORTCUT, not a second book. Recording a receipt used to
  // mean navigating into the customer, finding their ledger and entering a
  // payment; a receive voucher collapses that into one form. So it must settle
  // through the SAME path that screen does — `customerSettlementOps()`, the
  // FIFO allocation across bills, the `customer_ledger` credits, the
  // bills-derived balance recompute — and the payment voucher through the same
  // single `supplier_ledger` debit the Supplier Ledger screen writes. Neither
  // may re-derive a balance of its own: two implementations would drift, and
  // the owner would have two screens disagreeing about what he is owed.
  //
  // WHAT A VOUCHER ADDS is the bank attribution, and the guarantee that the
  // two sides can only be recorded together. Both halves — the settlement and
  // the bank entry — go in ONE runBatch on both the save and the delete, so
  // there is no state in which the money has moved and the debt has not, or
  // the reverse.
  //
  // THE BATCH SHAPE, and why the voucher row is inserted first. The settlement
  // can touch several bills and so write several ledger rows, all of which have
  // to name the voucher. `{ $lastId: 0 }` is the id inserted by operation 0 of
  // the batch, so putting the voucher's own INSERT there lets every later
  // statement — the ledger credits AND the bank entry — point back at it
  // without a round trip.
  //
  // The screens own their row SQL, as they do everywhere else in this app:
  // each passes its own `INSERT INTO *_vouchers` in, and this composes the
  // settlement and the bank movement around it.

  /**
   * Money received from a customer: their bills settled, and the money
   * deposited into one of the owner's own accounts.
   *
   * `insert` is the screen's own voucher INSERT and becomes operation 0.
   *
   * OVERPAYMENT IS REFUSED, and the test is the settlement's own arithmetic
   * rather than a second outstanding-balance calculation: whatever the FIFO
   * allocation could not place on a bill comes back as `unapplied`, and any
   * unapplied remainder means the receipt is larger than the debt. Letting it
   * through would credit the ledger more than it put on the bills, which is
   * precisely the invariant this module is built to hold. The Customer Ledger
   * screen refuses the same thing for the same reason; there is no advance or
   * credit-balance concept anywhere in this app.
   */
  async saveReceiveVoucher(insert: DbBatchOp, v: {
    customer_id: number;
    amount: number;
    date: string;
    description: string;
    bank_description: string;
    payment_source?: string | null;
    bank_id?: number | null;
  }): Promise<VoucherSaveResult> {
    const amount = Number(v.amount) || 0;
    if (!(amount > 0)) {
      return { success: false, error: 'Enter an amount greater than zero.' };
    }

    const billsRes = await this.getUnpaidBills(v.customer_id);
    if (!billsRes.success) return { success: false, error: billsRes.error };

    const settlement = this.customerSettlementOps({
      customer_id: v.customer_id,
      amount,
      date: v.date,
      description: v.description,
      bills: billsRes.data || [],
      bill_id: null,
      voucher_id: { $lastId: 0 }
    });

    if (settlement.unapplied > 0.005) {
      const applicable = amount - settlement.unapplied;
      return {
        success: false,
        error: applicable > 0
          ? `This customer only owes Rs ${applicable.toLocaleString()}. ` +
            `Reduce the amount to that, or raise a bill for the rest first.`
          : 'This customer has no unpaid bills, so there is nothing to receive against.'
      };
    }

    // A receipt only ever raises a balance, so this can only refuse if the
    // table's declared direction ever changes. Called on the same terms as
    // every other insert path rather than skipped on that reasoning — the
    // whole point of driving the sign off `BANK_SOURCES` is that no caller
    // restates it.
    const guard = await this.checkBankSourceInserts('receive_vouchers', [
      { payment_source: v.payment_source, bank_id: v.bank_id, amount }
    ]);
    if (!guard.success) return { success: false, error: guard.error };

    const ops: DbBatchOp[] = [insert, ...settlement.ops];
    ops.push(...this.bankSourceInsertOps('receive_vouchers', {
      payment_source: v.payment_source,
      bank_id: v.bank_id,
      date: v.date,
      description: v.bank_description,
      amount,
      referenceId: { $lastId: 0 }
    }));
    ops.push(...this.bankRebuildOps([this.bankIdOf(v.payment_source, v.bank_id)]));

    const res = await this.runBatch(ops);
    if (!res?.success) return { success: false, error: res?.error };
    return { success: true, allocations: settlement.allocations };
  }

  /**
   * Money paid to a supplier: their payable reduced, and the money withdrawn.
   *
   * Much smaller than the receive side, and deliberately: the payable IS
   * `SUM(credit - debit)` over `supplier_ledger`, so one debit row is the whole
   * settlement. There is no `bills` equivalent to allocate across, and nothing
   * is stored on `suppliers` to keep in step.
   *
   * Overpayment is refused against the derived payable, read here rather than
   * trusted from the form.
   */
  async savePaymentVoucher(insert: DbBatchOp, v: {
    supplier_id: number;
    amount: number;
    date: string;
    description: string;
    bank_description: string;
    payment_source?: string | null;
    bank_id?: number | null;
    /** The voucher's own note, copied onto the ledger line it writes. */
    notes?: string | null;
  }): Promise<VoucherSaveResult> {
    const amount = Number(v.amount) || 0;
    if (!(amount > 0)) {
      return { success: false, error: 'Enter an amount greater than zero.' };
    }

    const payableRes = await this.getSupplierPayable(v.supplier_id);
    if (!payableRes.success) return { success: false, error: payableRes.error };
    const payable = Number((payableRes.data && payableRes.data[0]?.payable) || 0);

    if (amount > payable + 0.005) {
      return {
        success: false,
        error: payable > 0
          ? `This supplier is only owed Rs ${payable.toLocaleString()}. ` +
            `Reduce the amount to that, or record the purchase it pays for first.`
          : 'Nothing is owed to this supplier, so there is nothing to pay against.'
      };
    }

    // Paying a supplier out of an account that cannot cover it.
    const guard = await this.checkBankSourceInserts('payment_vouchers', [
      { payment_source: v.payment_source, bank_id: v.bank_id, amount }
    ]);
    if (!guard.success) return { success: false, error: guard.error };

    const ops: DbBatchOp[] = [
      insert,
      this.supplierLedgerEntryOp({
        supplier_id: v.supplier_id,
        transaction_date: v.date,
        description: v.description,
        debit: amount,
        reference_type: 'payment',
        voucher_id: { $lastId: 0 },
        // The note the client typed on the voucher, duplicated onto the
        // statement line. It used to reach `payment_vouchers` and stop there,
        // so the ledger — the screen he actually reads — never showed it.
        notes: v.notes ?? null
      })
    ];
    ops.push(...this.bankSourceInsertOps('payment_vouchers', {
      payment_source: v.payment_source,
      bank_id: v.bank_id,
      date: v.date,
      description: v.bank_description,
      amount,
      referenceId: { $lastId: 0 }
    }));
    ops.push(...this.bankRebuildOps([this.bankIdOf(v.payment_source, v.bank_id)]));

    const res = await this.runBatch(ops);
    if (!res?.success) return { success: false, error: res?.error };
    return { success: true };
  }

  /**
   * Un-makes a receive voucher: the money goes back onto the bills it settled,
   * its ledger lines go, its bank deposit goes, and the balances are rebuilt —
   * all in one batch.
   *
   * The give-back is `customerUnwindOps()`, the same helper
   * `deleteCustomerLedgerEntry()` uses, called once per ledger row the voucher
   * wrote. ONE shared `takenBack` accumulator runs across those calls: every
   * read happens before any statement runs, so two rows that both drew on one
   * bill would otherwise each be credited from that bill's original
   * `amount_paid` and hand back more than it holds.
   *
   * Everything is read BEFORE the batch, which is the rule on every reversal
   * path here: once the entries are gone nothing is left to say which bills to
   * credit or which bank balance to rebuild.
   *
   * A voucher whose ledger rows have since been removed by something else —
   * editing its bill in Sales Orders regenerates that bill's entries by
   * `reference_id` — simply has fewer rows to unwind. Its bank deposit and the
   * voucher row still go, which is the part that would otherwise be left
   * claiming money that is no longer attributed to anything.
   */
  async deleteReceiveVoucher(voucherId: number): Promise<any> {
    const rowRes = await this.get(
      `SELECT voucher_id, customer_id FROM receive_vouchers WHERE voucher_id = ?`,
      [voucherId]
    );
    if (!rowRes.success) return rowRes;
    const voucher = rowRes.data && rowRes.data[0];
    if (!voucher) return { success: false, error: 'That voucher no longer exists.' };

    const customerId = Number(voucher.customer_id);

    const entriesRes = await this.get(
      `SELECT ledger_id, COALESCE(credit, 0) AS credit, reference_id
       FROM customer_ledger WHERE voucher_id = ? ORDER BY ledger_id ASC`,
      [voucherId]
    );
    if (!entriesRes.success) return entriesRes;

    const takenBack: { [billId: number]: number } = {};
    const del: DbBatchOp[] = [];

    for (const entry of (entriesRes.data || [])) {
      const unwound = await this.customerUnwindOps(
        customerId,
        Number(entry.credit) || 0,
        entry.reference_id == null ? null : Number(entry.reference_id),
        takenBack
      );
      if (!unwound.success) return unwound;
      del.push(...(unwound.ops || []));
    }

    del.push({ sql: 'DELETE FROM customer_ledger WHERE voucher_id = ?', params: [voucherId] });
    del.push({ sql: 'DELETE FROM receive_vouchers WHERE voucher_id = ?', params: [voucherId] });
    del.push(this.rebuildCustomerBalanceOp(customerId));

    return this.deleteBankSourced('receive_vouchers', voucherId, del);
  }

  /**
   * Un-makes a payment voucher. Removing the `supplier_ledger` debit IS the
   * reversal — the payable is that table — so there is nothing to put back,
   * and no balance to rebuild on the supplier side. The bank withdrawal goes
   * with it, in the same batch.
   */
  async deletePaymentVoucher(voucherId: number): Promise<any> {
    const rowRes = await this.get(
      `SELECT voucher_id FROM payment_vouchers WHERE voucher_id = ?`,
      [voucherId]
    );
    if (!rowRes.success) return rowRes;
    if (!rowRes.data || rowRes.data.length === 0) {
      return { success: false, error: 'That voucher no longer exists.' };
    }

    return this.deleteBankSourced('payment_vouchers', voucherId, [
      { sql: 'DELETE FROM supplier_ledger WHERE voucher_id = ?', params: [voucherId] },
      { sql: 'DELETE FROM payment_vouchers WHERE voucher_id = ?', params: [voucherId] }
    ]);
  }

  // ── INTERNAL SETTLEMENT ─────────────────────────────────────
  //
  // The owner's farm paying the distribution business for an own-farm bill.
  // Distribution billed the flock, the flock carried the cost and the debt, the
  // flock sold its chickens, and now the debt is cleared. The money is the
  // owner's on both sides of that, which is the one thing that makes this
  // different from every other receipt in this file.
  //
  // WHAT IT IS NOT. It is not a second settlement: the bills, the
  // `customer_ledger` credits and the balance recompute are
  // `customerSettlementOps()`, the same FIFO the Customer Ledger screen and the
  // Receive Voucher screen run. This composes the bank movement and its own row
  // around that, and nothing else.
  //
  // WHY IT IS NOT A BANK_SOURCES TABLE. That mechanism keys exactly ONE entry
  // to a source row's primary key, with one direction declared per table. A
  // settlement writes zero or TWO entries, in opposite directions, on two
  // different accounts. So it takes the named-path shape `assets` and
  // `personal_expenses` have, with its own pair of reference_types.
  //
  // THE SAME-ACCOUNT CASE, which is the whole reason this is its own screen
  // rather than the Receive Voucher screen reused. When the farm pays out of
  // the same account distribution receives into, no money moved: the debt
  // clears and the balance is untouched. NO ledger row is written for either
  // leg.
  //
  // Writing both and relying on the debit and the credit cancelling would be
  // arithmetically equal and structurally wrong — the first future change that
  // skipped one leg, or filtered the ledger by direction, would leave the
  // account wrong, and there would be two lines on a statement describing a
  // movement that never happened. The settlement is bookkeeping; the account
  // did not change.
  //
  // THE INVARIANT, stated for every shape. Bank balances in total move by
  //   (TO is a bank ? +amount : 0) - (FROM is a bank ? +amount : 0)
  // so Bank->Bank (same OR different) and Cash->Cash leave the total
  // IDENTICAL, while Bank->Cash and Cash->Bank move it by exactly the amount —
  // the cash that genuinely left or entered the banked world. Money is never
  // invented: the bank side moves by exactly what crossed its edge.
  //
  // Account-scoped, NOT flock/batch-scoped: it is in no delete cascade, because
  // closing a flock must never un-settle a receipt.

  /** Which account a side of the settlement names, or null when it is cash. */
  private settlementBankId(account?: string | null, bankId?: number | null): number | null {
    return this.bankIdOf(account === 'bank' ? 'bank' : 'cash', bankId);
  }

  /**
   * Records an internal settlement: the own-farm customer's bills settled, the
   * settlement row itself, and — only when the two ends are different accounts
   * — the money moved between them.
   *
   * `insert` is the screen's own INSERT and becomes OPERATION 0, which is
   * load-bearing twice over: the `customer_ledger` credits have to carry its
   * `settlement_id` and so does each bank entry, and `{ $lastId: 0 }` is the
   * only way to name a row inserted in the same batch. This is the shape the
   * vouchers established.
   *
   * OVERPAYMENT IS REFUSED on the settlement's own arithmetic — whatever the
   * FIFO could not place on a bill comes back as `unapplied` — rather than on a
   * second outstanding calculation that could disagree with it.
   */
  async saveInternalSettlement(insert: DbBatchOp, s: {
    customer_id: number;
    amount: number;
    date: string;
    description: string;
    bank_description_out: string;
    bank_description_in: string;
    from_account?: string | null;
    from_bank_id?: number | null;
    to_account?: string | null;
    to_bank_id?: number | null;
  }): Promise<VoucherSaveResult> {
    const amount = Number(s.amount) || 0;
    if (!(amount > 0)) {
      return { success: false, error: 'Enter an amount greater than zero.' };
    }

    const fromBank = this.settlementBankId(s.from_account, s.from_bank_id);
    const toBank = this.settlementBankId(s.to_account, s.to_bank_id);

    const billsRes = await this.getUnpaidBills(s.customer_id);
    if (!billsRes.success) return { success: false, error: billsRes.error };

    const settlement = this.customerSettlementOps({
      customer_id: s.customer_id,
      amount,
      date: s.date,
      description: s.description,
      bills: billsRes.data || [],
      bill_id: null,
      internal_settlement_id: { $lastId: 0 }
    });

    if (settlement.unapplied > 0.005) {
      const applicable = amount - settlement.unapplied;
      return {
        success: false,
        error: applicable > 0
          ? `This farm only owes Rs ${applicable.toLocaleString()}. ` +
            `Reduce the amount to that, or raise the bill for the rest first.`
          : 'This farm has no unpaid bills, so there is nothing to settle.'
      };
    }

    // ONLY THE FROM SIDE CAN GO NEGATIVE, and only when the money really
    // crosses an account boundary. Same account at both ends, or cash at both,
    // writes no ledger row at all and therefore cannot overdraw anything —
    // which is why this is computed off `moved` below rather than off
    // `fromBank` alone. FROM reaching exactly zero is allowed: the client is
    // moving his own money and emptying an account is a legitimate thing to
    // do.
    const moved = fromBank !== toBank;
    const guard = await this.checkBankBalances([
      { bankId: moved ? fromBank : null, delta: -amount },
      { bankId: moved ? toBank : null, delta: amount }
    ]);
    if (!guard.success) return { success: false, error: guard.error };

    const ops: DbBatchOp[] = [insert, ...settlement.ops];

    // The two legs, and the one case that writes neither. `moved` is false when
    // both ends are the same bank account AND when both are cash: in each the
    // money did not cross an account boundary, so there is nothing to record.
    // (`moved` itself is computed above, where the guard needs it.)

    if (moved && fromBank) {
      ops.push(...this.bankWithdrawalOps({
        bankId: fromBank,
        date: s.date,
        description: s.bank_description_out,
        amount,
        referenceType: DatabaseService.INTERNAL_SETTLEMENT_OUT_REF,
        referenceId: { $lastId: 0 },
        deferBalance: true
      }));
    }

    if (moved && toBank) {
      ops.push(...this.bankEntryOps({
        bankId: toBank,
        date: s.date,
        description: s.bank_description_in,
        amount,
        referenceType: DatabaseService.INTERNAL_SETTLEMENT_IN_REF,
        referenceId: { $lastId: 0 },
        direction: 'in',
        deferBalance: true
      }));
    }

    // Deferred to here on purpose, and over the UNION of both ends: rebuilding
    // one mid-batch caches a figure the next statement invalidates. When
    // nothing moved both ids are absent and this is empty — there is no balance
    // to rebuild, because no ledger row was written.
    if (moved) ops.push(...this.bankRebuildOps([fromBank, toBank]));

    const res = await this.runBatch(ops);
    if (!res?.success) return { success: false, error: res?.error };
    return { success: true, allocations: settlement.allocations };
  }

  /**
   * Un-makes an internal settlement: the money goes back onto the bills it
   * cleared, its ledger lines go, both bank legs go, and every balance it
   * touched is rebuilt — all in one batch.
   *
   * The give-back is `customerUnwindOps()`, the same helper
   * `deleteCustomerLedgerEntry()` and `deleteReceiveVoucher()` use, called once
   * per ledger row the settlement wrote with ONE SHARED `takenBack`
   * accumulator across those calls — the `deleteReceiveVoucher()` shape
   * exactly. Every read happens before any statement runs, so two rows that
   * both drew on one bill would otherwise each be credited from that bill's
   * original `amount_paid` and hand back more than it holds.
   *
   * Everything is read BEFORE the batch, the rule on every reversal path here:
   * once the entries are gone nothing is left to say which bills to credit or
   * which balances to rebuild. A same-account settlement has no entries to
   * reverse and nothing to rebuild, which falls out of `fromBank === toBank`
   * rather than being special-cased.
   */
  async deleteInternalSettlement(settlementId: number): Promise<any> {
    const rowRes = await this.get(
      `SELECT settlement_id, customer_id, from_account, from_bank_id, to_account, to_bank_id
       FROM internal_settlements WHERE settlement_id = ?`,
      [settlementId]
    );
    if (!rowRes.success) return rowRes;
    const row = rowRes.data && rowRes.data[0];
    if (!row) return { success: false, error: 'That settlement no longer exists.' };

    const customerId = Number(row.customer_id);
    const fromBank = this.settlementBankId(row.from_account, row.from_bank_id);
    const toBank = this.settlementBankId(row.to_account, row.to_bank_id);
    const moved = fromBank !== toBank;

    const entriesRes = await this.get(
      `SELECT ledger_id, COALESCE(credit, 0) AS credit, reference_id
       FROM customer_ledger WHERE internal_settlement_id = ? ORDER BY ledger_id ASC`,
      [settlementId]
    );
    if (!entriesRes.success) return entriesRes;

    const takenBack: { [billId: number]: number } = {};
    const ops: DbBatchOp[] = [];

    for (const entry of (entriesRes.data || [])) {
      const unwound = await this.customerUnwindOps(
        customerId,
        Number(entry.credit) || 0,
        entry.reference_id == null ? null : Number(entry.reference_id),
        takenBack
      );
      if (!unwound.success) return unwound;
      ops.push(...(unwound.ops || []));
    }

    // Both legs reversed with the balance deferred, so one rebuild per account
    // closes the batch even when the two ends are different accounts.
    if (moved && fromBank) {
      ops.push(...this.bankReversalOps(
        DatabaseService.INTERNAL_SETTLEMENT_OUT_REF, '?', [settlementId], [fromBank], true));
    }
    if (moved && toBank) {
      ops.push(...this.bankReversalOps(
        DatabaseService.INTERNAL_SETTLEMENT_IN_REF, '?', [settlementId], [toBank], true));
    }

    ops.push({ sql: 'DELETE FROM customer_ledger WHERE internal_settlement_id = ?', params: [settlementId] });
    ops.push({ sql: 'DELETE FROM internal_settlements WHERE settlement_id = ?', params: [settlementId] });
    ops.push(this.rebuildCustomerBalanceOp(customerId));
    if (moved) ops.push(...this.bankRebuildOps([fromBank, toBank]));

    return this.runBatch(ops);
  }

  // ── AUTO-SETTLEMENT: A BANK SALE CLEARING THE FARM'S OWN-FARM DEBT ───────
  //
  // Distribution sent feed to a flock and billed it; the flock carried the cost
  // and the debt; the flock sold its chickens into one of the owner's bank
  // accounts. The Internal Settlement screen exists to clear that debt by hand.
  // This does the same thing at the moment the sale is saved, so the client
  // does not have to remember to go and do it.
  //
  // IT IS THE SAME EVENT, NOT A NEW ONE. The bills, the `customer_ledger`
  // credits and the balance recompute are `customerSettlementOps()` — the same
  // FIFO the Customer Ledger screen, the Receive Voucher screen and the
  // Internal Settlement screen run. This is a fourth door onto it, and it
  // composes around that exactly what `saveInternalSettlement()` composes for
  // the same-account case: the settlement row, and nothing else.
  //
  // WHY IT RETURNS OPS INSTEAD OF RUNNING THEM. The settlement has to land in
  // the SAME batch as the sale that caused it. `saveInternalSettlement()` runs
  // its own `runBatch` and takes the screen's INSERT as operation 0, which is
  // right for a screen whose only job is the settlement and wrong for a sale
  // screen that is already assembling a batch. So this is its sibling: same
  // primitives, ops handed back for the caller to splice in.
  //
  // ALWAYS SAME-ACCOUNT, which is the whole point. FROM and TO are both the
  // account the sale was banked into, so `moved` is false and NOT ONE
  // `bank_ledger` ROW IS WRITTEN for the settlement. The bank therefore moves
  // by the SALE AMOUNT ONLY: a 150,000 sale against a 50,000 debt leaves the
  // account 150,000 higher with the debt cleared, because the owner's money
  // never left his account — one of his businesses stopped owing the other.
  // Writing a credit and a debit on one account and trusting them to cancel
  // would be arithmetically equal and structurally wrong; see the note above
  // `saveInternalSettlement()`.
  //
  // NO OVERDRAW GUARD, and none is needed: a settlement that writes no ledger
  // row cannot take an account below zero. `saveInternalSettlement()` derives
  // its own guard off `moved` for the identical reason.
  //
  // OVERVIEW PROFIT DOES NOT MOVE. An own-farm bill is eliminated on its whole
  // `total_amount` regardless of what has been settled, so the owner still
  // cannot manufacture profit by billing himself and then paying himself. The
  // Distribution report's collected-basis revenue DOES rise by the settled
  // amount, which is correct and already how own-farm bills behave there.
  //
  // ACCOUNT-SCOPED, so it is in NO delete cascade — the rule every settlement
  // follows. Closing a flock deletes its `sales` rows and leaves the
  // settlement standing with a dangling `auto_source_id`, deliberately: the
  // debt really was paid and the distribution business really collected it, and
  // un-settling on flock close would resurrect debt the owner has already
  // cleared. Nothing reads that pointer except the sale-delete lookup below.

  /** Which table a flock/batch id belongs to. Whitelisted, never a value. */
  private static readonly AUTO_SETTLE_OWNERS = {
    flock: { table: 'flocks',  pk: 'flock_id' },
    batch: { table: 'batches', pk: 'batch_id' }
  } as const;

  /**
   * The next IS- number, computed IN SQL rather than read into TypeScript
   * first — the `nextLayerBillNumberSql()` / `nextTransactionNumberSql()`
   * idiom, and here it is load-bearing rather than tidy. One save can bank
   * several rows and write several settlements, all assembled into one batch
   * before any of it runs, so a TypeScript-side `MAX + 1` would hand every one
   * of them the same number. Each INSERT does see the row the previous one
   * wrote, so these come out sequential — and they interleave safely with the
   * Internal Settlement screen's own `MAX + 1`, which reads the same column
   * the same way.
   */
  private nextSettlementNumberSql(): string {
    return `(SELECT 'IS-' || CASE WHEN length(CAST(n AS TEXT)) >= 3
                               THEN CAST(n AS TEXT)
                               ELSE substr('000' || CAST(n AS TEXT), -3) END
             FROM (SELECT COALESCE(MAX(CAST(substr(s.settlement_number, 4) AS INTEGER)), 0) + 1 AS n
                   FROM internal_settlements s
                   WHERE s.farm_id = ? AND s.settlement_number LIKE 'IS-%'))`;
  }

  /**
   * For each flock (or batch) named, the own-farm customer that stands for its
   * farm unit and what that farm owes — the read a sale screen does on load to
   * know whether to offer auto-settlement at all.
   *
   * KEYED ON THE FARM UNIT, not on the flock or batch, because that is how an
   * own-farm customer has always been keyed (`resolveOwnFarmCustomerId()` in
   * `sales-orders.component.ts`): flocks close and are deleted, the farm that
   * owes the money does not. A legacy flock with no `unit_id` matches the
   * single `unit_id IS NULL` customer, the same fallback that screen uses.
   *
   * FINDS, NEVER CREATES. No debt means there is no own-farm customer to
   * settle with, and a sale screen inventing one would put a customer on the
   * Customer Ledger for a farm that has never been billed.
   *
   * One statement for the whole list rather than one per owner: the layer
   * screens are unit-scoped rather than batch-scoped, so they ask about every
   * active batch they list.
   */
  async getOwnFarmDebtByOwner(
    farmId: number,
    kind: 'flock' | 'batch',
    ownerIds: number[]
  ): Promise<OwnFarmDebtLookup> {
    const spec = DatabaseService.AUTO_SETTLE_OWNERS[kind];
    if (!spec) return { success: false, error: `Unknown owner kind: ${kind}`, data: [] };

    const ids = Array.from(new Set((ownerIds || []).map(n => Number(n) || 0).filter(n => n > 0)));
    if (ids.length === 0) return { success: true, data: [] };

    const res = await this.get(
      `SELECT o.${spec.pk} AS owner_id, c.customer_id, c.customer_name, c.unit_id,
              (SELECT COALESCE(SUM(MAX(COALESCE(b.total_amount, 0) - COALESCE(b.amount_paid, 0), 0)), 0)
               FROM bills b WHERE b.customer_id = c.customer_id) AS outstanding
       FROM ${spec.table} o
       JOIN customers c
         ON c.farm_id = o.farm_id
        AND COALESCE(c.customer_type, 'external') = 'own_farm'
        AND ((o.unit_id IS NULL AND c.unit_id IS NULL) OR c.unit_id = o.unit_id)
       WHERE o.farm_id = ? AND o.${spec.pk} IN (${ids.map(() => '?').join(',')})`,
      [farmId, ...ids]
    );
    if (!res.success) return { success: false, error: res.error, data: [] };

    return {
      success: true,
      data: (res.data || []).map((r: any) => ({
        owner_id: Number(r.owner_id),
        customer_id: Number(r.customer_id),
        customer_name: r.customer_name || '',
        unit_id: r.unit_id == null ? null : Number(r.unit_id),
        outstanding: Number(r.outstanding) || 0
      }))
    };
  }

  /**
   * The ops for ONE sale's auto-settlement, or none at all.
   *
   * `max_amount` is the sale's own total and the settlement is
   * `min(total_debt, max_amount)`, so all four bounds fall out of one
   * expression: a sale smaller than the debt settles itself and leaves the rest
   * owing, a sale equal to it clears it, a sale larger than it clears it and
   * the extra simply stays in the account, and no debt settles nothing and
   * writes nothing.
   *
   * `base_index` is where op[0] — the settlement row — lands in the CALLER's
   * final batch, so the `customer_ledger` credits can carry
   * `internal_settlement_id: { $lastId: base_index }`. An absolute index, not
   * the usual `-1`, exactly as `layerReceivableOps()` takes one.
   *
   * `source_id` is the sale's own id and arrives as a `{ $lastId: n }` marker
   * on the save path, because the sale has not been inserted yet. That is also
   * why `reference` is a PREFIX concatenated in SQL (`? || ?`) rather than a
   * finished string: built in TypeScript it would read "Auto-settled from
   * Broiler Sale #" with no number on it, and only an edited row would ever
   * carry a complete one.
   *
   * OVERPAYMENT IS IMPOSSIBLE BY CONSTRUCTION — the amount is capped by the
   * very debt the FIFO is about to walk — so a non-zero `unapplied` means the
   * caller threaded a stale bill list, and nothing at all is returned rather
   * than crediting money onto nothing.
   */
  async buildAutoSettleOps(opts: {
    farm_id: number;
    /** Same account at both ends: the account the sale was banked into. */
    from_bank_id: number;
    customer_id: number;
    /** The sale's total. The settlement is capped by it. */
    max_amount: number;
    date: string;
    /** 'Auto-settled from Broiler Sale #' — the sale's id is appended in SQL. */
    reference: string;
    /** `bankOptionLabel()` text, for the statement lines. */
    bank_label: string;
    source: AutoSettleSource;
    /** The sale's id, or `{ $lastId: n }` for a sale inserted in this batch. */
    source_id: any;
    /** Where op[0] lands in the caller's batch. */
    base_index: number;
    /** The unpaid list as an earlier row of the same save left it. */
    bills?: any[];
  }): Promise<AutoSettleResult> {
    const nothing = (bills: any[]): AutoSettleResult => ({
      success: true, ops: [], settledAmount: 0, clearedBillIds: [], allocations: [], bills
    });

    const bankId = Number(opts.from_bank_id) || 0;
    const customerId = Number(opts.customer_id) || 0;
    const cap = Math.round((Number(opts.max_amount) || 0) * 100) / 100;
    if (!bankId || !customerId || !(cap > 0)) return nothing(opts.bills || []);

    let bills: any[];
    if (opts.bills) {
      bills = opts.bills;
    } else {
      const res = await this.getUnpaidBills(customerId);
      if (!res.success) return { ...nothing([]), success: false, error: res.error };
      bills = res.data || [];
    }

    const debt = bills.reduce(
      (sum, b) => sum + Math.max((Number(b.total_amount) || 0) - (Number(b.amount_paid) || 0), 0), 0);
    const amount = Math.round(Math.min(debt, cap) * 100) / 100;
    if (!(amount > 0)) return nothing(bills);

    // The one implementation of the forward settlement, reached through a
    // fourth door. The statements it emits are the ones the other three doors
    // emit, the `internal_settlement_id` tag included.
    const settlement = this.customerSettlementOps({
      customer_id: customerId,
      amount,
      date: opts.date,
      description: `Settlement from ${opts.bank_label} (internal)`,
      bills,
      bill_id: null,
      internal_settlement_id: { $lastId: opts.base_index }
    });

    if (settlement.unapplied > 0.005) {
      return {
        ...nothing(bills),
        success: false,
        error: 'The auto-settlement could not be placed on this farm\'s bills. Nothing was recorded.'
      };
    }

    // THE SETTLEMENT ROW ITSELF. Both ends name the same account, which is what
    // makes this write no bank_ledger row; `notes` is null because nobody typed
    // one. It is op[0] of what this returns, which is what `base_index` names.
    const insert: DbBatchOp = {
      sql: `INSERT INTO internal_settlements
              (farm_id, customer_id, settlement_number, date, amount,
               from_account, from_bank_id, to_account, to_bank_id, reference, notes,
               auto_source_table, auto_source_id)
            VALUES (?, ?, ${this.nextSettlementNumberSql()}, ?, ?,
                    'bank', ?, 'bank', ?, ? || ?, ?, ?, ?)`,
      params: [opts.farm_id, customerId, opts.farm_id, opts.date, amount,
               bankId, bankId, opts.reference, opts.source_id, null,
               opts.source, opts.source_id]
    };

    // The list as this batch will leave it, for the next row of the same save.
    const applied = new Map<number, number>(
      settlement.allocations.map(a => [Number(a.bill_id), a.newPaid] as [number, number]));
    const nextBills = bills.map(b => applied.has(Number(b.bill_id))
      ? { ...b, amount_paid: applied.get(Number(b.bill_id)) }
      : b);

    const totals = new Map<number, number>(
      bills.map(b => [Number(b.bill_id), Number(b.total_amount) || 0] as [number, number]));
    const clearedBillIds = settlement.allocations
      .filter(a => a.newPaid >= (totals.get(Number(a.bill_id)) || 0) - 0.005)
      .map(a => Number(a.bill_id));

    return {
      success: true,
      ops: [insert, ...settlement.ops],
      settledAmount: amount,
      clearedBillIds,
      allocations: settlement.allocations,
      bills: nextBills
    };
  }

  /**
   * Un-makes whatever auto-settlement a sale created, found by the pair of
   * columns that sale stamped on it. Returns success when there is none, so a
   * sale delete can call it unconditionally.
   *
   * The reversal is `deleteInternalSettlement()` — the same one the Internal
   * Settlement screen's own delete runs, so the money goes back onto the bills
   * it cleared through `customerUnwindOps()` with one shared `takenBack`, the
   * ledger lines go, and the balance is rebuilt. There are no bank legs to
   * reverse, because a same-account settlement never wrote any.
   *
   * A loop rather than a single lookup: the column pair carries no unique
   * constraint, so one sale with two settlements against it is reversed
   * completely instead of half way. Called from inside the sale's own
   * `db.transaction()`, where its `runBatch` becomes a SAVEPOINT and the two
   * compose — and if the client has already deleted the settlement by hand on
   * the Internal Settlement screen, this finds nothing and the sale still
   * deletes.
   */
  async deleteAutoSettlementFor(source: AutoSettleSource, sourceId: number): Promise<any> {
    const res = await this.get(
      `SELECT settlement_id FROM internal_settlements
       WHERE auto_source_table = ? AND auto_source_id = ?
       ORDER BY settlement_id ASC`,
      [source, sourceId]
    );
    if (!res.success) return res;

    for (const row of (res.data || [])) {
      const out = await this.deleteInternalSettlement(Number(row.settlement_id));
      if (!out?.success) return out;
    }
    return { success: true };
  }

  /**
   * Which sale table each source names. Deliberately expressed as a
   * `BANK_SOURCES` key rather than a second copy of the table and primary key:
   * the lookup below then reads the pk off that one declaration, and the
   * `spec.ref !== source` check ties the two together so a renamed
   * `reference_type` fails loudly instead of silently reversing nothing.
   */
  private static readonly AUTO_SETTLE_TABLES: { [K in AutoSettleSource]: BankSourceKey } = {
    broiler_sale: 'sales',
    egg_sale: 'egg_sales',
    hen_sale: 'hen_sales'
  };

  /**
   * THE CASCADE. The ops to un-make every auto-settlement belonging to the
   * sales a `WHERE` clause is about to delete.
   *
   * WHY AN AUTO-SETTLEMENT IS IN A CASCADE WHEN NO OTHER SETTLEMENT IS. A
   * hand-entered settlement and a receive voucher are ACCOUNT-scoped: the
   * client typed them, they stand on their own, and closing a flock must never
   * un-settle a receipt. An auto-settlement is SALE-scoped — it carries that
   * sale's primary key in `auto_source_id` and was written in the same batch as
   * that sale's bank deposit, as one event. The cascade already reverses the
   * deposit (`bankCascadeReversalOps`), so leaving the settlement standing
   * reverses one half of an event and keeps the other.
   *
   * What that looked like, which is the whole reason this exists: a 150,000
   * bank sale clears a 50,000 own-farm debt and writes NO bank_ledger row,
   * because both ends name one account. Close the flock and the sale goes and
   * its deposit is reversed — so the account is back where it started and the
   * debt is still cleared, paid by a sale that no longer exists and by money
   * that never left any account. The debt has to come back with the sale.
   *
   * It survives the flock, as it should: `bills` is farm-scoped and an own-farm
   * customer is keyed to the FARM UNIT, so the bill outlives the flock and can
   * be settled by hand afterwards.
   *
   * ONE SHARED `takenBack` ACROSS EVERY SETTLEMENT IN SCOPE, not just within
   * one. Each sale settles whatever was still owing, so two sales of the same
   * flock can both have drawn on one bill; every read here happens before any
   * of the returned statements run, so without the shared accumulator each
   * would be credited from that bill's original `amount_paid` and give back
   * more than it holds. `deleteInternalSettlement()` shares one per settlement;
   * this shares one per cascade, which is the same rule one level up.
   *
   * Returns the ops to run BEFORE the caller's deletes — the settlements and
   * their ledger rows are read here, while they are all still there.
   */
  async autoSettlementCascadeReversalOps(
    source: AutoSettleSource,
    scopeSql: string,
    scopeParams: any[]
  ): Promise<AutoSettleCascadeReversal> {
    const key = DatabaseService.AUTO_SETTLE_TABLES[source];
    const spec = this.bankSource(key);
    if (spec.ref !== source) {
      return {
        success: false,
        error: `Auto-settlement source '${source}' no longer matches ${spec.table}'s reference type.`
      };
    }

    // Scoped by the caller's own clause, module guard included — the identical
    // one it then deletes the sales by, so the two cannot disagree. Without it
    // a flock delete would reverse the colliding layer batch's settlements.
    const found = await this.get(
      `SELECT settlement_id, customer_id, from_account, from_bank_id, to_account, to_bank_id
       FROM internal_settlements
       WHERE auto_source_table = ?
         AND auto_source_id IN (SELECT ${spec.pk} FROM ${spec.table} WHERE ${scopeSql})`,
      [source, ...scopeParams]
    );
    if (!found.success) return { success: false, error: found.error };

    const settlements = found.data || [];
    if (settlements.length === 0) return { success: true, ops: [] };

    const ops: DbBatchOp[] = [];
    const takenBack: { [billId: number]: number } = {};
    const customers = new Set<number>();
    const bankIds: number[] = [];

    for (const row of settlements) {
      const customerId = Number(row.customer_id);
      customers.add(customerId);

      const entries = await this.get(
        `SELECT ledger_id, COALESCE(credit, 0) AS credit, reference_id
         FROM customer_ledger WHERE internal_settlement_id = ? ORDER BY ledger_id ASC`,
        [row.settlement_id]
      );
      if (!entries.success) return { success: false, error: entries.error };

      // The give-back is `customerUnwindOps()` — the one implementation of this
      // direction, shared with every other reversal in this file.
      for (const entry of (entries.data || [])) {
        const unwound = await this.customerUnwindOps(
          customerId,
          Number(entry.credit) || 0,
          entry.reference_id == null ? null : Number(entry.reference_id),
          takenBack
        );
        if (!unwound.success) return { success: false, error: unwound.error };
        ops.push(...(unwound.ops || []));
      }

      // An auto-settlement always names ONE account at both ends, so it has no
      // bank legs and this is empty today. Guarded anyway, for the same reason
      // `sales` and `balance` carry a module guard no layer screen needs yet:
      // it costs nothing, and it means a future different-account auto-settlement
      // cannot strand a ledger entry here.
      const fromBank = this.settlementBankId(row.from_account, row.from_bank_id);
      const toBank = this.settlementBankId(row.to_account, row.to_bank_id);
      if (fromBank !== toBank) {
        if (fromBank) {
          ops.push(...this.bankReversalOps(
            DatabaseService.INTERNAL_SETTLEMENT_OUT_REF, '?', [row.settlement_id], [fromBank], true));
          bankIds.push(fromBank);
        }
        if (toBank) {
          ops.push(...this.bankReversalOps(
            DatabaseService.INTERNAL_SETTLEMENT_IN_REF, '?', [row.settlement_id], [toBank], true));
          bankIds.push(toBank);
        }
      }
    }

    // One statement for the lot rather than one per settlement, and the
    // balances rebuilt once at the end — a rebuild mid-batch caches a figure
    // the next statement invalidates.
    const ids = settlements.map((r: any) => Number(r.settlement_id));
    const list = ids.map(() => '?').join(',');
    ops.push({
      sql: `DELETE FROM customer_ledger WHERE internal_settlement_id IN (${list})`,
      params: ids
    });
    ops.push({
      sql: `DELETE FROM internal_settlements WHERE settlement_id IN (${list})`,
      params: ids
    });
    for (const customerId of customers) ops.push(this.rebuildCustomerBalanceOp(customerId));
    ops.push(...this.bankRebuildOps(bankIds));

    return { success: true, ops };
  }

  /** Distinct house accounts an asset's bank-sourced payments were drawn from. */
  private async bankIdsForAsset(assetId: number): Promise<number[]> {
    // Both directions. An asset can have paid money OUT through one account
    // (its installments) and taken money IN through another (its sale), and a
    // delete has to rebuild every account it touched — read here, before the
    // batch, because once the entries are gone nothing says which they were.
    const res = await this.get(
      `SELECT DISTINCT bank_id FROM asset_payments
        WHERE asset_id = ? AND bank_id IS NOT NULL
       UNION
       SELECT DISTINCT sale_bank_id FROM assets
        WHERE asset_id = ? AND sale_bank_id IS NOT NULL`,
      [assetId, assetId]
    );
    if (!res.success || !res.data) return [];
    return res.data.map((r: any) => Number(r.bank_id)).filter((n: number) => !!n);
  }

  // ── OVERVIEW: DEBT PAYMENT — A NOTEBOOK, CONNECTED TO NOTHING ───────
  //
  // Somewhere for the client to write down who took money off him and
  // disappeared, so that he can remember it. The Overview > Debt Payment
  // screen's own store, and nothing else in this app reads it.
  //
  // THESE FOUR METHODS ARE DELIBERATELY THE DULLEST IN THIS FILE, and they must
  // stay that way. No `payment_source`/`bank_id` pair, no `BANK_SOURCES` entry,
  // no `bank_ledger` row, no overdraw guard, no `runBatch`, no term in
  // `cash-position.service.ts`, no cascade — a plain insert, a plain update, a
  // plain delete. The amount recorded here has NOT moved through the drawer or
  // an account as far as this app is concerned; whether it ever really did is
  // precisely the thing being noted down. Giving it a money path would either
  // double-count a rupee some other screen already recorded, or invent one that
  // was never recorded at all.
  //
  // `scripts/verify/verify_debt_records.js` asserts exactly that, so the
  // inertness is a checked property rather than a comment. Argue with it first.

  /** Every note on this account, newest first. */
  async getDebtRecords(farmId: number): Promise<any> {
    return this.get(
      `SELECT * FROM debt_records
       WHERE farm_id = ?
       ORDER BY date DESC, debt_id DESC`,
      [farmId]
    );
  }

  async addDebtRecord(record: {
    farm_id: number;
    person_name: string;
    phone?: string | null;
    date?: string | null;
    amount?: number | null;
    status?: string | null;
    notes?: string | null;
  }): Promise<any> {
    if (!record.farm_id || !(record.person_name || '').trim()) {
      return { success: false, error: 'A name is required.' };
    }
    return this.run(
      `INSERT INTO debt_records (farm_id, person_name, phone, date, amount, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.farm_id, record.person_name.trim(), record.phone || null,
       record.date || null, Number(record.amount) || 0,
       record.status || 'outstanding', record.notes || null]
    );
  }

  async updateDebtRecord(debtId: number, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    const set = (col: string, value: any) => { fields.push(`${col} = ?`); values.push(value); };

    if (data.person_name !== undefined) set('person_name', String(data.person_name).trim());
    if (data.phone !== undefined) set('phone', data.phone || null);
    if (data.date !== undefined) set('date', data.date || null);
    if (data.amount !== undefined) set('amount', Number(data.amount) || 0);
    if (data.status !== undefined) set('status', data.status || 'outstanding');
    if (data.notes !== undefined) set('notes', data.notes || null);

    if (fields.length === 0) return { success: false, error: 'No fields to update' };
    values.push(debtId);
    return this.run(
      `UPDATE debt_records SET ${fields.join(', ')} WHERE debt_id = ?`, values);
  }

  /**
   * One note, gone. Nothing to reverse: no entry was ever posted for it, which
   * is the whole design.
   */
  async deleteDebtRecord(debtId: number): Promise<any> {
    return this.run('DELETE FROM debt_records WHERE debt_id = ?', [debtId]);
  }

  // ── OVERVIEW: LOANS AND ADVANCES ────────────────────────────
  //
  // Money the owner lent out ('given' -> a receivable) and money other people
  // left with him or lent him ('received' -> a payable). One table with a
  // direction; see the `loans` comment in electron/database.js for why.
  //
  // A LOAN IS NEVER INCOME AND NEVER AN EXPENSE. Nothing here enters any profit
  // figure on any report — `overview.service.ts` reads these two tables only
  // for the two outstanding cards, and `cash-position.service.ts` only for
  // where the money physically went. Treating a loan as revenue would show the
  // owner a profit on money he has to give back; treating one he made as an
  // expense would show him a loss on money coming back to him.
  //
  // WHICH WAY THE MONEY MOVES, per row:
  //
  //   direction   principal          a payment against it
  //   ----------  -----------------  --------------------------
  //   'given'     money OUT (WD-)    money IN  (DEP-)
  //   'received'  money IN  (DEP-)   money OUT (WD-)
  //
  // So the bank direction is derived from the loan, which is exactly why this
  // is a named path and not a BANK_SOURCES table.

  /** 'given' loans pay out their principal; 'received' loans take it in. */
  private loanPrincipalDirection(direction: string | null | undefined): 'in' | 'out' {
    return direction === 'received' ? 'in' : 'out';
  }

  /** A payment always runs against the principal. */
  private loanPaymentDirection(direction: string | null | undefined): 'in' | 'out' {
    return direction === 'received' ? 'out' : 'in';
  }

  /**
   * Every loan with what is still outstanding on it, newest first.
   *
   * `outstanding` is DERIVED on every read — principal less what has been
   * settled, floored at zero — and there is deliberately no stored column for
   * it. The supplier side of this app already proves the point: a stored
   * balance drifts from the rows behind it and has to be rebuilt by hand on
   * every path, while a derived one cannot disagree with anything.
   */
  async getLoans(farmId: number, direction?: 'given' | 'received'): Promise<any> {
    const params: any[] = [farmId];
    let where = 'l.farm_id = ?';
    if (direction) { where += ' AND COALESCE(l.direction, \'given\') = ?'; params.push(direction); }
    return this.get(
      `SELECT l.*,
              b.bank_name,
              COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.loan_id), 0) AS settled,
              MAX(COALESCE(l.principal, 0) -
                  COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.loan_id), 0), 0)
                AS outstanding
       FROM loans l
       LEFT JOIN bank_accounts b ON b.bank_id = l.bank_id
       WHERE ${where}
       ORDER BY l.date DESC, l.loan_id DESC`,
      params
    );
  }

  /** One loan's settlements, newest first, each naming its own account. */
  async getLoanPayments(loanId: number, farmId: number): Promise<any> {
    return this.get(
      `SELECT p.*, b.bank_name
       FROM loan_payments p
       LEFT JOIN bank_accounts b ON b.bank_id = p.bank_id
       WHERE p.loan_id = ? AND p.farm_id = ?
       ORDER BY p.date DESC, p.payment_id DESC`,
      [loanId, farmId]
    );
  }

  /**
   * The two headline figures: what is owed TO the owner and what he owes.
   *
   * Both come off the same derivation `getLoans()` returns, so a card and the
   * list behind it cannot print different numbers — the rule the two
   * outstanding cards on the Distribution Report already follow.
   */
  async getLoanTotals(farmId: number): Promise<LoanTotals> {
    const res = await this.get(
      `SELECT COALESCE(l.direction, 'given') AS direction,
              COALESCE(SUM(MAX(COALESCE(l.principal, 0) -
                COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.loan_id), 0), 0)), 0) AS amount
       FROM loans l
       WHERE l.farm_id = ?
       GROUP BY COALESCE(l.direction, 'given')`,
      [farmId]
    );
    if (!res.success) return { receivable: 0, payable: 0, error: res.error };
    let receivable = 0, payable = 0;
    for (const row of res.data || []) {
      if (row.direction === 'received') payable += Number(row.amount) || 0;
      else receivable += Number(row.amount) || 0;
    }
    return { receivable, payable };
  }

  /**
   * Records a loan, and the bank movement for its principal when it went
   * through an account.
   *
   * The overdraw guard applies to the OUTGOING direction only — lending money
   * out of an account that cannot cover it. Being lent money raises a balance
   * and can never overdraw one.
   */
  async addLoan(loan: {
    farm_id: number;
    direction: 'given' | 'received';
    party_name: string;
    phone?: string | null;
    date: string;
    principal: number;
    notes?: string | null;
    payment_source?: string | null;
    bank_id?: number | null;
  }): Promise<any> {
    const amount = Number(loan.principal) || 0;
    if (!loan.farm_id || !loan.date || !(loan.party_name || '').trim()) {
      return { success: false, error: 'Party name, date and amount are required.' };
    }
    if (!(amount > 0)) {
      return { success: false, error: 'Enter an amount greater than zero.' };
    }

    const direction = loan.direction === 'received' ? 'received' : 'given';
    const bank = this.bankIdOf(loan.payment_source, loan.bank_id);
    const source = bank ? 'bank' : 'cash';
    if (loan.payment_source === 'bank' && !bank) {
      return { success: false, error: 'Choose which bank account this money moved through.' };
    }

    const way = this.loanPrincipalDirection(direction);
    if (bank && way === 'out') {
      const guard = await this.checkBankBalances([{ bankId: bank, delta: -amount }]);
      if (!guard.success) return guard;
    }

    const insert: DbBatchOp = {
      sql: `INSERT INTO loans
              (farm_id, direction, party_name, phone, date, principal, notes, payment_source, bank_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [loan.farm_id, direction, loan.party_name.trim(), loan.phone || null,
               loan.date, amount, loan.notes || null, source, bank]
    };

    if (!bank) return this.run(insert.sql, insert.params);

    return this.runBatch([
      insert,
      ...this.bankEntryOps({
        bankId: bank,
        date: loan.date,
        description: (direction === 'received' ? 'Loan received from ' : 'Loan given to ') + loan.party_name.trim(),
        amount,
        referenceType: DatabaseService.LOAN_REF,
        referenceId: { $lastId: -1 },
        direction: way,
        deferBalance: true
      }),
      ...this.bankRebuildOps([bank])
    ]);
  }

  /**
   * Edits a loan. The principal's bank movement is REVERSED AND RE-POSTED
   * rather than patched — the one shape that covers every transition, exactly
   * as `updatePersonalExpense()` and `saveBankSourceEdit()` do. The rebuild is
   * deferred and covers the UNION of the old and new accounts: rebuilding one
   * mid-batch caches a figure the next statement invalidates, and rebuilding
   * only the new one leaves the old counting a movement it no longer has.
   *
   * The direction is editable too, which is the one transition unique to this
   * table: changing 'given' to 'received' turns a withdrawal into a deposit,
   * and the reverse-and-re-post shape handles that without a branch.
   */
  async updateLoan(loanId: number, data: any): Promise<any> {
    const current = await this.get('SELECT * FROM loans WHERE loan_id = ?', [loanId]);
    if (!current.success) return current;
    if (!current.data || current.data.length === 0) {
      return { success: false, error: 'Loan not found' };
    }
    const row = current.data[0];

    const fields: string[] = [];
    const values: any[] = [];
    const set = (col: string, value: any) => { fields.push(`${col} = ?`); values.push(value); };

    if (data.direction !== undefined) set('direction', data.direction === 'received' ? 'received' : 'given');
    if (data.party_name !== undefined) set('party_name', String(data.party_name).trim());
    if (data.phone !== undefined) set('phone', data.phone || null);
    if (data.date !== undefined) set('date', data.date);
    if (data.principal !== undefined) set('principal', Number(data.principal) || 0);
    if (data.notes !== undefined) set('notes', data.notes || null);
    if (data.payment_source !== undefined || data.bank_id !== undefined) {
      const nextBank = this.bankIdOf(
        data.payment_source !== undefined ? data.payment_source : row.payment_source,
        data.bank_id !== undefined ? data.bank_id : row.bank_id);
      set('payment_source', nextBank ? 'bank' : 'cash');
      set('bank_id', nextBank);
    }
    if (fields.length === 0) return { success: false, error: 'No fields to update' };
    values.push(loanId);

    // Fields absent from `data` fall back to the row's own, so a partial update
    // still re-posts the movement from the right date, amount and account.
    const nextDirection = (data.direction !== undefined
      ? (data.direction === 'received' ? 'received' : 'given')
      : (row.direction || 'given'));
    const nextAmount = Number(data.principal !== undefined ? data.principal : row.principal) || 0;
    const nextDate = data.date !== undefined ? data.date : row.date;
    const nextParty = String(data.party_name !== undefined ? data.party_name : row.party_name || '').trim();
    const nextBank = this.bankIdOf(
      data.payment_source !== undefined ? data.payment_source : row.payment_source,
      data.bank_id !== undefined ? data.bank_id : row.bank_id);
    const oldBank = this.bankIdOf(row.payment_source, row.bank_id);
    const way = this.loanPrincipalDirection(nextDirection);

    // Both halves of the edit count, netted per account: the reversal gives back
    // whatever the old entry took (or takes back whatever it gave), and the
    // re-post takes its sign from the NEW direction. Checked over the union,
    // because an edit that moves money from one account to another can overdraw
    // the first even though the second ends up richer.
    const deltas: BankDelta[] = [];
    if (oldBank) deltas.push({ bankId: oldBank, delta: -(await this.bankEntryEffect(DatabaseService.LOAN_REF, loanId)) });
    if (nextBank) deltas.push({ bankId: nextBank, delta: way === 'out' ? -nextAmount : nextAmount });
    const guard = await this.checkBankBalances(deltas);
    if (!guard.success) return guard;

    const ops: DbBatchOp[] = [];
    if (oldBank) {
      ops.push(...this.bankReversalOps(DatabaseService.LOAN_REF, '?', [loanId], [oldBank], true));
    }
    ops.push({
      sql: `UPDATE loans SET ${fields.join(', ')} WHERE loan_id = ?`,
      params: values
    });
    if (nextBank) {
      ops.push(...this.bankEntryOps({
        bankId: nextBank,
        date: nextDate,
        description: (nextDirection === 'received' ? 'Loan received from ' : 'Loan given to ') + nextParty,
        amount: nextAmount,
        referenceType: DatabaseService.LOAN_REF,
        referenceId: loanId,
        direction: way,
        // The number belongs to the old account's sequence, so it is carried
        // over only when the account has not moved.
        transactionNumber: (oldBank === nextBank) ? (row.ledger_number || null) : null,
        deferBalance: true
      }));
    }
    ops.push(...this.bankRebuildOps([oldBank, nextBank]));

    return this.runBatch(ops);
  }

  /**
   * Deletes a loan, its settlements and every bank entry any of them wrote.
   *
   * Nothing cascades in this database (`PRAGMA foreign_keys` is never on), so
   * the payments have to go explicitly or they are left pointing at a loan that
   * no longer exists — and their bank entries with them, or an account keeps
   * showing money moving for a loan nobody can see.
   *
   * NEVER GUARDED. Removing a withdrawal puts money back and removing a deposit
   * un-makes a record the client has already decided was wrong; refusing it
   * would strand a row that cannot be corrected. A delete may legitimately
   * leave an account negative.
   */
  async deleteLoan(loanId: number): Promise<any> {
    // Read the accounts BEFORE the batch: once the entries are gone there is
    // nothing left to say which balances to rebuild.
    const res = await this.get(
      `SELECT bank_id FROM loans WHERE loan_id = ? AND bank_id IS NOT NULL
       UNION
       SELECT bank_id FROM loan_payments WHERE loan_id = ? AND bank_id IS NOT NULL`,
      [loanId, loanId]
    );
    if (!res.success) return res;
    const bankIds = (res.data || []).map((r: any) => Number(r.bank_id)).filter((n: number) => !!n);

    return this.runBatch([
      ...this.bankReversalOps(DatabaseService.LOAN_REF, '?', [loanId], bankIds, true),
      ...this.bankReversalOps(
        DatabaseService.LOAN_PAYMENT_REF,
        'SELECT payment_id FROM loan_payments WHERE loan_id = ?', [loanId], bankIds, true
      ),
      { sql: 'DELETE FROM loan_payments WHERE loan_id = ?', params: [loanId] },
      { sql: 'DELETE FROM loans WHERE loan_id = ?', params: [loanId] },
      ...this.bankRebuildOps(bankIds)
    ]);
  }

  /**
   * One settlement against a loan, and its bank movement.
   *
   * REFUSED when it would take the loan past square. An overpayment on a loan
   * is not a thing that happened: either the amount is wrong or the principal
   * is, and quietly recording a negative outstanding hides which. Same
   * reasoning as the voucher screens' overpayment refusal.
   */
  async addLoanPayment(payment: {
    loan_id: number;
    farm_id: number;
    date: string;
    amount: number;
    notes?: string | null;
    payment_source?: string | null;
    bank_id?: number | null;
  }): Promise<any> {
    const amount = Number(payment.amount) || 0;
    if (!payment.loan_id || !payment.farm_id || !payment.date) {
      return { success: false, error: 'loan_id, farm_id and date are required' };
    }
    if (!(amount > 0)) {
      return { success: false, error: 'Enter an amount greater than zero.' };
    }

    const loanRes = await this.get(
      `SELECT l.*,
              COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.loan_id), 0) AS settled
       FROM loans l WHERE l.loan_id = ? AND l.farm_id = ?`,
      [payment.loan_id, payment.farm_id]
    );
    if (!loanRes.success) return loanRes;
    if (!loanRes.data || loanRes.data.length === 0) {
      return { success: false, error: 'Loan not found' };
    }
    const loan = loanRes.data[0];
    const outstanding = Math.round((Number(loan.principal) - Number(loan.settled)) * 100) / 100;

    if (amount > outstanding + 0.005) {
      return {
        success: false,
        error: outstanding > 0
          ? `Only Rs. ${outstanding.toLocaleString()} is still outstanding on this loan. ` +
            'Reduce the amount, or correct the loan itself.'
          : 'This loan is already settled in full, so there is nothing left to record against it.'
      };
    }

    const bank = this.bankIdOf(payment.payment_source, payment.bank_id);
    if (payment.payment_source === 'bank' && !bank) {
      return { success: false, error: 'Choose which bank account this money moved through.' };
    }
    const way = this.loanPaymentDirection(loan.direction);
    if (bank && way === 'out') {
      const guard = await this.checkBankBalances([{ bankId: bank, delta: -amount }]);
      if (!guard.success) return guard;
    }

    const insert: DbBatchOp = {
      sql: `INSERT INTO loan_payments (loan_id, farm_id, date, amount, notes, payment_source, bank_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [payment.loan_id, payment.farm_id, payment.date, amount,
               payment.notes || null, bank ? 'bank' : 'cash', bank]
    };

    if (!bank) return this.run(insert.sql, insert.params);

    return this.runBatch([
      insert,
      ...this.bankEntryOps({
        bankId: bank,
        date: payment.date,
        description: (loan.direction === 'received' ? 'Loan repaid to ' : 'Loan repayment from ') +
                     (loan.party_name || 'party'),
        amount,
        referenceType: DatabaseService.LOAN_PAYMENT_REF,
        referenceId: { $lastId: -1 },
        direction: way,
        deferBalance: true
      }),
      ...this.bankRebuildOps([bank])
    ]);
  }

  /** One settlement and its bank entry, together. Never guarded — see above. */
  async deleteLoanPayment(paymentId: number): Promise<any> {
    const res = await this.get(
      'SELECT bank_id FROM loan_payments WHERE payment_id = ?', [paymentId]);
    if (!res.success) return res;
    if (!res.data || res.data.length === 0) {
      return { success: false, error: 'Payment not found' };
    }
    const bankId = Number(res.data[0].bank_id) || null;

    const del: DbBatchOp = {
      sql: 'DELETE FROM loan_payments WHERE payment_id = ?', params: [paymentId]
    };
    if (!bankId) return this.run(del.sql, del.params);

    return this.runBatch([
      ...this.bankReversalOps(DatabaseService.LOAN_PAYMENT_REF, '?', [paymentId], [bankId]),
      del
    ]);
  }

  // ── OVERVIEW: FIXED ASSET METHODS ───────────────────────────
  // Account-level (farm_id scoped, not flock/batch scoped). Assets are bought on
  // installments: `total_price` is the agreed price and the asset's
  // `asset_payments` rows are what has actually been handed over. No
  // depreciation — gain/loss is only recognised when an asset is sold, and it is
  // measured against the full agreed price whether or not it has been paid off.
  //
  // `purchase_amount` is the legacy column that predates installments, when an
  // asset was bought outright and it was both price and payment. It is written
  // with the same value as total_price on every path here so that anything still
  // reading it (older report code, a restored pre-migration backup) gets the
  // right number rather than a silent zero. Never write one without the other.
  //
  // Unlike total_price, purchase_amount is `NOT NULL DEFAULT 0` and always was
  // — it cannot hold total_price's "unknown" null. When the price is unset,
  // total_price stays null and purchase_amount gets 0, its own column default.
  // Every read that derives agreed_price therefore uses
  // `COALESCE(total_price, NULLIF(purchase_amount, 0))`, not a plain COALESCE —
  // NULLIF is what stops that 0 placeholder from reading back as a real
  // "asset costs nothing" price. A genuinely free/donated legacy asset would
  // read the same way (agreed_price null), which is an acceptable edge case,
  // not a bug this was meant to solve.

  /**
   * Assets with their payment totals attached. The LEFT JOIN keeps assets that
   * have no payments yet; COALESCE(total_price, purchase_amount) covers rows
   * written before the installments migration ran.
   */
  async getAssets(farmId: number, status?: string): Promise<any> {
    let sql =
      `SELECT a.*,
              COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) AS agreed_price,
              COALESCE(p.paid, 0) AS amount_paid,
              CASE WHEN a.total_price IS NULL AND NULLIF(a.purchase_amount, 0) IS NULL THEN NULL
                   ELSE COALESCE(a.total_price, a.purchase_amount, 0) - COALESCE(p.paid, 0) END AS amount_outstanding,
              COALESCE(p.payment_count, 0) AS payment_count
       FROM assets a
       LEFT JOIN (
         SELECT asset_id, SUM(amount) AS paid, COUNT(*) AS payment_count
         FROM asset_payments GROUP BY asset_id
       ) p ON p.asset_id = a.asset_id
       WHERE a.farm_id = ?`;
    const params: any[] = [farmId];
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY a.purchase_date DESC, a.asset_id DESC';
    return this.get(sql, params);
  }

  async getAsset(assetId: number, farmId: number): Promise<any> {
    return this.get(
      `SELECT a.*,
              COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) AS agreed_price
       FROM assets a WHERE a.asset_id = ? AND a.farm_id = ?`,
      [assetId, farmId]
    );
  }

  /**
   * Creates an asset and, when a down payment was entered, its first payment
   * and — if that payment came out of a bank account — the withdrawal for it,
   * all atomically. Each statement references the row the last one inserted
   * with `{ $lastId: -1 }` rather than a round trip, so there is no window
   * where an asset exists without its opening payment, or a bank-sourced
   * payment exists without the withdrawal that funded it.
   */
  async addAsset(asset: {
    farm_id: number;
    unit_id?: number | null;
    asset_name: string;
    category?: string | null;
    purchase_date: string;
    total_price?: number | null;
    payment_source?: string;
    bank_id?: number | null;
    notes?: string | null;
    initial_payment?: number | null;
  }): Promise<any> {
    const {
      farm_id, unit_id, asset_name, category, purchase_date,
      total_price, payment_source, bank_id, notes, initial_payment
    } = asset;
    if (!farm_id || !asset_name || !purchase_date) {
      return { success: false, error: 'farm_id, asset_name and purchase_date are required' };
    }

    // The agreed price is not always known up front — left null (not 0), so
    // outstanding is "unknown" rather than "nothing owed" until it is set.
    const price = (total_price !== undefined && total_price !== null) ? total_price : null;
    const source = payment_source === 'bank' ? 'bank' : 'cash';
    const bank = source === 'bank' ? (bank_id || null) : null;
    const down = initial_payment || 0;

    if (source === 'bank' && down > 0 && !bank) {
      return { success: false, error: 'Choose which bank account the payment came from.' };
    }

    // The down payment leaves the account the moment this saves, so the
    // account has to be able to stand it. Checked before the batch; nothing
    // at all is written when it cannot.
    if (bank && down > 0) {
      const guard = await this.checkBankBalances([{ bankId: bank, delta: -down }]);
      if (!guard.success) return guard;
    }

    // purchase_amount is NOT NULL (it predates total_price and still mirrors
    // it for legacy readers) so it cannot carry the same "unknown" null that
    // total_price can. 0 is its own schema default and is read back as "no
    // legacy value" by the NULLIF(...,0) guards on every agreed_price query
    // below — never treated as a real zero price.
    const ops: DbBatchOp[] = [{
      sql: `INSERT INTO assets (farm_id, unit_id, asset_name, category, purchase_date, total_price, purchase_amount, payment_source, bank_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [farm_id, unit_id || null, asset_name, category || null, purchase_date, price, price ?? 0, source, bank, notes || null]
    }];

    if (down > 0) {
      ops.push({
        sql: `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [{ $lastId: -1 }, farm_id, purchase_date, down, source, bank, 'Initial payment']
      });

      if (bank) {
        ops.push(...this.bankWithdrawalOps({
          bankId: bank,
          date: purchase_date,
          description: `Asset payment — ${asset_name} (initial payment)`,
          amount: down,
          referenceType: DatabaseService.ASSET_PAYMENT_REF,
          referenceId: { $lastId: -1 }
        }));
      }
    }

    return ops.length === 1 ? this.run(ops[0].sql, ops[0].params) : this.runBatch(ops);
  }

  async updateAsset(assetId: number, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.unit_id !== undefined) { fields.push('unit_id = ?'); values.push(data.unit_id); }
    if (data.asset_name !== undefined) { fields.push('asset_name = ?'); values.push(data.asset_name); }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
    if (data.purchase_date !== undefined) { fields.push('purchase_date = ?'); values.push(data.purchase_date); }
    // total_price and purchase_amount are one value stored in two columns.
    // Setting either updates both — letting a caller move one alone is exactly
    // how the two would drift apart. newPrice may be explicitly null (the
    // price being cleared back to "unknown"); purchase_amount still can't
    // hold that, so it gets the same 0 sentinel addAsset() uses.
    const newPrice = data.total_price !== undefined ? data.total_price
                   : data.purchase_amount !== undefined ? data.purchase_amount
                   : undefined;
    if (newPrice !== undefined) {
      fields.push('total_price = ?'); values.push(newPrice);
      fields.push('purchase_amount = ?'); values.push(newPrice ?? 0);
    }
    if (data.payment_source !== undefined) { fields.push('payment_source = ?'); values.push(data.payment_source); }
    if (data.bank_id !== undefined) { fields.push('bank_id = ?'); values.push(data.bank_id); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };

    values.push(assetId);
    return this.run(`UPDATE assets SET ${fields.join(', ')} WHERE asset_id = ?`, values);
  }

  /**
   * Marks an asset sold and SETTLES whatever is still owed on it.
   *
   * The sale hands the asset over, so the debt against it goes with it: the
   * remaining balance is written as a settlement payment dated on the sale date,
   * and the asset's outstanding falls to zero. Without it the client's books
   * never balance — an asset bought for 100,000 with 10,000 paid and sold for
   * 110,000 read as +100,000 of cash (110,000 in, 10,000 out) while still
   * showing 90,000 owed on something he no longer owns. With the settlement the
   * same sale reads as -10,000 -90,000 +110,000 = +10,000, which is the profit
   * he actually made.
   *
   * The settlement is a real, visible `asset_payments` row flagged
   * `is_settlement = 1`, not a silent adjustment: the payment history labels it
   * so the reason the balance cleared is on screen. It is dated the SALE date,
   * not today, so it lands in the same period as the sale and the Overview's
   * money-in/money-out for that period nets to the gain on it.
   *
   * One batch, so an asset can never end up marked sold with its settlement
   * missing (which would leave the stale balance this exists to clear).
   *
   * WHERE THE SETTLEMENT MONEY COMES FROM. The settlement is a real payment,
   * so now that a bank-sourced payment moves a real bank balance it needs a
   * real source, and the caller has to say what it is — `settlement` comes
   * straight off the Sell form's Cash/Bank selector. It is deliberately NOT
   * inherited from `assets.payment_source`/`bank_id`: those record how the
   * asset's FIRST payment was made, and settling a Rs 90,000 balance out of a
   * bank account on that basis alone would post a withdrawal the owner never
   * made, in an amount he never chose, off a screen that never mentioned it.
   * Omitting `settlement` therefore falls back to cash — the option that moves
   * no bank balance — never to a bank account.
   */
  async sellAsset(
    assetId: number,
    saleDate: string,
    saleAmount: number,
    settlement?: { payment_source?: string; bank_id?: number | null },
    /**
     * Where the SALE MONEY went. Bank deposits the proceeds into that account;
     * cash (the default) leaves no entry, which is exactly what makes it reach
     * Cash in Hand instead — see `asset_sales_in` in cash-position.service.ts.
     *
     * Separate from `settlement`, which is money going the OTHER way: the
     * outstanding balance being cleared. One sale can do both, and they can
     * legitimately be different accounts.
     */
    proceeds?: { payment_source?: string; bank_id?: number | null }
  ): Promise<any> {
    const existing = await this.get(
      `SELECT a.farm_id,
              a.status,
              a.asset_name,
              COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) AS agreed_price,
              COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                        WHERE p.asset_id = a.asset_id), 0) AS amount_paid
       FROM assets a WHERE a.asset_id = ?`,
      [assetId]
    );
    if (!existing.success) return existing;
    if (!existing.data || existing.data.length === 0) {
      return { success: false, error: 'Asset not found' };
    }
    const asset = existing.data[0];
    if (asset.status === 'sold') {
      return { success: false, error: 'Asset is already sold' };
    }

    const proceedsSource = proceeds?.payment_source === 'bank' ? 'bank' : 'cash';
    const proceedsBank = proceedsSource === 'bank' ? (proceeds?.bank_id || null) : null;
    if (proceedsSource === 'bank' && !proceedsBank) {
      return { success: false, error: 'Choose which bank account the sale money was received into.' };
    }

    const ops: DbBatchOp[] = [{
      sql: `UPDATE assets SET status = 'sold', sale_date = ?, sale_amount = ?,
                   sale_payment_source = ?, sale_bank_id = ?
            WHERE asset_id = ?`,
      params: [saleDate, saleAmount, proceedsSource, proceedsBank, assetId]
    }];

    // THE PROCEEDS, as a deposit on the chosen account. Written before the
    // settlement below on purpose: a sale whose money lands in the same account
    // the outstanding balance is then paid out of has the deposit first, so the
    // account is never momentarily short of a balance it actually had. (The
    // overdraw guard weighs the whole batch as a net delta per account, so this
    // is about the ledger reading in the order the money moved, not about
    // getting past a check.)
    //
    // Keyed to the ASSET's id, which is known here — no `$lastId` marker, since
    // nothing in this batch inserts the row it points at.
    if (proceedsBank && Number(saleAmount) > 0) {
      ops.push(...this.bankEntryOps({
        bankId: proceedsBank,
        date: saleDate,
        description: `Asset sold — ${asset.asset_name}`,
        amount: Number(saleAmount),
        referenceType: DatabaseService.ASSET_SALE_REF,
        referenceId: assetId,
        direction: 'in',
        // The settlement below may touch this same account, so the rebuild is
        // left to the end rather than run between the two entries.
        deferBalance: true
      }));
    }

    // No agreed price on file means there is no outstanding figure to settle —
    // inventing one (e.g. treating it as 0) would post a settlement payment
    // that moves money nobody agreed to. Skip the auto-settlement entirely.
    const hasPrice = asset.agreed_price !== null && asset.agreed_price !== undefined;

    /** The account the outstanding balance was settled from, if any. */
    let settledBank: number | null = null;

    // Rounded to whole paisa so float dust cannot strand a fraction of a rupee
    // in outstanding. Floored at zero by the `> 0` test rather than clamped: an
    // asset that is square, or overpaid since the payment block was relaxed,
    // gets no settlement row at all — never a negative one that would read as
    // money coming back in.
    const owed = hasPrice
      ? Math.round((Number(asset.agreed_price) - Number(asset.amount_paid)) * 100) / 100
      : 0;
    if (owed > 0) {
      const source = settlement?.payment_source === 'bank' ? 'bank' : 'cash';
      const bank = source === 'bank' ? (settlement?.bank_id || null) : null;
      if (source === 'bank' && !bank) {
        return { success: false, error: 'Choose which bank account settles the outstanding balance.' };
      }

      // The settlement is often the largest single movement on the account —
      // the whole remaining balance in one payment — so it is exactly the one
      // most likely to overdraw. Refused here, before the sale itself is
      // recorded, because the sale and its settlement are one batch.
      //
      // The NET delta per account, not the settlement alone: the proceeds above
      // land in the same batch, and when they land in the same account they
      // fund the settlement. Checking the withdrawal on its own would refuse a
      // sale that pays off the balance out of its own proceeds, which is the
      // ordinary case.
      if (bank) {
        const deltas = [{ bankId: bank, delta: -owed }];
        if (proceedsBank && Number(saleAmount) > 0) {
          deltas.push({ bankId: proceedsBank, delta: Number(saleAmount) });
        }
        const guard = await this.checkBankBalances(deltas);
        if (!guard.success) return guard;
      }

      ops.push({
        sql: `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, is_settlement, notes)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        params: [assetId, asset.farm_id, saleDate, owed, source, bank,
                 'Balance settled automatically on sale of the asset']
      });

      if (bank) {
        ops.push(...this.bankWithdrawalOps({
          bankId: bank,
          date: saleDate,
          description: `Asset payment — ${asset.asset_name} (balance settled on sale)`,
          amount: owed,
          referenceType: DatabaseService.ASSET_PAYMENT_REF,
          referenceId: { $lastId: -1 },
          // Rebuilt once at the end, with the proceeds' account, so an account
          // this batch touched twice is not cached mid-way.
          deferBalance: true
        }));
        settledBank = bank;
      }
    }

    // One rebuild per DISTINCT account the batch touched — `bankRebuildOps`
    // de-duplicates, so a sale received into and settled out of the same
    // account rebuilds it once, after both entries exist.
    ops.push(...this.bankRebuildOps([proceedsBank, settledBank]));

    return ops.length === 1 ? this.run(ops[0].sql, ops[0].params) : this.runBatch(ops);
  }

  /**
   * Foreign keys are declared but never enforced in this database, so nothing
   * cascades. The payments have to go explicitly or they are left orphaned,
   * still counting toward the account's outstanding installments — and any
   * bank withdrawals mirroring them have to go with them, or the account keeps
   * showing money leaving for an asset that no longer exists. One batch, so
   * all three go together or not at all.
   */
  async deleteAsset(assetId: number): Promise<any> {
    const bankIds = await this.bankIdsForAsset(assetId);
    return this.runBatch([
      ...this.bankReversalOps(
        DatabaseService.ASSET_PAYMENT_REF,
        'SELECT payment_id FROM asset_payments WHERE asset_id = ?', [assetId], bankIds, true
      ),
      // And the sale's own deposit, if the asset was sold into an account. Both
      // reversals defer their rebuild so an account that took money in AND paid
      // money out for this asset is recomputed once, at the end, after both
      // entries are gone.
      ...this.bankReversalOps(
        DatabaseService.ASSET_SALE_REF, '?', [assetId], bankIds, true
      ),
      { sql: 'DELETE FROM asset_payments WHERE asset_id = ?', params: [assetId] },
      { sql: 'DELETE FROM assets WHERE asset_id = ?', params: [assetId] },
      ...this.bankRebuildOps(bankIds)
    ]);
  }

  // ── OVERVIEW: ASSET INSTALLMENT PAYMENTS ────────────────────

  /** Newest first, matching how the payment history reads on the detail view. */
  async getAssetPayments(assetId: number, farmId: number): Promise<any> {
    return this.get(
      `SELECT p.*, b.bank_name
       FROM asset_payments p
       LEFT JOIN bank_accounts b ON b.bank_id = p.bank_id
       WHERE p.asset_id = ? AND p.farm_id = ?
       ORDER BY p.date DESC, p.payment_id DESC`,
      [assetId, farmId]
    );
  }

  /**
   * One installment. When it is paid by bank, the withdrawal for it goes in the
   * same batch — see the ASSET PAYMENTS AGAINST A BANK ACCOUNT block above.
   */
  async addAssetPayment(payment: {
    asset_id: number;
    farm_id: number;
    date: string;
    amount: number;
    payment_source?: string;
    bank_id?: number | null;
    notes?: string | null;
    /** Only used to label the bank ledger entry. */
    asset_name?: string | null;
  }): Promise<any> {
    const { asset_id, farm_id, date, amount, payment_source, bank_id, notes, asset_name } = payment;
    if (!asset_id || !farm_id || !date) {
      return { success: false, error: 'asset_id, farm_id and date are required' };
    }
    const source = payment_source === 'bank' ? 'bank' : 'cash';
    const bank = source === 'bank' ? (bank_id || null) : null;
    if (source === 'bank' && !bank) {
      return { success: false, error: 'Choose which bank account the payment came from.' };
    }

    if (bank) {
      const guard = await this.checkBankBalances([{ bankId: bank, delta: -(amount || 0) }]);
      if (!guard.success) return guard;
    }

    const insert: DbBatchOp = {
      sql: `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [asset_id, farm_id, date, amount || 0, source, bank, notes || null]
    };

    if (!bank) return this.run(insert.sql, insert.params);

    return this.runBatch([
      insert,
      ...this.bankWithdrawalOps({
        bankId: bank,
        date,
        description: `Asset payment — ${asset_name || 'asset'}`,
        amount: amount || 0,
        referenceType: DatabaseService.ASSET_PAYMENT_REF,
        referenceId: { $lastId: -1 }
      })
    ]);
  }

  /**
   * Deleting an installment puts its amount back into outstanding, so a
   * bank-sourced one has to put the money back into the bank too — the
   * withdrawal it wrote is removed and the account's balance rebuilt in the
   * same batch.
   *
   * The account is looked up before the batch on purpose: once the ledger row
   * is gone there is nothing left to say which balance to rebuild. Payments
   * recorded as bank BEFORE this wiring existed have no ledger row to remove —
   * the DELETE simply matches nothing and the rebuild is a no-op, which is
   * correct, since no withdrawal was ever posted for them.
   */
  async deleteAssetPayment(paymentId: number, farmId: number): Promise<any> {
    const existing = await this.get(
      'SELECT bank_id FROM asset_payments WHERE payment_id = ? AND farm_id = ?',
      [paymentId, farmId]
    );
    if (!existing.success) return existing;

    const bankId = Number((existing.data && existing.data[0] && existing.data[0].bank_id) || 0);
    const del: DbBatchOp = {
      sql: 'DELETE FROM asset_payments WHERE payment_id = ? AND farm_id = ?',
      params: [paymentId, farmId]
    };

    if (!bankId) return this.run(del.sql, del.params);

    return this.runBatch([
      ...this.bankReversalOps(DatabaseService.ASSET_PAYMENT_REF, '?', [paymentId], [bankId]),
      del
    ]);
  }

  // ── OVERVIEW: PERSONAL EXPENSE CATEGORIES ───────────────────
  // User-defined, one set per account. Each category is an account the client
  // clicks into, so the card grid needs the per-category totals up front.

  /**
   * Categories with their entry count and total spent.
   *
   * The join condition is `category_id = c.category_id OR (category_id IS NULL
   * AND category = c.category_name)`. The second half is the reason
   * personal_expenses.category is still written: if a row's link is ever
   * missing, it still counts toward its named category instead of vanishing
   * from a grid that only knows about ids. `date BETWEEN` is applied inside the
   * join so a category with no entries in range still shows, at zero.
   */
  async getPersonalExpenseCategories(farmId: number, fromDate?: string, toDate?: string): Promise<any> {
    // Params are positional and must be pushed in the order the `?`s appear in
    // the SQL below: the date bounds sit inside the JOIN, so they come BEFORE
    // the farm_id in the WHERE.
    const params: any[] = [];
    let dateClause = '';
    if (fromDate && toDate) {
      dateClause = ' AND pe.date BETWEEN ? AND ?';
      params.push(fromDate, toDate);
    }
    params.push(farmId);
    return this.get(
      `SELECT c.category_id, c.category_name, c.created_at,
              COUNT(pe.pexpense_id) AS entry_count,
              COALESCE(SUM(pe.amount), 0) AS total_spent
       FROM expense_categories c
       LEFT JOIN personal_expenses pe
         ON pe.farm_id = c.farm_id
        AND (pe.category_id = c.category_id
             OR (pe.category_id IS NULL AND TRIM(COALESCE(pe.category,'')) = c.category_name COLLATE NOCASE))
        ${dateClause}
       WHERE c.farm_id = ?
       GROUP BY c.category_id, c.category_name, c.created_at
       ORDER BY c.category_name COLLATE NOCASE ASC`,
      params
    );
  }

  async addPersonalExpenseCategory(farmId: number, categoryName: string): Promise<any> {
    const name = (categoryName || '').trim();
    if (!farmId || !name) {
      return { success: false, error: 'A category name is required.' };
    }
    const clash = await this.get(
      `SELECT category_id FROM expense_categories
       WHERE farm_id = ? AND category_name = ? COLLATE NOCASE`,
      [farmId, name]
    );
    if (clash.success && clash.data && clash.data.length > 0) {
      return { success: false, error: `A category called "${name}" already exists.` };
    }
    return this.run(
      'INSERT INTO expense_categories (farm_id, category_name) VALUES (?, ?)',
      [farmId, name]
    );
  }

  /**
   * Renaming has to move the denormalised `category` text on the entries too, or
   * the two would disagree and the fallback match above would start pulling
   * entries back under the old name.
   */
  async renamePersonalExpenseCategory(categoryId: number, farmId: number, categoryName: string): Promise<any> {
    const name = (categoryName || '').trim();
    if (!name) return { success: false, error: 'A category name is required.' };

    const clash = await this.get(
      `SELECT category_id FROM expense_categories
       WHERE farm_id = ? AND category_name = ? COLLATE NOCASE AND category_id <> ?`,
      [farmId, name, categoryId]
    );
    if (clash.success && clash.data && clash.data.length > 0) {
      return { success: false, error: `A category called "${name}" already exists.` };
    }

    const previous = await this.get(
      'SELECT category_name FROM expense_categories WHERE category_id = ? AND farm_id = ?',
      [categoryId, farmId]
    );
    if (!previous.success) return previous;
    if (!previous.data || previous.data.length === 0) {
      return { success: false, error: 'Category not found.' };
    }
    const oldName = previous.data[0].category_name;

    return this.runBatch([
      {
        sql: 'UPDATE expense_categories SET category_name = ? WHERE category_id = ? AND farm_id = ?',
        params: [name, categoryId, farmId]
      },
      {
        sql: `UPDATE personal_expenses SET category = ?
              WHERE farm_id = ?
                AND (category_id = ? OR (category_id IS NULL AND TRIM(COALESCE(category,'')) = ? COLLATE NOCASE))`,
        params: [name, farmId, categoryId, oldName]
      }
    ]);
  }

  /**
   * Refused while the category still has entries. Foreign keys are not enforced
   * in this database, so this check is the only thing standing between a delete
   * and a set of orphaned expense rows that no card would ever show again. The
   * count uses the same id-or-name predicate as the grid, so an entry whose link
   * is missing still blocks the delete rather than being quietly stranded.
   */
  async deletePersonalExpenseCategory(categoryId: number, farmId: number): Promise<any> {
    const existing = await this.get(
      'SELECT category_name FROM expense_categories WHERE category_id = ? AND farm_id = ?',
      [categoryId, farmId]
    );
    if (!existing.success) return existing;
    if (!existing.data || existing.data.length === 0) {
      return { success: false, error: 'Category not found.' };
    }
    const name = existing.data[0].category_name;

    const used = await this.get(
      `SELECT COUNT(*) AS entry_count FROM personal_expenses
       WHERE farm_id = ?
         AND (category_id = ? OR (category_id IS NULL AND TRIM(COALESCE(category,'')) = ? COLLATE NOCASE))`,
      [farmId, categoryId, name]
    );
    if (!used.success) return used;

    const count = Number(used.data?.[0]?.entry_count || 0);
    if (count > 0) {
      return {
        success: false,
        error: `"${name}" still has ${count} ${count === 1 ? 'entry' : 'entries'}. ` +
               'Move or delete them first — deleting the category would leave those entries unreachable.'
      };
    }

    return this.run(
      'DELETE FROM expense_categories WHERE category_id = ? AND farm_id = ?',
      [categoryId, farmId]
    );
  }

  // ── OVERVIEW: PERSONAL EXPENSE METHODS ──────────────────────
  // Account-level (farm_id scoped). Kept separate from the shared `expenses`
  // table even though its total rolls into the dashboard's expense figure.

  async getPersonalExpenses(farmId: number, fromDate?: string, toDate?: string): Promise<any> {
    let sql =
      `SELECT pe.*
       FROM personal_expenses pe
       WHERE pe.farm_id = ?`;
    const params: any[] = [farmId];
    if (fromDate && toDate) {
      sql += ' AND pe.date BETWEEN ? AND ?';
      params.push(fromDate, toDate);
    }
    sql += ' ORDER BY pe.date DESC, pe.pexpense_id DESC';
    return this.get(sql, params);
  }

  /**
   * One category's entries, newest first. Same id-or-name predicate as the grid.
   * `bank_name` rides along so the table can show what an entry was paid from
   * without a second query; it survives the account being renamed since it is
   * read live rather than stored on the row.
   */
  async getPersonalExpensesByCategory(
    farmId: number, categoryId: number, categoryName: string,
    fromDate?: string, toDate?: string
  ): Promise<any> {
    let sql =
      `SELECT pe.*, b.bank_name
       FROM personal_expenses pe
       LEFT JOIN bank_accounts b ON b.bank_id = pe.bank_id
       WHERE pe.farm_id = ?
         AND (pe.category_id = ?
              OR (pe.category_id IS NULL AND TRIM(COALESCE(pe.category,'')) = ? COLLATE NOCASE))`;
    const params: any[] = [farmId, categoryId, categoryName];
    if (fromDate && toDate) {
      sql += ' AND pe.date BETWEEN ? AND ?';
      params.push(fromDate, toDate);
    }
    sql += ' ORDER BY pe.date DESC, pe.pexpense_id DESC';
    return this.get(sql, params);
  }

  /** How a personal expense's bank withdrawal is labelled on the bank statement. */
  private personalExpenseLabel(category?: string | null, description?: string | null): string {
    const head = `Personal expense — ${(category || '').trim() || 'uncategorised'}`;
    const tail = (description || '').trim();
    return tail ? `${head}: ${tail}` : head;
  }

  /**
   * category_id is the link; `category` carries the name alongside it. Both are
   * written on every path so the two never disagree — see the note on
   * getPersonalExpenseCategories() for what the text column is actually protecting.
   *
   * Paid by bank, the withdrawal goes in the same batch, exactly as an asset
   * installment's does.
   */
  async addPersonalExpense(pe: {
    farm_id: number;
    date: string;
    category_id: number;
    category?: string | null;
    description?: string | null;
    amount?: number;
    payment_source?: string;
    bank_id?: number | null;
    notes?: string | null;
  }): Promise<any> {
    const { farm_id, date, category_id, category, description, amount,
            payment_source, bank_id, notes } = pe;
    if (!farm_id || !date) {
      return { success: false, error: 'farm_id and date are required' };
    }
    if (!category_id) {
      return { success: false, error: 'A category is required.' };
    }
    const source = payment_source === 'bank' ? 'bank' : 'cash';
    const bank = source === 'bank' ? (bank_id || null) : null;
    if (source === 'bank' && !bank) {
      return { success: false, error: 'Choose which bank account the money came out of.' };
    }

    if (bank) {
      const guard = await this.checkBankBalances([{ bankId: bank, delta: -(amount || 0) }]);
      if (!guard.success) return guard;
    }

    const insert: DbBatchOp = {
      sql: `INSERT INTO personal_expenses
              (farm_id, date, category_id, category, description, amount, payment_source, bank_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [farm_id, date, category_id, category || null, description || null,
               amount || 0, source, bank, notes || null]
    };

    if (!bank) return this.run(insert.sql, insert.params);

    return this.runBatch([
      insert,
      ...this.bankWithdrawalOps({
        bankId: bank,
        date,
        description: this.personalExpenseLabel(category, description),
        amount: amount || 0,
        referenceType: DatabaseService.PERSONAL_EXPENSE_REF,
        referenceId: { $lastId: -1 }
      })
    ]);
  }

  /**
   * EDITING A PERSONAL EXPENSE — the one path in this file where a bank-backed
   * row can change after the money moved. Asset payments are only ever created
   * and destroyed; these are edited, and every field the withdrawal is built
   * from (amount, date, source, account) is editable.
   *
   * Rather than a branch per transition, the withdrawal is REVERSED AND
   * RE-POSTED: whatever entry the row had is deleted, the row is updated, and a
   * fresh entry is written if the row is still bank-sourced. One shape covers
   * all five transitions, so there is no case left to forget:
   *
   *   amount changed, same account  delete + re-post at the new amount; the net
   *                                 movement is the delta
   *   date changed                  delete + re-post on the new date, so the
   *                                 withdrawal stays in the same period as the
   *                                 expense it mirrors
   *   cash -> bank                  nothing to delete, one entry written
   *   bank -> cash                  entry deleted, none written
   *   bank A -> bank B              deleted from A, written to B, BOTH rebuilt
   *
   * Ordering is load-bearing. The delete and the insert both come before any
   * balance rebuild (`deferBalance`), and the rebuild covers the UNION of the
   * old and new accounts — rebuilding A in the middle would cache a figure the
   * next statement invalidates, and rebuilding only B would leave A holding a
   * balance that still counts a withdrawal it no longer has.
   *
   * The old entry's `transaction_number` is carried over when the account has
   * not changed, so a line the client noted against a receipt keeps its
   * reference across an edit. Moving to another account cannot reuse it — the
   * number belongs to the old account's WD- sequence and could collide there —
   * so that case takes a fresh one.
   *
   * Values not named in `data` keep what the row already has, so a caller that
   * passes only `{ amount }` still gets a withdrawal built from the right date
   * and account.
   *
   * Legacy rows recorded as bank before any of this existed have no entry to
   * delete: the DELETE matches nothing, and the rebuild is a no-op. Correct —
   * no withdrawal was ever posted for them. Note that editing such a row DOES
   * post one from then on, which is the right way round: the row is now
   * accurate rather than retroactively inventing history.
   */
  async updatePersonalExpense(id: number, data: any): Promise<any> {
    const existing = await this.get(
      `SELECT pe.date, pe.amount, pe.category, pe.description, pe.payment_source, pe.bank_id,
              (SELECT bl.transaction_number FROM bank_ledger bl
                WHERE bl.reference_type = ? AND bl.reference_id = pe.pexpense_id
                LIMIT 1) AS ledger_number
       FROM personal_expenses pe WHERE pe.pexpense_id = ?`,
      [DatabaseService.PERSONAL_EXPENSE_REF, id]
    );
    if (!existing.success) return existing;
    if (!existing.data || existing.data.length === 0) {
      return { success: false, error: 'Personal expense not found' };
    }
    const old = existing.data[0];

    const fields: string[] = [];
    const values: any[] = [];

    if (data.date !== undefined) { fields.push('date = ?'); values.push(data.date); }
    // Moving an entry between categories must move both columns together.
    if (data.category_id !== undefined) { fields.push('category_id = ?'); values.push(data.category_id); }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.amount !== undefined) { fields.push('amount = ?'); values.push(data.amount); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

    // The effective row after the edit, for building the new withdrawal from.
    // A caller that names only `bank_id` is moving the account, not silently
    // turning the entry into cash — hence the middle branch. Naming neither
    // leaves the source exactly as it was.
    const sourceGiven = data.payment_source !== undefined || data.bank_id !== undefined;
    const newSource =
      data.payment_source !== undefined ? (data.payment_source === 'bank' ? 'bank' : 'cash')
      : data.bank_id !== undefined ? (data.bank_id ? 'bank' : 'cash')
      : (old.payment_source === 'bank' ? 'bank' : 'cash');
    const newBank = newSource === 'bank'
      ? Number((data.bank_id !== undefined ? data.bank_id : old.bank_id) || 0) || null
      : null;

    if (newSource === 'bank' && !newBank) {
      return { success: false, error: 'Choose which bank account the money came out of.' };
    }

    if (sourceGiven) {
      fields.push('payment_source = ?'); values.push(newSource);
      fields.push('bank_id = ?'); values.push(newBank);
    }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };

    const newDate = data.date !== undefined ? data.date : old.date;
    const newAmount = Number(data.amount !== undefined ? data.amount : old.amount) || 0;
    const newCategory = data.category !== undefined ? data.category : old.category;
    const newDescription = data.description !== undefined ? data.description : old.description;

    const oldBank = Number(old.bank_id || 0) || null;
    const update: DbBatchOp = {
      sql: `UPDATE personal_expenses SET ${fields.join(', ')} WHERE pexpense_id = ?`,
      params: [...values, id]
    };

    // Nothing to do with a bank on either side of the edit.
    if (!oldBank && !newBank) return this.run(update.sql, update.params);

    // Both halves of the edit, over the union of the two accounts — the same
    // union the rebuild covers, and for the same reason. Putting back a
    // withdrawal credits the old account; the new withdrawal debits the new
    // one. An edit that raises the amount on an account that cannot cover the
    // difference is refused and nothing is written, including the row's own
    // non-bank fields.
    const guard = await this.checkBankBalances([
      { bankId: oldBank, delta: oldBank ? -(await this.bankEntryEffect(DatabaseService.PERSONAL_EXPENSE_REF, id)) : 0 },
      { bankId: newBank, delta: -newAmount }
    ]);
    if (!guard.success) return guard;

    const ops: DbBatchOp[] = [];

    if (oldBank) {
      ops.push(...this.bankReversalOps(
        DatabaseService.PERSONAL_EXPENSE_REF, '?', [id], [oldBank], true
      ));
    }

    ops.push(update);

    if (newBank) {
      ops.push(...this.bankWithdrawalOps({
        bankId: newBank,
        date: newDate,
        description: this.personalExpenseLabel(newCategory, newDescription),
        amount: newAmount,
        referenceType: DatabaseService.PERSONAL_EXPENSE_REF,
        referenceId: id,
        // Same account: keep the number it had. Different account: it belongs to
        // the old account's sequence, so take a fresh one.
        transactionNumber: (oldBank && oldBank === newBank) ? (old.ledger_number || null) : null,
        deferBalance: true
      }));
    }

    // Every account this edit touched, rebuilt once, last, from the final ledger.
    const touched = Array.from(new Set([oldBank, newBank].filter((b): b is number => !!b)));
    ops.push(...touched.map(b => this.rebuildBankBalanceOp(b)));

    return this.runBatch(ops);
  }

  /** Deleting a bank-sourced expense puts the money back into the account. */
  async deletePersonalExpense(id: number): Promise<any> {
    const existing = await this.get(
      'SELECT bank_id FROM personal_expenses WHERE pexpense_id = ?', [id]
    );
    if (!existing.success) return existing;

    const bankId = Number((existing.data && existing.data[0] && existing.data[0].bank_id) || 0);
    const del: DbBatchOp = {
      sql: 'DELETE FROM personal_expenses WHERE pexpense_id = ?',
      params: [id]
    };

    if (!bankId) return this.run(del.sql, del.params);

    return this.runBatch([
      ...this.bankReversalOps(DatabaseService.PERSONAL_EXPENSE_REF, '?', [id], [bankId]),
      del
    ]);
  }
}
