import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';

import { toLocalDateString } from '../shared/utils/date.util';
import { distributionBillsOnly } from '../shared/utils/bill-source.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
@Component({
  selector: 'app-sales-returns',
  standalone: true,
  imports: [CommonModule, FormsModule, DateOnlyPipe, DeleteCodeDialogComponent],
  templateUrl: './sales-returns.component.html',
  styleUrl: './sales-returns.component.scss'
})
export class SalesReturnsComponent implements OnInit {
  currentFarm: any = null;
  bills: any[] = [];
  filteredBills: any[] = [];
  billSearchTerm: string = '';
  returns: any[] = [];
  selectedBill: any = null;
  returnRows: any[] = [];
  returnDate = toLocalDateString();
  reason = '';
  refundMethod: 'cash' | 'bank' = 'cash';
  isLoading = true;
  isSaving = false;
  errorMessage = '';
  successMessage = '';
  showCorrectionCodeDialog = false;
  requestSaveReturn() { if (this.selectedBill && !this.isSaving && this.totalReturnAmount > 0) this.showCorrectionCodeDialog = true; }
  async onCorrectionVerified() { this.showCorrectionCodeDialog = false; await this.saveReturn(); }

  editingReturnId: number | null = null;
  editingReturnNumber: string = '';

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadData();
  }

  // ── Computed getters ─────────────────────────────────────────

  get totalReturnAmount(): number {
    return this.returnRows.reduce((sum, row) => sum + this.getRowReturnAmount(row), 0);
  }

  get totalReturnsAmount(): number {
    return this.returns.reduce((sum, r) => sum + (Number(r.return_amount) || 0), 0);
  }

  get newBillTotal(): number {
    return Math.max((Number(this.selectedBill?.total_amount) || 0) - this.totalReturnAmount, 0);
  }

  get refundDue(): number {
    const paid = Number(this.selectedBill?.amount_paid) || 0;
    return Math.max(paid - this.newBillTotal, 0);
  }

  getRowReturnAmount(row: any): number {
    const qty = Number(row.return_quantity) || 0;
    return qty * (Number(row.unit_price) || 0);
  }

  // ── Data Loading ─────────────────────────────────────────────

  async loadData() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const [billsResult, returnsResult] = await Promise.all([
        this.db.get(
          `SELECT b.*,
                  COALESCE(SUM(sr.return_amount), 0) AS returned_amount
           FROM bills b
           LEFT JOIN sales_returns sr ON sr.bill_id = b.bill_id
           WHERE b.farm_id = ?
             AND COALESCE(b.status, 'completed') != 'returned'
             -- A layer sale's receivable is a bill with no bill_items and no
             -- stock behind it, so there is nothing here to return.
             AND ${distributionBillsOnly('b')}
           GROUP BY b.bill_id
           ORDER BY b.bill_date DESC, b.bill_id DESC`,
          [this.currentFarm.farm_id]
        ),
        this.db.get(
          `SELECT sr.*, b.bill_number, b.customer_name
           FROM sales_returns sr
           JOIN bills b ON b.bill_id = sr.bill_id
           WHERE sr.farm_id = ?
           ORDER BY sr.return_date DESC, sr.return_id DESC`,
          [this.currentFarm.farm_id]
        )
      ]);
      this.bills = billsResult.success ? billsResult.data : [];
      this.filteredBills = [...this.bills];
      if (this.billSearchTerm) this.filterBills();
      this.returns = returnsResult.success ? returnsResult.data : [];
    } catch (error: any) {
      this.errorMessage = 'Failed to load returns: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── Bill Selection ────────────────────────────────────────────

  async selectBill(bill: any) {
    this.selectedBill = bill;
    this.reason = '';
    this.returnDate = toLocalDateString();
    this.errorMessage = '';
    this.successMessage = '';

    const itemsResult = await this.db.get(
      `SELECT * FROM bill_items WHERE bill_id = ? AND quantity > 0 ORDER BY item_id ASC`,
      [bill.bill_id]
    );
    const items = itemsResult.success ? itemsResult.data : [];
    this.returnRows = items.map((item: any) => ({
      bill_item_id: item.item_id,
      product_id: item.product_id,
      product_name: item.product_name,
      sold_quantity: Number(item.quantity) || 0,
      unit_price: Number(item.unit_price) || 0,
      return_quantity: null
    }));
    this.cdr.detectChanges();
  }

  filterBills() {
    const term = this.billSearchTerm.trim().toLowerCase();
    if (!term) {
      this.filteredBills = [...this.bills];
      this.cdr.detectChanges();
      return;
    }
    this.filteredBills = this.bills.filter(b =>
      (b.bill_number || '').toLowerCase().includes(term) ||
      (b.customer_name || '').toLowerCase().includes(term)
    );
    this.cdr.detectChanges();
  }

  clearBillSearch() {
    this.billSearchTerm = '';
    this.filteredBills = [...this.bills];
    this.cdr.detectChanges();
  }

  clearSelection() {
    this.selectedBill = null;
    this.returnRows = [];
    this.reason = '';
    this.editingReturnId = null;
    this.editingReturnNumber = '';
    this.errorMessage = '';
    this.successMessage = '';
    this.filterBills();
    this.cdr.detectChanges();
  }

  // A return can only be edited when it's the sole return on its bill —
  // once a bill has more than one return, figuring out which portion of
  // the bill's current paid/total belongs to which return is ambiguous,
  // and guessing wrong would corrupt the ledger silently.
  canEditReturn(ret: any): boolean {
    return this.returns.filter(r => r.bill_id === ret.bill_id).length === 1;
  }

  // ── Edit Return ──────────────────────────────────────────────
  // Populates the return form with the original return's data so the user
  // can correct a mistaken quantity. Nothing in the database changes until
  // Save is actually pressed — backing out via "Back to Bills" leaves the
  // original return exactly as it was.

  async editReturn(ret: any) {
    this.errorMessage = '';
    this.successMessage = '';

    if (!this.canEditReturn(ret)) {
      this.errorMessage = `Return ${ret.return_number} can't be edited because this bill has more than one return on it.`;
      this.cdr.detectChanges();
      return;
    }

    const billResult = await this.db.get(`SELECT * FROM bills WHERE bill_id = ?`, [ret.bill_id]);
    const bill = billResult.success && billResult.data && billResult.data.length > 0 ? billResult.data[0] : null;
    if (!bill) {
      this.errorMessage = 'Could not load the original bill for this return.';
      this.cdr.detectChanges();
      return;
    }

    const returnItemsResult = await this.db.get(
      `SELECT * FROM sales_return_items WHERE return_id = ?`,
      [ret.return_id]
    );
    const returnedItems = returnItemsResult.success ? returnItemsResult.data : [];
    const returnedByBillItemId = new Map<number, any>(returnedItems.map((i: any) => [i.bill_item_id, i]));

    const currentItemsResult = await this.db.get(
      `SELECT * FROM bill_items WHERE bill_id = ?`,
      [ret.bill_id]
    );
    const currentItems = currentItemsResult.success ? currentItemsResult.data : [];

    const rows: any[] = [];

    // Lines still present on the bill: add back the previously-returned
    // quantity so the max shown is the original quantity sold, not just
    // what's currently left after the return.
    for (const cur of currentItems) {
      const prevReturned = returnedByBillItemId.get(cur.item_id);
      const prevQty = prevReturned ? Number(prevReturned.quantity) : 0;
      rows.push({
        bill_item_id: cur.item_id,
        product_id: cur.product_id,
        product_name: cur.product_name,
        sold_quantity: (Number(cur.quantity) || 0) + prevQty,
        unit_price: Number(cur.unit_price) || 0,
        return_quantity: prevQty > 0 ? prevQty : null
      });
      if (prevReturned) returnedByBillItemId.delete(cur.item_id);
    }

    // Lines that were fully returned last time (no longer on the bill at all)
    for (const [, item] of returnedByBillItemId) {
      rows.push({
        bill_item_id: item.bill_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        sold_quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        return_quantity: Number(item.quantity)
      });
    }

    this.returnRows = rows;
    // Display totals as they were BEFORE this return, since editing means
    // starting from the original sale again. The real database values get
    // recomputed correctly once Save reverses and reapplies.
    this.selectedBill = {
      ...bill,
      total_amount: Number(bill.total_amount) + Number(ret.return_amount),
      amount_paid: Number(bill.amount_paid) + Number(ret.refund_amount)
    };
    this.returnDate = ret.return_date;
    this.reason = ret.reason || '';
    this.refundMethod = ret.refund_method === 'bank' ? 'bank' : 'cash';
    this.editingReturnId = ret.return_id;
    this.editingReturnNumber = ret.return_number;
    this.cdr.detectChanges();
  }

  // Undoes a previously-saved return: restores bill_items quantities,
  // deducts back out the stock that was restored to batches, removes the
  // bank refund entry (if any), and deletes the return's own rows. Returns
  // the bill row as it now stands, post-restoration.
  private async reverseReturnEffects(ret: any): Promise<any> {
    const itemsResult = await this.db.get(
      `SELECT * FROM sales_return_items WHERE return_id = ?`,
      [ret.return_id]
    );
    const items = itemsResult.success ? itemsResult.data : [];

    for (const item of items) {
      const existing = await this.db.get(`SELECT * FROM bill_items WHERE item_id = ?`, [item.bill_item_id]);
      if (existing.success && existing.data && existing.data.length > 0) {
        const cur = existing.data[0];
        const restoredQty = (Number(cur.quantity) || 0) + Number(item.quantity);
        await this.mustRun(
          `UPDATE bill_items SET quantity = ?, total_price = ? WHERE item_id = ?`,
          [restoredQty, restoredQty * Number(item.unit_price), item.bill_item_id]
        );
      } else {
        await this.mustRun(
          `INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?)`,
          [item.bill_id, item.product_id, item.product_name, item.quantity, item.unit_price, Number(item.quantity) * Number(item.unit_price)]
        );
      }

      if (item.product_id) {
        const restoreTx = await this.db.get(
          `SELECT * FROM batch_transactions WHERE reference_id = ? AND product_id = ? AND type = 'return'`,
          [ret.return_id, item.product_id]
        );
        for (const tx of restoreTx.success ? restoreTx.data : []) {
          const batchResult = await this.db.get('SELECT * FROM product_batches WHERE batch_id = ?', [tx.batch_id]);
          if (batchResult.success && batchResult.data && batchResult.data.length > 0) {
            const batch = batchResult.data[0];
            const newQty = Math.max(0, (Number(batch.quantity) || 0) - Number(tx.quantity));
            this.assertOk(await this.db.updateBatch(batch.batch_id, { quantity: newQty }), 'Reversing the restored batch quantity failed');
            this.assertOk(await this.db.addBatchTransaction(
              batch.batch_id, item.product_id, 'sale', Number(tx.quantity),
              this.returnDate, ret.bill_id, `Reversed for edit of ${ret.return_number}`
            ), 'Recording the reversal transaction failed');
          }
        }
      }
    }

    if (ret.refund_method === 'bank' && Number(ret.refund_amount) > 0) {
      await this.mustRun(
        `DELETE FROM bank_ledger WHERE reference_type = 'return' AND reference_id = ?`,
        [ret.bill_id]
      );
    }

    await this.mustRun(`DELETE FROM sales_return_items WHERE return_id = ?`, [ret.return_id]);
    await this.mustRun(`DELETE FROM sales_returns WHERE return_id = ?`, [ret.return_id]);
    this.assertOk(await this.db.updateBatchStatuses(), 'Updating the batch statuses failed');

    const freshBill = this.assertOk(
      await this.db.get(`SELECT * FROM bills WHERE bill_id = ?`, [ret.bill_id]),
      'Could not re-read the bill after reversing the previous return'
    );
    return freshBill.data.length > 0 ? freshBill.data[0] : null;
  }

  // ── Transaction helpers ──────────────────────────────────────
  // db.run()/db.get() and the DatabaseService helpers report failures as
  // { success: false } instead of throwing, so an unchecked write inside the
  // transaction below would otherwise fail silently and still get committed
  // along with everything else. Everything on the return-save path goes
  // through these.

  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'unknown error')}`);
    }
    return result;
  }

  private async mustRun(sql: string, params: any[] = []): Promise<any> {
    return this.assertOk(await this.db.run(sql, params), 'Database write failed');
  }

  // ── Save Return ───────────────────────────────────────────────

  async saveReturn() {
    if (!this.selectedBill || this.isSaving) return;

    // Validate rows — a return can never exceed what was actually sold on
    // that line (checked here in code, not just via the input's HTML max,
    // which a user could bypass by typing a value directly).
    const rows = this.returnRows.filter(row => (Number(row.return_quantity) || 0) > 0);
    if (rows.length === 0) {
      this.errorMessage = 'Enter at least one return quantity.';
      return;
    }
    for (const row of rows) {
      const qty = Number(row.return_quantity) || 0;
      if (qty <= 0 || qty > row.sold_quantity) {
        this.errorMessage = `Return qty for "${row.product_name}" must be between 1 and ${row.sold_quantity}.`;
        return;
      }
    }

    this.isSaving = true;
    this.errorMessage = '';
    this.successMessage = '';

    let returnNumber = '';
    try {
      // One transaction for the whole return: reversing a prior edit, the
      // return header and items, the bill_items reduction, the stock
      // restore, the customer ledger rebuild, the bank refund and the
      // internal-transfer rebuild either all land together or none of them
      // do. A failure part way through used to leave a return whose stock
      // had been restored but whose bill totals were never updated, or the
      // reverse.
      //
      // Reads inside here see the transaction's own uncommitted writes, so
      // the edit path (reverse, then re-read bill_items to validate against
      // the restored quantities) still behaves the way it always has.
      await this.db.transaction(async () => {
        // If editing an existing return, undo its effects first so the bill
        // is back to its pre-return state, then fall through to the normal
        // save logic below as if this were a brand-new return.
        if (this.editingReturnId) {
          const originalReturn = this.returns.find(r => r.return_id === this.editingReturnId);
          if (!originalReturn) throw new Error('Original return record not found.');
          const restoredBill = await this.reverseReturnEffects(originalReturn);
          if (!restoredBill) throw new Error('Failed to restore the bill before applying the edit.');
          this.selectedBill = restoredBill;

          // sold_quantity ceilings were computed against the pre-restore state
          // for display purposes — refresh them against the now-restored
          // bill_items so validation and stock math both use current numbers.
          const refreshedItems = this.assertOk(
            await this.db.get(`SELECT * FROM bill_items WHERE bill_id = ?`, [this.selectedBill.bill_id]),
            'Could not re-read the bill items after restoring the previous return'
          );
          const byId = new Map<number, any>(refreshedItems.data.map((i: any) => [i.item_id, i]));
          for (const row of this.returnRows) {
            const match = byId.get(row.bill_item_id);
            if (match) {
              row.bill_item_id = match.item_id;
              row.sold_quantity = Number(match.quantity);
            }
          }
          for (const row of rows) {
            if (Number(row.return_quantity) > row.sold_quantity) {
              throw new Error(`Return qty for "${row.product_name}" exceeds what's available (${row.sold_quantity}).`);
            }
          }
        }

        returnNumber        = await this.getNextReturnNumber();
        const returnAmount  = this.totalReturnAmount;
        const oldPaid       = Number(this.selectedBill.amount_paid) || 0;
        const nextTotal     = this.newBillTotal;
        const nextPaid      = Math.min(oldPaid, nextTotal);
        const refundAmount  = oldPaid - nextPaid;

        // 1. Insert sales_returns header
        const insertReturn = await this.mustRun(
          `INSERT INTO sales_returns
            (farm_id, bill_id, return_number, return_date, return_amount, refund_amount, refund_method, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.currentFarm.farm_id,
            this.selectedBill.bill_id,
            returnNumber,
            this.returnDate,
            returnAmount,
            refundAmount,
            this.refundMethod,
            this.reason || null
          ]
        );

        const returnId = insertReturn.lastId;
        if (!returnId) throw new Error('Return ID not obtained — check PRIMARY_KEY_MAP.');

        // 2. Insert return items + restore stock + reduce bill items
        for (const row of rows) {
          const qty      = Number(row.return_quantity) || 0;
          const rowTotal = qty * (Number(row.unit_price) || 0);

          await this.mustRun(
            `INSERT INTO sales_return_items
              (return_id, bill_id, bill_item_id, product_id, product_name, quantity, unit_price, total_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [returnId, this.selectedBill.bill_id, row.bill_item_id, row.product_id ?? null, row.product_name, qty, row.unit_price, rowTotal]
          );

          // Restore stock only if product_id is known (distribution items)
          if (row.product_id) {
            await this.restoreReturnedStock(row, qty, returnId, returnNumber);
          }

          await this.reduceBillItem(row, qty);
        }

        // 3. Update bill totals and status
        const newStatus = nextTotal === 0 ? 'returned' : 'partial_return';
        await this.mustRun(
          `UPDATE bills SET subtotal = ?, total_amount = ?, amount_paid = ?, status = ? WHERE bill_id = ?`,
          [nextTotal, nextTotal, nextPaid, newStatus, this.selectedBill.bill_id]
        );

        // 4. Rebuild customer ledger (if customer-linked bill)
        if (this.selectedBill.customer_id) {
          await this.rebuildCustomerLedger(this.selectedBill, nextTotal, nextPaid);
        }

        // 5. Bank refund (if applicable)
        if (refundAmount > 0 && this.refundMethod === 'bank' && this.selectedBill.customer_id) {
          await this.refundCustomerBank(this.selectedBill.customer_id, refundAmount, `Refund - ${returnNumber}`);
        }

        // 6. Rebuild internal-transfer expenses (if internal sale)
        if (this.selectedBill.payment_type === 'internal') {
          await this.rebuildInternalTransferExpenses(this.selectedBill.bill_id);
        }
      });

      // Committed.
      const successMessage = this.editingReturnId
        ? `Return updated (was ${this.editingReturnNumber}, now ${returnNumber}).`
        : `Return ${returnNumber} saved successfully.`;
      this.clearSelection();
      await this.loadData();
      this.successMessage = successMessage;
    } catch (error: any) {
      // The transaction rolled back — nothing at all was written.
      this.errorMessage = 'Failed to save return: ' + (error?.message || error);
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async getNextReturnNumber(): Promise<string> {
    const result = await this.db.get(
      `SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 5) AS INTEGER)), 0) + 1 AS next_number
       FROM sales_returns
       WHERE farm_id = ? AND return_number LIKE 'RET-%'`,
      [this.currentFarm.farm_id]
    );
    const num = result.success && result.data && result.data[0]
      ? result.data[0].next_number
      : 1;
    return 'RET-' + String(num).padStart(3, '0');
  }

  private async restoreReturnedStock(row: any, qty: number, returnId: number, returnNumber: string) {
    // Find the original sale batch transactions for this product on this bill
    const saleTx = await this.db.get(
      `SELECT * FROM batch_transactions
       WHERE reference_id = ? AND product_id = ? AND type = 'sale'
       ORDER BY transaction_date ASC, transaction_id ASC`,
      [this.selectedBill.bill_id, row.product_id]
    );

    let remaining = qty;
    const transactions = saleTx.success ? saleTx.data : [];

    // Restore from the original batches used in the sale (FIFO order)
    for (const tx of transactions) {
      if (remaining <= 0) break;
      const restoreQty = Math.min(remaining, Number(tx.quantity) || 0);
      if (restoreQty <= 0) continue;

      const batchResult = await this.db.get(
        'SELECT * FROM product_batches WHERE batch_id = ?',
        [tx.batch_id]
      );
      if (batchResult.success && batchResult.data && batchResult.data.length > 0) {
        const batch = batchResult.data[0];
        const newQty = (Number(batch.quantity) || 0) + restoreQty;
        this.assertOk(await this.db.updateBatch(batch.batch_id, { quantity: newQty, status: 'active' }), 'Restoring stock to a batch failed');
        this.assertOk(await this.db.addBatchTransaction(
          batch.batch_id, row.product_id, 'return', restoreQty,
          this.returnDate, returnId,
          `${returnNumber} - Bill ${this.selectedBill.bill_number}`
        ), 'Recording the stock-restore transaction failed');
        remaining -= restoreQty;
      }
    }

    // Fallback: restore remaining qty to any active batch of this product
    if (remaining > 0) {
      const batches = await this.db.getBatchesByProduct(row.product_id, this.currentFarm.farm_id);
      if (batches.success && batches.data && batches.data.length > 0) {
        const target = batches.data.find((b: any) => b.calculated_status === 'active' || b.calculated_status === 'expiring')
          || batches.data[0];
        const newQty = (Number(target.quantity) || 0) + remaining;
        this.assertOk(await this.db.updateBatch(target.batch_id, { quantity: newQty, status: 'active' }), 'Restoring stock to a fallback batch failed');
        this.assertOk(await this.db.addBatchTransaction(
          target.batch_id, row.product_id, 'return', remaining,
          this.returnDate, returnId,
          `${returnNumber} - Bill ${this.selectedBill.bill_number} (fallback batch)`
        ), 'Recording the fallback stock-restore transaction failed');
      }
    }

    this.assertOk(await this.db.updateBatchStatuses(), 'Updating the batch statuses failed');
  }

  private async reduceBillItem(row: any, qty: number) {
    const remainingQty = Math.max((Number(row.sold_quantity) || 0) - qty, 0);
    if (remainingQty === 0) {
      await this.mustRun('DELETE FROM bill_items WHERE item_id = ?', [row.bill_item_id]);
    } else {
      await this.mustRun(
        'UPDATE bill_items SET quantity = ?, total_price = ? WHERE item_id = ?',
        [remainingQty, remainingQty * (Number(row.unit_price) || 0), row.bill_item_id]
      );
    }
  }

  private async rebuildCustomerLedger(bill: any, total: number, paid: number) {
    // Remove old ledger entries for this bill
    await this.mustRun(
      `DELETE FROM customer_ledger WHERE reference_id = ? AND reference_type IN ('bill', 'payment')`,
      [bill.bill_id]
    );

    if (total > 0) {
      this.assertOk(await this.db.addCustomerLedgerEntry({
        customer_id: bill.customer_id,
        transaction_date: this.returnDate,
        description: `Bill #${bill.bill_number} (after return)`,
        debit: total,
        credit: 0,
        reference_type: 'bill',
        reference_id: bill.bill_id
      }), 'Rebuilding the customer ledger failed');
    }

    if (paid > 0) {
      this.assertOk(await this.db.addCustomerLedgerEntry({
        customer_id: bill.customer_id,
        transaction_date: this.returnDate,
        description: `Payment - Bill #${bill.bill_number}`,
        debit: 0,
        credit: paid,
        reference_type: 'payment',
        reference_id: bill.bill_id
      }), 'Rebuilding the customer ledger failed');
    }

    this.assertOk(await this.db.updateCustomerOutstandingBalance(bill.customer_id), 'Updating the customer balance failed');
  }

  // A missing bank account is an expected business state (not every customer
  // has one on file), not a write failure — it does not abort the surrounding
  // transaction. The write that follows once an account IS found still goes
  // through assertOk, same as everything else on this path.
  private async refundCustomerBank(customerId: number, amount: number, description: string) {
    // getCustomerBankAccount returns { success, data: [] }
    const bankResult = await this.db.getCustomerBankAccount(customerId);
    if (!bankResult.success || !bankResult.data || bankResult.data.length === 0) {
      this.errorMessage += ' (Customer has no linked bank account — bank refund not posted.)';
      return;
    }
    const bank = bankResult.data[0];
    this.assertOk(await this.db.addBankLedgerEntry({
      bank_id: bank.bank_id,
      transaction_date: this.returnDate,
      description,
      debit: 0,
      credit: amount,    // Credit bank = money leaving our bank (refund to customer)
      reference_type: 'return',
      reference_id: this.selectedBill.bill_id
    }), 'Posting the bank refund failed');
  }

  private async rebuildInternalTransferExpenses(billId: number) {
    // Get the original transfer record for this bill
    const transferResult = await this.db.get(
      'SELECT * FROM internal_transfers WHERE bill_id = ? LIMIT 1',
      [billId]
    );
    const transfer = transferResult.success && transferResult.data && transferResult.data.length
      ? transferResult.data[0]
      : null;
    if (!transfer) return;

    const billRow = await this.db.get('SELECT bill_number FROM bills WHERE bill_id = ?', [billId]);
    const billNumber = billRow.success && billRow.data && billRow.data.length ? billRow.data[0].bill_number : null;

    // 🔥 FIX: clean up whichever table each transfer actually points at
    // (medicine_entries / feed_entries / chick_entries / vaccinations /
    // expenses), same
    // logic as cleanupInternalTransfers() in sales-orders.component.ts.
    // The old version here only checked expense_id, which is null for
    // medicine/feed/vaccination transfers — leaving those rows orphaned
    // and then miscategorizing the return as a generic expense.
    const oldTransfers = await this.db.get(
      'SELECT * FROM internal_transfers WHERE bill_id = ?',
      [billId]
    );
    for (const row of oldTransfers.success ? oldTransfers.data : []) {
      const targetType = row.target_type || (row.expense_id ? 'expense' : null);
      const refId = row.reference_id || row.expense_id;

      if (targetType === 'medicine' && refId) {
        await this.mustRun('DELETE FROM medicine_entries WHERE entry_id = ?', [refId]);
      } else if (targetType === 'feed' && refId) {
        await this.mustRun('DELETE FROM feed_entries WHERE entry_id = ?', [refId]);
      } else if (targetType === 'chick' && refId) {
        await this.mustRun('DELETE FROM chick_entries WHERE entry_id = ?', [refId]);
      } else if (targetType === 'vaccination' && refId) {
        await this.mustRun('DELETE FROM vaccinations WHERE vaccination_id = ?', [refId]);
      } else if (row.expense_id) {
        await this.mustRun('DELETE FROM expenses WHERE expense_id = ?', [row.expense_id]);
      }
    }
    // Remove old internal_transfer rows
    await this.mustRun('DELETE FROM internal_transfers WHERE bill_id = ?', [billId]);

    // 🔥 FIX: re-create each remaining bill item in ITS OWN category table,
    // not always as a generic expense — otherwise every returned
    // medicine/feed/vaccination item permanently loses its category.
    const itemsResult = await this.db.get(
      'SELECT * FROM bill_items WHERE bill_id = ?',
      [billId]
    );

    const billTag = billNumber ? ` (Bill #${billNumber})` : '';

    for (const item of itemsResult.success ? itemsResult.data : []) {
      const productRes = item.product_id
        ? await this.db.get('SELECT category FROM products WHERE product_id = ?', [item.product_id])
        : { success: false, data: [] };
      const category = (productRes.success && productRes.data.length > 0)
        ? (productRes.data[0].category || '').toLowerCase()
        : '';

      let expenseId = null;
      let targetType = 'expense';
      let referenceId = null;

      if (category === 'medicine') {
        targetType = 'medicine';
        let traderRes = await this.db.get(
          'SELECT trader_id FROM medicine_traders WHERE flock_id=? AND module_type=? AND trader_name=?',
          [transfer.target_flock_id, transfer.target_module, 'Internal Distribution']
        );
        let traderId = traderRes.success && traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
        if (!traderId) {
          const newTrader = await this.mustRun(
            'INSERT INTO medicine_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
            [transfer.target_flock_id, 'Internal Distribution', transfer.target_module]
          );
          traderId = newTrader.lastId;
        }
        if (traderId) {
          const entryResult = await this.mustRun(
            'INSERT INTO medicine_entries (trader_id, flock_id, date, medicine_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [traderId, transfer.target_flock_id, this.returnDate, item.product_name + billTag, item.quantity, item.unit_price, item.total_price, transfer.target_module, billId, billNumber]
          );
          referenceId = entryResult.lastId;
        }
      } else if (category === 'feed') {
        targetType = 'feed';
        let traderRes = await this.db.get(
          'SELECT trader_id FROM feed_traders WHERE flock_id=? AND module_type=? AND trader_name=?',
          [transfer.target_flock_id, transfer.target_module, 'Internal Distribution']
        );
        let traderId = traderRes.success && traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
        if (!traderId) {
          const newTrader = await this.mustRun(
            'INSERT INTO feed_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
            [transfer.target_flock_id, 'Internal Distribution', transfer.target_module]
          );
          traderId = newTrader.lastId;
        }
        if (traderId) {
          const entryResult = await this.mustRun(
            'INSERT INTO feed_entries (trader_id, flock_id, date, feed_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [traderId, transfer.target_flock_id, this.returnDate, item.product_name + billTag, item.quantity, item.unit_price, item.total_price, transfer.target_module, billId, billNumber]
          );
          referenceId = entryResult.lastId;
        }
      } else if (category === 'chick' || category === 'chicks') {
        targetType = 'chick';
        let traderRes = await this.db.get(
          'SELECT trader_id FROM chick_traders WHERE flock_id=? AND module_type=? AND trader_name=?',
          [transfer.target_flock_id, transfer.target_module, 'Internal Distribution']
        );
        let traderId = traderRes.success && traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
        if (!traderId) {
          const newTrader = await this.mustRun(
            'INSERT INTO chick_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
            [transfer.target_flock_id, 'Internal Distribution', transfer.target_module]
          );
          traderId = newTrader.lastId;
        }
        if (traderId) {
          const entryResult = await this.mustRun(
            'INSERT INTO chick_entries (trader_id, flock_id, date, chick_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [traderId, transfer.target_flock_id, this.returnDate, item.product_name + billTag, item.quantity, item.unit_price, item.total_price, transfer.target_module, billId, billNumber]
          );
          referenceId = entryResult.lastId;
        }
      } else if (category === 'vaccine' || category === 'vaccination') {
        targetType = 'vaccination';
        // cost must be written here, exactly as medicine/feed write total_amount
        // above — omitting it made every returned vaccination item come back at
        // zero cost. dose carries the remaining quantity, not a hardcoded '1'.
        const vaccResult = await this.mustRun(
          'INSERT INTO vaccinations (batch_id, flock_id, date, vaccine_name, dose, notes, cost, done, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [
            transfer.target_module === 'layer' ? transfer.target_flock_id : null,
            transfer.target_module === 'broiler' ? transfer.target_flock_id : null,
            this.returnDate, item.product_name, String(item.quantity),
            'Internal Transfer (adjusted after return)' + billTag,
            item.total_price, 1, billId, billNumber
          ]
        );
        referenceId = vaccResult.lastId;
      } else {
        targetType = 'expense';
        const expenseResult = await this.mustRun(
          'INSERT INTO expenses (flock_id, date, description, amount, module_type) VALUES (?, ?, ?, ?, ?)',
          [transfer.target_flock_id, this.returnDate, `${item.product_name} x ${item.quantity}${billTag}`, item.total_price, transfer.target_module]
        );
        expenseId = expenseResult.lastId;
        referenceId = expenseId;
      }

      await this.mustRun(
        'INSERT INTO internal_transfers (bill_id, expense_id, target_module, target_flock_id, target_type, reference_id) VALUES (?,?,?,?,?,?)',
        [billId, expenseId, transfer.target_module, transfer.target_flock_id, targetType, referenceId]
      );
    }
  }
}
