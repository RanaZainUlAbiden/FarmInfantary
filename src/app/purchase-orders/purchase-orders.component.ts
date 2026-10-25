import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankSourceFields, bankNameOf } from '../shared/utils/bank-source.util';
import { AuthService } from '../shared/services/auth.service';
import { FormStateService } from '../shared/services/form-state.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { jsPDF } from 'jspdf';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { printPdfBase64 } from '../shared/utils/browser-print.util';
@Component({
  selector: 'app-purchase-orders',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './purchase-orders.component.html',
  styleUrl: './purchase-orders.component.scss'
})
export class PurchaseOrdersComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  // The farm's OWN accounts. Never getBankAccounts() unscoped - that also
  // returns customers' accounts, and paying a supplier out of a customer's
  // account would record it as that customer's withdrawal.
  houseBanks: any[] = [];
  products: any[] = [];
  suppliers: any[] = [];
  orders: any[] = [];
  filteredOrders: any[] = [];
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  showDeleteCodeDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';
  isLoading = true;
  searchTerm: string = '';

  currentPage = 1;
  pageSize = 15; // Changed from 20 to 15

  // ── STATE PERSISTENCY KEYS ────────────────────────────────
  private readonly FORM_KEY = 'purchase_orders_form_state';
  private saveTimeout: any = null;

  get paginatedOrders() {
    const start = (this.currentPage - 1) * this.pageSize;
    const dataToShow = this.searchTerm ? this.filteredOrders : this.orders;
    return dataToShow.slice(start, start + this.pageSize);
  }

  get totalItems() {
    return this.searchTerm ? this.filteredOrders.length : this.orders.length;
  }

  get hasPendingRows() { return this.pendingRows.length > 0; }

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private formState: FormStateService
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadData();
  }

  ngOnDestroy() {
    // Save state when component is destroyed
    if (this.pendingRows.length > 0 && !this.isSavingAll) {
      this.saveState();
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
  }

  // ── STATE PERSISTENCY METHODS ─────────────────────────────

  private saveState(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      if (this.pendingRows.length > 0) {
        const state = {
          pendingRows: this.pendingRows,
          currentPage: this.currentPage,
          searchTerm: this.searchTerm
        };
        this.formState.saveState(this.FORM_KEY, state);
        console.log('💾 Purchase orders state auto-saved');
      } else {
        this.formState.clearState(this.FORM_KEY);
      }
    }, 500);
  }

  private restoreState(): void {
    const state = this.formState.getState(this.FORM_KEY);
    if (state && state.pendingRows && state.pendingRows.length > 0) {
      console.log('📂 Restoring Purchase Orders form state:', state);
      this.pendingRows = state.pendingRows;
      if (state.currentPage) {
        this.currentPage = state.currentPage;
      }
      if (state.searchTerm) {
        this.searchTerm = state.searchTerm;
        this.filterOrders();
      }
      this.cdr.detectChanges();
    }
  }

  // ── AUTO-SAVE ──────────────────────────────────────────────

  onFormChange(): void {
    if (this.pendingRows.length > 0) {
      this.saveState();
    }
  }

  // ── SEARCH / FILTER ────────────────────────────────────────

  filterOrders() {
    if (!this.searchTerm.trim()) {
      this.filteredOrders = [];
      this.currentPage = 1;
      this.cdr.detectChanges();
      return;
    }
    
    const term = this.searchTerm.toLowerCase().trim();
    this.filteredOrders = this.orders.filter(o => {
      // Get supplier name
      const supplier = this.suppliers.find(s => s.supplier_id === o.supplier_id);
      const supplierName = supplier ? supplier.supplier_name.toLowerCase() : '';
      
      // Also search by product name, bill number, or date if needed
      const product = this.products.find(p => p.product_id === o.product_id);
      const productName = product ? product.product_name.toLowerCase() : '';
      
      return supplierName.includes(term) || 
             productName.includes(term) ||
             o.notes?.toLowerCase().includes(term) ||
             o.date?.includes(term);
    });
    
    this.currentPage = 1;
    this.cdr.detectChanges();
    this.onFormChange();
  }

  clearSearch() {
    this.searchTerm = '';
    this.filteredOrders = [];
    this.currentPage = 1;
    this.cdr.detectChanges();
    this.onFormChange();
  }

  async loadData() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      const pr = await this.db.get('SELECT * FROM products WHERE farm_id=? ORDER BY product_name ASC', [this.currentFarm.farm_id]);
      this.products = pr.success ? pr.data : [];
      
      const sr = await this.db.get('SELECT * FROM suppliers WHERE farm_id=? ORDER BY supplier_name ASC', [this.currentFarm.farm_id]);
      this.suppliers = sr.success ? sr.data : [];
      
      // Re-read every load: the account list is farm-wide, so an account added
      // on the Bank screen has to appear here without a reload.
      const bankRes = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
      this.houseBanks = bankRes.success ? (bankRes.data || []) : [];
      // The linked batch's code rides along so the Batch No. column can show
      // what the client typed, rather than this screen deriving it a second way.
      const or = await this.db.get(
        `SELECT po.*, pb.batch_code
         FROM purchase_orders po
         LEFT JOIN product_batches pb ON pb.batch_id = po.batch_id
         WHERE po.farm_id = ? ORDER BY po.date DESC`,
        [this.currentFarm.farm_id]);
      this.orders = or.success ? or.data : [];
      
      // 🔥 Restore state AFTER data is loaded
      this.restoreState();
      
      // Apply search if there's a search term
      if (this.searchTerm) {
        this.filterOrders();
      }
      
      this.cdr.detectChanges();
    } catch (error: any) {
      this.errorMessage = 'Failed to load data: ' + error.message;
      console.error('Load error:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  getProductName(id: number) { return this.products.find(p => p.product_id === id)?.product_name || '—'; }
  getSupplierName(id: number) { return this.suppliers.find(s => s.supplier_id === id)?.supplier_name || '—'; }

  makeNewRow() { 
    return { 
      product_id: this.products[0]?.product_id || null, 
      supplier_id: null, 
      date: toLocalDateString(), 
      quantity: null, 
      cost_price: null, 
      // THE BATCH NUMBER IS TYPED, NOT GENERATED. `addBatch` still has an
      // auto-code fallback for callers with nothing to pass, but a purchase
      // now always carries the client's own — he reads these off the sack and
      // off the supplier's own paperwork, and a generated BATCH-003-007 is a
      // number that exists nowhere outside this app.
      batch_code: '',
      payment_type: 'cash',
      payment_source: 'cash',
      bank_id: null,
      notes: '',
      receipt_image: null
    };
  }

  bankNameOf(bankId: number | null): string { return bankNameOf(this.houseBanks, bankId); }

  /**
   * WHY THIS SCREEN HAS ITS OWN Cash/Bank CONTROL.
   *
   * On the sale, expense, labour and layer-sale screens the existing
   * `payment_type` selector IS the Cash/Bank selector, and `payment_source` is
   * derived from it. Here it cannot be: this screen's payment_type is
   * "Paid (Debit)" vs "Unpaid (Credit)", a SETTLEMENT STATUS that drives
   * `isPaid` and the supplier ledger's debit. Adding 'bank' to it would make a
   * bank-paid order read as unpaid and move the supplier payable, so Cash/Bank
   * lives in `payment_source` instead and is only offered on a paid order.
   *
   * Which makes the normalization below load-bearing: an UNPAID order never
   * carries a withdrawal, whatever payment_source happens to say. No money has
   * left yet - that is the whole meaning of credit - so there is nothing to
   * take out of an account, and nothing to reverse when it is later settled on
   * the supplier ledger.
   */
  private bankFieldsFor(row: any): { payment_source: string; bank_id: number | null } {
    const paid = (row?.payment_type || 'credit').toLowerCase() === 'cash';
    return paid ? bankSourceFields(row) : { payment_source: 'cash', bank_id: null };
  }

  /** Only a paid order can name an account, so the error follows the same rule. */
  private bankErrorFor(row: any, label = ''): string | null {
    const paid = (row?.payment_type || 'credit').toLowerCase() === 'cash';
    return paid ? bankSourceError(row, this.houseBanks, label) : null;
  }

  /**
   * Marking an order unpaid clears the account it named, so the picker does not
   * sit there showing a choice that no longer applies and the row cannot be
   * saved carrying a stale one.
   */
  onPaymentTypeChange(row: any) {
    if ((row?.payment_type || '').toLowerCase() !== 'cash') {
      row.payment_source = 'cash';
      row.bank_id = null;
    }
    this.onFormChange();
  }

  /** How a bank-paid purchase is labelled on the bank statement. */
  private withdrawalLabel(row: any, purchaseId: number): string {
    const supplier = this.getSupplierName(row?.supplier_id);
    const product = this.getProductName(row?.product_id);
    const who = supplier && supplier !== '—' ? supplier : 'supplier';
    return `Purchase order #${purchaseId} — ${product} (${who})`;
  }

  addPendingRow() { 
    if (!this.isSaving) {
      this.pendingRows.push(this.makeNewRow());
      this.onFormChange();
      this.cdr.detectChanges();
    }
  }

  addRowAfter(i: number) { 
    this.pendingRows.splice(i + 1, 0, this.makeNewRow());
    this.onFormChange();
    this.cdr.detectChanges();
  }

  removePendingRow(i: number) { 
    this.pendingRows.splice(i, 1);
    this.onFormChange();
    this.cdr.detectChanges();
  }

  onProductSelect(row: any) {
    if (!row.product_id) {
      row.cost_price = null;
      row.unit = null;
      return;
    }
    const product = this.products.find(p => p.product_id === row.product_id);
    if (product) {
      if (product.cost_price) {
        row.cost_price = product.cost_price;
        console.log(`✅ Auto-filled cost price: Rs. ${product.cost_price} for ${product.product_name}`);
      } else {
        row.cost_price = 0;
        console.warn(`⚠️ No cost price found for ${product.product_name}`);
      }
      if (product.unit) {
        row.unit = product.unit;
      }
    }
    this.onFormChange();
  }

  onFileSelected(event: any, target: any) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxWidth = 800;
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        target.receipt_image = canvas.toDataURL('image/jpeg', 0.7);
        this.onFormChange();
        this.cdr.detectChanges();
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  async openImage(base64: string) {
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load receipt image'));
        img.src = base64;
      });
      const doc = new jsPDF({
        orientation: img.width > img.height ? 'landscape' : 'portrait',
        unit: 'mm',
        format: 'a4'
      });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 10;
      const maxW = pageWidth - margin * 2;
      const maxH = pageHeight - margin * 2;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (pageWidth - w) / 2;
      const y = (pageHeight - h) / 2;
      doc.addImage(base64, 'JPEG', x, y, w, h);
      const dataUri = doc.output('datauristring');
      const pdfBase64 = dataUri.split(',')[1];
      const result = await printPdfBase64(pdfBase64);
      if (!result || !result.success) {
        console.error('Print failed:', result?.error);
      }
    } catch (e) {
      console.error('Failed to print receipt image:', e);
    }
  }


  // ── BATCH OPERATIONS ─────────────────────────────────────

  /** Throws on failure — callers run inside a `db.transaction`, so a swallowed
   *  error here would let an incomplete write commit along with the rest. */
  async updateInventoryWithBatch(productId: number, quantity: number, costPrice: number, batchCode?: string) {
    const today = toLocalDateString();
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const expiryDate = toLocalDateString(oneYearLater);

    const result = this.assertOk(await this.db.addBatch({
      product_id: productId,
      farm_id: this.currentFarm.farm_id,
      // Empty falls through to addBatch's generated code. Every path on this
      // screen passes one, but the legacy-order branches in saveEdit() can
      // reach here with nothing to pass.
      batch_code: (batchCode || '').trim() || undefined,
      manufacturing_date: today,
      expiry_date: expiryDate,
      quantity: quantity,
      purchase_price: costPrice
    }), 'Failed to update inventory');

    console.log(`✅ Added ${quantity} units to product ${productId} as batch ${result.batch_code}`);
    return result;
  }

  // ── SUPPLIER LEDGER INTEGRATION ─────────────────────────

  async addToSupplierLedger(supplierId: number, purchaseId: number, amount: number, paymentType: string, notes: string) {
    if (!supplierId) {
      console.warn('⚠️ No supplier ID provided, skipping ledger entry');
      return;
    }
    const isPaid = paymentType?.toLowerCase() === 'cash';
    const credit = amount;
    const debit = isPaid ? amount : 0;

    this.assertOk(await this.db.addSupplierLedgerEntry({
      supplier_id: supplierId,
      transaction_date: toLocalDateString(),
      description: `Purchase Order #${purchaseId}${notes ? ' - ' + notes : ''}`,
      debit: debit,
      credit: credit,
      reference_type: 'purchase',
      reference_id: purchaseId
    }), 'Failed to update supplier ledger');
  }

  async removeFromSupplierLedger(purchaseId: number, supplierId: number) {
    if (!supplierId) return;
    await this.mustRun('DELETE FROM supplier_ledger WHERE reference_id = ? AND reference_type = ?', [purchaseId, 'purchase']);
  }

  async updateSupplierLedgerOnEdit(purchaseId: number, supplierId: number, oldSupplierId: number, amount: number, paymentType: string, notes: string) {
    if (oldSupplierId) {
      await this.mustRun('DELETE FROM supplier_ledger WHERE reference_id = ? AND reference_type = ?', [purchaseId, 'purchase']);
    }
    if (supplierId) {
      const isPaid = paymentType?.toLowerCase() === 'cash';
      this.assertOk(await this.db.addSupplierLedgerEntry({
        supplier_id: supplierId,
        transaction_date: toLocalDateString(),
        description: `Purchase Order #${purchaseId}${notes ? ' - ' + notes : ''}`,
        debit: isPaid ? amount : 0,
        credit: amount,
        reference_type: 'purchase',
        reference_id: purchaseId
      }), 'Failed to update supplier ledger');
    }
  }

  // ── Transaction helpers ──────────────────────────────────────
  // db.run()/db.get() and the DatabaseService helpers report failures as
  // { success: false } instead of throwing, so an unchecked write inside a
  // transaction would otherwise fail silently and still get committed along
  // with everything else. Everything on the purchase-order save/edit/delete
  // paths goes through these.

  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'unknown error')}`);
    }
    return result;
  }

  private async mustRun(sql: string, params: any[] = []): Promise<any> {
    return this.assertOk(await this.db.run(sql, params), 'Database write failed');
  }

  /**
   * The first duplicate batch number among the pending rows, as the sentence
   * the client reads — or null when every one is free.
   *
   * Case-insensitive and trimmed, because "H-204" and "h-204 " are the same
   * number written twice, and the clash this prevents is one the client could
   * not see afterwards.
   */
  private async findBatchCodeClash(): Promise<string | null> {
    const seen = new Map<string, number>();

    for (let i = 0; i < this.pendingRows.length; i++) {
      const row = this.pendingRows[i];
      const code = (row.batch_code || '').trim();
      const key = Number(row.product_id) + '|' + code.toLowerCase();

      const firstRow = seen.get(key);
      if (firstRow !== undefined) {
        return `Rows ${firstRow} and ${i + 1} both use batch number "${code}" ` +
               `for ${this.getProductName(row.product_id)}. Batch numbers must be unique per product.`;
      }
      seen.set(key, i + 1);

      const existing = await this.db.get(
        `SELECT COUNT(*) AS n FROM product_batches
         WHERE product_id = ? AND farm_id = ? AND LOWER(TRIM(batch_code)) = ?`,
        [row.product_id, this.currentFarm.farm_id, code.toLowerCase()]
      );
      if (!existing.success) {
        return 'Could not check the batch number: ' +
               friendlySqlError(existing.error, 'unknown error');
      }
      if (Number((existing.data || [])[0]?.n || 0) > 0) {
        return `Row ${i + 1}: batch number "${code}" is already recorded for ` +
               `${this.getProductName(row.product_id)}.`;
      }
    }

    return null;
  }

  // ── SAVE OPERATIONS ──────────────────────────────────────

  async saveAllRows() {
    if (!this.pendingRows.length || this.isSavingAll) return;

    // Validate every row up front. If any row is invalid, stop before saving
    // anything so we never silently drop a row the user typed data into.
    for (let i = 0; i < this.pendingRows.length; i++) {
      const row = this.pendingRows[i];
      if (!row.product_id || row.quantity === null || row.quantity === undefined || row.cost_price === null || row.cost_price === undefined) {
        this.errorMessage = `Row ${i + 1}: please fill in product, quantity and cost price.`;
        this.cdr.detectChanges();
        return;
      }
      // THE SUPPLIER IS REQUIRED, and it is not a cosmetic field.
      // `addToSupplierLedger()` returns early when there is none, so an order
      // saved without one brought the stock in and recorded the money owed to
      // NOBODY: no `supplier_ledger` credit, nothing on any statement, and
      // nothing in the payable the Distribution report prints. An unpaid order
      // simply vanished from what the farm owes.
      if (!Number(row.supplier_id)) {
        this.errorMessage = `Row ${i + 1}: choose the supplier this stock came from.`;
        this.cdr.detectChanges();
        return;
      }
      if (Number(row.quantity) < 0 || Number(row.cost_price) < 0) {
        this.errorMessage = `Row ${i + 1}: quantity and cost must not be negative.`;
        this.cdr.detectChanges();
        return;
      }
      if (!(row.batch_code || '').trim()) {
        this.errorMessage = `Row ${i + 1}: enter the batch number for this stock.`;
        this.cdr.detectChanges();
        return;
      }
      const bankErr = this.bankErrorFor(row, `Row ${i + 1}`);
      if (bankErr) {
        this.errorMessage = bankErr;
        this.cdr.detectChanges();
        return;
      }
    }

    // ONE BATCH NUMBER PER PRODUCT. Two batches of one product sharing a code
    // are indistinguishable everywhere the code is shown — the batch picker on
    // Sales Orders, the expiry warnings, the Inventory drill-down — and FIFO
    // would then draw from "the" batch the client cannot identify. Checked
    // against the rows being typed AND against what is already stored, and
    // before the transaction opens, so a refusal leaves nothing to roll back.
    const batchClash = await this.findBatchCodeClash();
    if (batchClash) {
      this.errorMessage = batchClash;
      this.cdr.detectChanges();
      return;
    }

    // NO ACCOUNT MAY BE TAKEN BELOW ZERO, and the whole set of rows is weighed
    // at once: three paid orders each affordable on their own are not
    // affordable together, and they all land in one transaction. Weighed here,
    // alongside the other up-front validation and before the transaction
    // opens, so a refusal leaves nothing to roll back.
    //
    // `bankFieldsFor()` rather than `bankSourceFields()`, for the reason it
    // exists: an UNPAID order has moved no money whatever its payment_source
    // says, so it contributes nothing to any balance.
    const balanceGuard = await this.db.checkBankSourceInserts(
      'purchase_orders',
      this.pendingRows.map(row => ({
        ...this.bankFieldsFor(row),
        amount: Number(row.quantity) * Number(row.cost_price)
      }))
    );
    if (!balanceGuard.success) {
      this.errorMessage = balanceGuard.error || 'Not enough balance in that account.';
      this.cdr.detectChanges();
      return;
    }

    this.isSavingAll = true;
    this.errorMessage = '';

    try {
      // One transaction for every pending row: each order's insert, its
      // supplier-ledger entry and its inventory batch either all land
      // together or none of them do, and the database file is written once,
      // on commit. A failure on row 3 of 5 used to leave rows 1-2 saved,
      // row 3 half-written (order row with no ledger entry / no batch), and
      // rows 4-5 silently skipped.
      await this.db.transaction(async () => {
        for (const row of this.pendingRows) {
          const totalAmount = row.quantity * row.cost_price;
          const paymentType = row.payment_type || 'credit';

          const bank = this.bankFieldsFor({ ...row, payment_type: paymentType });

          const result = await this.mustRun(
            'INSERT INTO purchase_orders (farm_id, supplier_id, product_id, date, quantity, cost_price, total_amount, payment_type, payment_source, bank_id, notes, receipt_image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [this.currentFarm.farm_id, row.supplier_id, row.product_id, row.date, row.quantity, row.cost_price, totalAmount, paymentType, bank.payment_source, bank.bank_id, row.notes, row.receipt_image || null]
          );

          const purchaseId = result.lastId;
          if (typeof purchaseId !== 'number' || purchaseId <= 0) {
            throw new Error('The purchase order was saved but its id could not be read back');
          }

          // Paid out of a bank account: the withdrawal goes in now, keyed to
          // the id just read back. The id is known, so this needs no $lastId
          // marker - and inside the open transaction the runBatch becomes a
          // SAVEPOINT, so it composes with everything else here.
          const bankOps = this.db.bankSourceInsertOps('purchase_orders', {
            ...bank,
            date: row.date,
            description: this.withdrawalLabel(row, purchaseId),
            amount: totalAmount,
            referenceId: purchaseId
          });
          if (bankOps.length > 0) {
            this.assertOk(
              await this.db.runBatch([...bankOps, ...this.db.bankRebuildOps([bank.bank_id])]),
              'Recording the bank withdrawal failed');
          }

          if (row.supplier_id) {
            await this.addToSupplierLedger(row.supplier_id, purchaseId, totalAmount, paymentType, row.notes);
          }
          const batchResult = await this.updateInventoryWithBatch(row.product_id, row.quantity, row.cost_price, row.batch_code);
          if (batchResult.batch_id) {
            await this.mustRun('UPDATE purchase_orders SET batch_id = ? WHERE purchase_id = ?', [batchResult.batch_id, purchaseId]);
          }
        }
      });

      // Committed. Clear state on successful save.
      this.formState.clearState(this.FORM_KEY);
      this.pendingRows = [];
      this.searchTerm = '';
      this.filteredOrders = [];
      await this.loadData();

    } catch (error: any) {
      // The transaction rolled back — none of the pending rows were written.
      console.error('❌ Error saving:', error);
      this.errorMessage = 'Error saving: ' + (error?.message || error);
    } finally {
      this.isSavingAll = false;
      this.cdr.detectChanges();
    }
  }

  cancelAllRows() {
    this.pendingRows = [];
    this.formState.clearState(this.FORM_KEY);
    this.cdr.detectChanges();
  }

  startEdit(o: any) { 
    this.editingId = o.purchase_id; 
    this.editForm = { 
      product_id: o.product_id, 
      supplier_id: o.supplier_id, 
      date: o.date, 
      quantity: o.quantity, 
      cost_price: o.cost_price, 
      payment_type: o.payment_type,
      payment_source: o.payment_source === 'bank' ? 'bank' : 'cash',
      bank_id: o.bank_id ?? null,
      notes: o.notes,
      receipt_image: o.receipt_image || null,
      old_product_id: o.product_id,
      old_quantity: o.quantity,
      old_supplier_id: o.supplier_id,
      batch_id: o.batch_id ?? null,
      // Read off the row's LEFT JOIN rather than looked up again, so the field
      // shows exactly what the Batch No. column beside it shows.
      batch_code: o.batch_code || ''
    }; 
    this.cdr.detectChanges();
  }
  
  cancelEdit() { 
    this.editingId = null; 
    this.cdr.detectChanges();
  }

  async saveEdit(id: number) {
    const existing = this.orders.find(o => o.purchase_id === id);
    if (!existing) return;

    // Required on the edit for the same reason it is required on the save:
    // clearing it here would delete the supplier's ledger row and leave the
    // order owing nothing to anyone.
    if (!Number(this.editForm.supplier_id)) {
      this.errorMessage = 'Choose the supplier this stock came from.';
      this.cdr.detectChanges();
      return;
    }

    const bankErr = this.bankErrorFor(this.editForm);
    if (bankErr) {
      this.errorMessage = bankErr;
      this.cdr.detectChanges();
      return;
    }

    try {
      // One transaction for the whole edit: the batch adjustment, the order
      // row and the supplier-ledger change either all land together or none
      // of them do. A failure part way through used to leave stock already
      // adjusted for the new quantity while the order row still showed the
      // old one, or a ledger entry that didn't match either.
      await this.db.transaction(async () => {
        const oldSupplierId = existing.supplier_id;
        const newSupplierId = this.editForm.supplier_id;
        const newTotal = this.editForm.quantity * this.editForm.cost_price;
        const paymentType = this.editForm.payment_type || 'credit';
        const isPaid = paymentType?.toLowerCase() === 'cash';

        let linkedBatchId: number | null = this.editForm.batch_id ?? null;
        const productChanged = Number(this.editForm.product_id) !== Number(existing.product_id);

        if (productChanged) {
          // The old linked batch belongs to the old product — remove this order's
          // stock from it, then create a fresh batch for the new product.
          if (linkedBatchId) {
            await this.adjustLinkedBatch(linkedBatchId, -Number(existing.quantity), existing.product_id);
          } else {
            await this.deductFromBatches(existing.product_id, Number(existing.quantity));
          }
          const newBatchResult = await this.updateInventoryWithBatch(
            this.editForm.product_id, this.editForm.quantity, this.editForm.cost_price, this.editForm.batch_code);
          linkedBatchId = newBatchResult.batch_id ?? null;
        } else {
          const diff = Number(this.editForm.quantity) - Number(existing.quantity);

          if (linkedBatchId) {
            // Keep the linked batch's cost AND its number in sync with this
            // order, then apply the quantity delta directly to it instead of
            // guessing via FIFO. The number is part of the same row and the
            // client corrects a mistyped one here.
            this.assertOk(await this.db.updateBatch(linkedBatchId, {
              purchase_price: this.editForm.cost_price,
              ...((this.editForm.batch_code || '').trim()
                  ? { batch_code: (this.editForm.batch_code || '').trim() }
                  : {})
            }), 'Updating the linked batch cost failed');
            if (diff !== 0) {
              await this.adjustLinkedBatch(linkedBatchId, diff, this.editForm.product_id);
            }
          } else {
            // Legacy order with no linked batch — fall back to the old FIFO behavior.
            if (diff > 0) {
              const newBatchResult = await this.updateInventoryWithBatch(
                this.editForm.product_id, diff, this.editForm.cost_price, this.editForm.batch_code);
              linkedBatchId = newBatchResult.batch_id ?? null;
            } else if (diff < 0) {
              await this.deductFromBatches(this.editForm.product_id, Math.abs(diff));
            }
          }
        }

        // The withdrawal is reversed and re-posted rather than patched, which
        // is one shape for every transition this form allows: a changed amount
        // (the net movement is the difference), a changed date, cash to bank,
        // bank to cash, bank A to bank B - and Paid to Unpaid, which reverses
        // it and writes nothing, because an unpaid order has taken no money
        // out of any account.
        const bank = this.bankFieldsFor({ ...this.editForm, payment_type: paymentType });
        const update: DbBatchOp = {
          sql: 'UPDATE purchase_orders SET supplier_id=?, product_id=?, date=?, quantity=?, cost_price=?, total_amount=?, payment_type=?, payment_source=?, bank_id=?, notes=?, batch_id=?, receipt_image=? WHERE purchase_id=?',
          params: [newSupplierId, this.editForm.product_id, this.editForm.date, this.editForm.quantity, this.editForm.cost_price, newTotal, paymentType, bank.payment_source, bank.bank_id, this.editForm.notes, linkedBatchId, this.editForm.receipt_image || null, id]
        };
        this.assertOk(
          await this.db.saveBankSourceEdit('purchase_orders', id, update, {
            ...bank,
            date: this.editForm.date,
            description: this.withdrawalLabel(this.editForm, id),
            amount: newTotal
          }),
          'Saving the purchase order failed');

        if (oldSupplierId !== newSupplierId) {
          if (oldSupplierId) {
            await this.mustRun('DELETE FROM supplier_ledger WHERE reference_id = ? AND reference_type = ?', [id, 'purchase']);
          }
          if (newSupplierId) {
            this.assertOk(await this.db.addSupplierLedgerEntry({
              supplier_id: newSupplierId,
              transaction_date: toLocalDateString(),
              description: `Purchase Order #${id}${this.editForm.notes ? ' - ' + this.editForm.notes : ''}`,
              debit: isPaid ? newTotal : 0,
              credit: newTotal,
              reference_type: 'purchase',
              reference_id: id
            }), 'Failed to update supplier ledger');
          }
        } else if (newSupplierId) {
          await this.mustRun(
            'UPDATE supplier_ledger SET debit = ?, credit = ? WHERE reference_id = ? AND reference_type = ?',
            [isPaid ? newTotal : 0, newTotal, id, 'purchase']
          );
        }
      });

      // Committed.
      this.editingId = null;
      await this.loadData();

    } catch (error: any) {
      // The transaction rolled back — nothing at all was written.
      console.error('❌ Error saving edit:', error);
      this.errorMessage = 'Error saving edit: ' + (error?.message || error);
      this.cdr.detectChanges();
    }
  }

  

  async deductFromBatches(productId: number, quantity: number) {
    const batchesResult = this.assertOk(
      await this.db.getBatchesByProduct(productId, this.currentFarm.farm_id),
      'Could not read the stock batches for this product'
    );

    const activeBatches = (batchesResult.data || [])
      .filter((b: any) => (b.calculated_status === 'active' || b.calculated_status === 'expiring') && b.quantity > 0)
      .sort((a: any, b: any) => a.expiry_date.localeCompare(b.expiry_date));

    let remaining = quantity;

    for (const batch of activeBatches) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, batch.quantity);
      const newQty = batch.quantity - deduct;

      this.assertOk(await this.db.updateBatch(batch.batch_id, { quantity: newQty }), 'Deducting stock from a batch failed');
      this.assertOk(await this.db.addBatchTransaction(
        batch.batch_id,
        productId,
        'adjustment',
        deduct,
        toLocalDateString(),
        null,
        `Adjustment from purchase order edit (-${deduct})`
      ), 'Recording the stock adjustment failed');

      remaining -= deduct;
    }

    this.assertOk(await this.db.updateBatchStatuses(), 'Updating the batch statuses failed');
  }

  /**
   * Adjusts a specific batch's quantity by `delta` (positive to add stock,
   * negative to remove). Floors at 0 so it can never go negative even if
   * other sales have already consumed part of this batch. Returns the
   * amount actually applied (may differ from `delta` if floored). Throws on
   * failure — callers run inside a `db.transaction`.
   */
  async adjustLinkedBatch(batchId: number, delta: number, productId: number): Promise<{ success: boolean; appliedDelta: number }> {
    const r = this.assertOk(await this.db.get('SELECT * FROM product_batches WHERE batch_id = ?', [batchId]), 'Could not read the linked batch');
    const batch = r.data && r.data.length > 0 ? r.data[0] : null;
    if (!batch) {
      throw new Error(`Linked batch ${batchId} no longer exists`);
    }

    const newQty = Math.max(0, Number(batch.quantity) + delta);
    const appliedDelta = newQty - Number(batch.quantity);

    this.assertOk(await this.db.updateBatch(batchId, { quantity: newQty }), 'Adjusting the linked batch quantity failed');

    if (appliedDelta !== 0) {
      this.assertOk(await this.db.addBatchTransaction(
        batchId,
        productId,
        'adjustment',
        Math.abs(appliedDelta),
        toLocalDateString(),
        null,
        `Adjustment from purchase order edit (${appliedDelta > 0 ? '+' : ''}${appliedDelta})`
      ), 'Recording the batch adjustment failed');
    }

    this.assertOk(await this.db.updateBatchStatuses(), 'Updating the batch statuses failed');
    return { success: true, appliedDelta };
  }



  confirmDelete(id: number) {
    this.deletingId = id;
    this.showDeleteCodeDialog = true;
    this.cdr.detectChanges();
  }

  onDeleteCodeVerified() {
    this.showDeleteCodeDialog = false;
    this.showDeleteDialog = true;
    this.cdr.detectChanges();
  }

  onDeleteCodeCancelled() {
    this.showDeleteCodeDialog = false;
    this.deletingId = null;
    this.cdr.detectChanges();
  }

  async onDeleteConfirmed() {
    try {
      // One transaction: the supplier-ledger removal, the stock reversal and
      // the order delete either all land together or none of them do. A
      // failure part way through used to leave stock un-reversed for an
      // order row that no longer existed.
      await this.db.transaction(async () => {
        const order = this.orders.find(o => o.purchase_id === this.deletingId);
        if (order) {
          if (order.supplier_id) {
            await this.removeFromSupplierLedger(this.deletingId!, order.supplier_id);
          }
          if (order.batch_id) {
            await this.adjustLinkedBatch(order.batch_id, -Number(order.quantity), order.product_id);
          } else {
            // Legacy order with no linked batch — fall back to old FIFO behavior.
            await this.deductFromBatches(order.product_id, order.quantity);
          }
        }
        // If it was paid by bank, the withdrawal goes with it and the account
        // is rebuilt in the same batch. The money never left.
        this.assertOk(
          await this.db.deleteBankSourced('purchase_orders', this.deletingId!, [
            { sql: 'DELETE FROM purchase_orders WHERE purchase_id=?', params: [this.deletingId] }
          ]),
          'Deleting the purchase order failed');
      });

      // Committed.
      this.showDeleteDialog = false;
      await this.loadData();

    } catch (error: any) {
      // The transaction rolled back — nothing at all was written.
      console.error('❌ Error deleting:', error);
      this.errorMessage = 'Error deleting: ' + (error?.message || error);
      this.cdr.detectChanges();
    }
  }
  
  onDeleteCancelled() { 
    this.showDeleteDialog = false; 
    this.cdr.detectChanges();
  }
}