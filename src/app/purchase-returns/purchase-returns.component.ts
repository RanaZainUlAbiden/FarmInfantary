import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
@Component({
  selector: 'app-purchase-returns',
  standalone: true,
  imports: [CommonModule, FormsModule, DateOnlyPipe, PaginationComponent],
  templateUrl: './purchase-returns.component.html',
  styleUrl: './purchase-returns.component.scss'
})
export class PurchaseReturnsComponent implements OnInit {
  currentFarm: any = null;
  purchases: any[] = [];
  filteredPurchases: any[] = [];
  purchaseSearchTerm: string = '';
  returns: any[] = [];

  selectedPurchase: any = null;
  returnQuantity: number | null = null;
  returnDate = toLocalDateString();
  reason = '';
  refundMethod: 'cash' | 'bank' = 'cash';

  isLoading = true;
  isSaving = false;
  errorMessage = '';
  successMessage = '';

  purchasesPage = 1;
  purchasesPageSize = 20;
  returnsPage = 1;
  returnsPageSize = 20;

  get paginatedPurchases() {
    const start = (this.purchasesPage - 1) * this.purchasesPageSize;
    return this.filteredPurchases.slice(start, start + this.purchasesPageSize);
  }

  get paginatedReturns() {
    const start = (this.returnsPage - 1) * this.returnsPageSize;
    return this.returns.slice(start, start + this.returnsPageSize);
  }

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadData();
  }

  // ── Computed ─────────────────────────────────────────────────

  get returnAmount(): number {
    const qty = Number(this.returnQuantity) || 0;
    const price = Number(this.selectedPurchase?.cost_price) || 0;
    return qty * price;
  }

  get maxReturnable(): number {
    if (!this.selectedPurchase) return 0;
    const purchased = Number(this.selectedPurchase.quantity) || 0;
    const alreadyReturned = Number(this.selectedPurchase.returned_quantity) || 0;
    return Math.max(0, purchased - alreadyReturned);
  }

  get totalReturnsAmount(): number {
    return this.returns.reduce((sum, r) => sum + (Number(r.return_amount) || 0), 0);
  }

  // ── Data Loading ─────────────────────────────────────────────

  async loadData() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const [purchasesResult, returnsResult] = await Promise.all([
        this.db.get(
          `SELECT po.*, p.product_name, s.supplier_name,
                  COALESCE(SUM(pr.quantity), 0) AS returned_quantity
           FROM purchase_orders po
           LEFT JOIN products p ON p.product_id = po.product_id
           LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
           LEFT JOIN purchase_returns pr ON pr.purchase_id = po.purchase_id
           WHERE po.farm_id = ?
             AND COALESCE(po.status, 'completed') != 'returned'
           GROUP BY po.purchase_id
           ORDER BY po.date DESC, po.purchase_id DESC`,
          [this.currentFarm.farm_id]
        ),
        this.db.get(
          `SELECT pr.*, po.product_id, p.product_name, s.supplier_name
           FROM purchase_returns pr
           JOIN purchase_orders po ON po.purchase_id = pr.purchase_id
           LEFT JOIN products p ON p.product_id = po.product_id
           LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
           WHERE pr.farm_id = ?
           ORDER BY pr.return_date DESC, pr.return_id DESC`,
          [this.currentFarm.farm_id]
        )
      ]);
      this.purchases = purchasesResult.success ? purchasesResult.data : [];
      this.filterPurchases();
      this.returns = returnsResult.success ? returnsResult.data : [];
      this.returnsPage = 1;
    } catch (error: any) {
      this.errorMessage = 'Failed to load purchase returns: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── Search ───────────────────────────────────────────────────

  filterPurchases() {
    const term = this.purchaseSearchTerm.trim().toLowerCase();
    if (!term) {
      this.filteredPurchases = [...this.purchases];
      this.purchasesPage = 1;
      this.cdr.detectChanges();
      return;
    }
    this.filteredPurchases = this.purchases.filter(p =>
      (p.product_name || '').toLowerCase().includes(term) ||
      (p.supplier_name || '').toLowerCase().includes(term) ||
      (p.notes || '').toLowerCase().includes(term)
    );
    this.purchasesPage = 1;
    this.cdr.detectChanges();
  }

  clearPurchaseSearch() {
    this.purchaseSearchTerm = '';
    this.filteredPurchases = [...this.purchases];
    this.purchasesPage = 1;
    this.cdr.detectChanges();
  }

  // ── Selection ────────────────────────────────────────────────

  selectPurchase(purchase: any) {
    this.selectedPurchase = purchase;
    this.returnQuantity = null;
    this.returnDate = toLocalDateString();
    this.reason = '';
    this.refundMethod = 'cash';
    this.errorMessage = '';
    this.successMessage = '';
    this.cdr.detectChanges();
  }

  clearSelection() {
    this.selectedPurchase = null;
    this.returnQuantity = null;
    this.errorMessage = '';
    this.successMessage = '';
    this.filterPurchases();
    this.cdr.detectChanges();
  }

  // ── Save Return ───────────────────────────────────────────────

  async saveReturn() {
    if (!this.selectedPurchase || this.isSaving) return;

    const qty = Number(this.returnQuantity) || 0;
    if (qty <= 0) {
      this.errorMessage = 'Enter a return quantity greater than 0.';
      return;
    }
    if (qty > this.maxReturnable) {
      this.errorMessage = `Return quantity cannot exceed ${this.maxReturnable} (already purchased minus previously returned).`;
      return;
    }

    this.isSaving = true;
    this.errorMessage = '';
    this.successMessage = '';

    try {
      const returnNumber = await this.getNextReturnNumber();
      const returnAmt = this.returnAmount;
      const purchase = this.selectedPurchase;

      // 1. Insert purchase_returns record
      const insertReturn = await this.db.run(
        `INSERT INTO purchase_returns
          (farm_id, purchase_id, return_number, return_date, quantity, return_amount, refund_method, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.currentFarm.farm_id,
          purchase.purchase_id,
          returnNumber,
          this.returnDate,
          qty,
          returnAmt,
          this.refundMethod,
          this.reason || null
        ]
      );
      if (!insertReturn.success) throw new Error('Failed to create return record: ' + friendlySqlError(insertReturn.error, 'unknown error'));
      const returnId = insertReturn.lastId;
      if (!returnId) throw new Error('Return ID not obtained — check PRIMARY_KEY_MAP.');

      // 2. Remove the returned stock from inventory
      await this.deductReturnedStock(purchase, qty, returnId, returnNumber);

      // 3. Update purchase order status (quantity/total_amount stay as originally
      //    purchased — the return is tracked separately via purchase_returns —
      //    but we flag status so fully-returned orders drop out of the eligible list)
      const newReturnedTotal = (Number(purchase.returned_quantity) || 0) + qty;
      const newStatus = newReturnedTotal >= Number(purchase.quantity) ? 'returned' : 'partial_return';
      await this.db.run(
        `UPDATE purchase_orders SET status = ? WHERE purchase_id = ?`,
        [newStatus, purchase.purchase_id]
      );

      // 4. Supplier ledger — always post a debit for the returned amount.
      //    This correctly reduces what you owe if the order was unpaid (credit),
      //    or shows a receivable from the supplier if it was already paid (cash).
      if (purchase.supplier_id) {
        await this.db.addSupplierLedgerEntry({
          supplier_id: purchase.supplier_id,
          transaction_date: this.returnDate,
          description: `Return ${returnNumber} - Purchase #${purchase.purchase_id}${this.reason ? ' - ' + this.reason : ''}`,
          debit: returnAmt,
          credit: 0,
          reference_type: 'return',
          reference_id: purchase.purchase_id
        });
      }

      this.successMessage = `Return ${returnNumber} saved successfully.`;
      this.clearSelection();
      await this.loadData();
    } catch (error: any) {
      this.errorMessage = 'Failed to save return: ' + error.message;
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async getNextReturnNumber(): Promise<string> {
    const result = await this.db.get(
      `SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 6) AS INTEGER)), 0) + 1 AS next_number
       FROM purchase_returns
       WHERE farm_id = ? AND return_number LIKE 'PRET-%'`,
      [this.currentFarm.farm_id]
    );
    const num = result.success && result.data && result.data[0]
      ? result.data[0].next_number
      : 1;
    return 'PRET-' + String(num).padStart(3, '0');
  }

  private async deductReturnedStock(purchase: any, qty: number, returnId: number, returnNumber: string) {
    const today = toLocalDateString();
    const note = `${returnNumber} - Returned to supplier`;

    if (purchase.batch_id) {
      const result = await this.adjustBatch(purchase.batch_id, -qty, purchase.product_id, note);
      if (result.success) {
        await this.db.updateBatchStatuses();
        return;
      }
      // Linked batch missing — fall through to FIFO fallback below.
    }

    // FIFO fallback across the product's active batches
    const batchesResult = await this.db.getBatchesByProduct(purchase.product_id, this.currentFarm.farm_id);
    if (!batchesResult.success || !batchesResult.data) return;

    const activeBatches = batchesResult.data
      .filter((b: any) => (b.calculated_status === 'active' || b.calculated_status === 'expiring') && b.quantity > 0)
      .sort((a: any, b: any) => (a.expiry_date || '').localeCompare(b.expiry_date || ''));

    let remaining = qty;
    for (const batch of activeBatches) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, batch.quantity || 0);
      const newQty = (batch.quantity || 0) - deduct;
      await this.db.updateBatch(batch.batch_id, { quantity: newQty });
      await this.db.addBatchTransaction(
        batch.batch_id, purchase.product_id, 'adjustment', deduct, today, returnId, note
      );
      remaining -= deduct;
    }
    await this.db.updateBatchStatuses();
  }

  private async adjustBatch(batchId: number, delta: number, productId: number, note: string): Promise<{ success: boolean }> {
    const r = await this.db.get('SELECT * FROM product_batches WHERE batch_id = ?', [batchId]);
    const batch = r.success && r.data && r.data.length > 0 ? r.data[0] : null;
    if (!batch) return { success: false };

    const newQty = Math.max(0, Number(batch.quantity) + delta);
    const appliedDelta = newQty - Number(batch.quantity);
    await this.db.updateBatch(batchId, { quantity: newQty });

    if (appliedDelta !== 0) {
      await this.db.addBatchTransaction(
        batchId, productId, 'adjustment', Math.abs(appliedDelta),
        toLocalDateString(), null, note
      );
    }
    return { success: true };
  }
}