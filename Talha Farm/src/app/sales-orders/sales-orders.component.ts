import { Component, OnInit, ChangeDetectorRef, HostListener, OnDestroy, ViewChild, ViewChildren, QueryList, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FormStateService } from '../shared/services/form-state.service';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles, getTableRightEdge } from '../shared/utils/pdf-table.util';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { distributionBillsOnly } from '../shared/utils/bill-source.util';
import { bankOptionLabel } from '../shared/utils/bank-source.util';
/**
 * Unwinds a bill save or delete that has already told the user why it stopped —
 * a bank movement that could not be applied, for example. The transaction rolls
 * back like any other failure, but the specific message survives instead of
 * being overwritten with a generic one.
 */
class BillWriteAborted extends Error {}

/**
 * Placeholder for "this bill was paid out of the customer's deposit, but the
 * row does not say which account" — the shape of every bank bill written
 * before `bills.bank_id` existed. It is replaced with the real account as soon
 * as the customer's link has been read, and never reaches the dropdown or a
 * save.
 */
const RESOLVE_DEPOSIT_ACCOUNT = 'customer:?';

/**
 * What a bill stores about where its payment landed: the normalized
 * `payment_source` / `bank_id` pair every money table in this app carries, plus
 * the one column only a bill needs — WHICH KIND of account it was.
 *
 * Named rather than written inline on the return type, for the same reason
 * `BankCascadeReversal` in database.service.ts is: the verify scripts lift
 * method bodies out of these files as text and find a body by its first brace,
 * which an inline object return type would be.
 */
interface BillPaymentFields {
  payment_source: string;
  bank_id: number | null;
  payment_account_kind: string | null;
}

@Component({
  selector: 'app-sales-orders',
  standalone: true,
  imports: [CommonModule, FormsModule, DateOnlyPipe, ConfirmDialogComponent, PaginationComponent, DeleteCodeDialogComponent],
  templateUrl: './sales-orders.component.html',
  styleUrl: './sales-orders.component.scss'
})
export class SalesOrdersComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  products: any[] = [];
  customers: any[] = [];

  viewMode: 'list' | 'create' | 'edit' = 'list';
  allBills: any[] = [];
  filteredBills: any[] = [];
  billSearchTerm: string = '';
  isEditMode: boolean = false;
  editingBillId: number | null = null;
  showDeleteDialog: boolean = false;
  showDeleteCodeDialog: boolean = false;
  deletingBillId: number | null = null;
  errorMessage: string = '';
  isLoading: boolean = true;

  currentPage = 1;
  pageSize = 10;

  get paginatedBills() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredBills.slice(start, start + this.pageSize);
  }

  gridItems: any[] = [];
  productSearchTerm: string = '';
  productOptions: any[] = [];
  showProductDropdown: boolean = false;
  highlightedIndex: number = -1;

  @ViewChild('productSearchInput') productSearchInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('paidAmountInput') paidAmountInputRef!: ElementRef<HTMLInputElement>;
  @ViewChildren('qtyInput') qtyInputs!: QueryList<ElementRef<HTMLInputElement>>;

  customerType: 'walkin' | 'regular' | 'internal' = 'walkin';
  selectedCustomerId: number | null = null;
  selectedCustomer: any = null;

  internalTargetModule: string = 'broiler';
  internalTargetFlockId: number | null = null;
  internalFlocks: any[] = [];

  /**
   * DERIVED from `receivedInto`, never assigned.
   *
   * It used to be its own field, set in nine places alongside the pieces of
   * bank state it was supposed to agree with. With a second kind of account to
   * choose from there is no longer any assignment that is right in all of them,
   * so there is nothing to assign: cash is cash and either kind of account is
   * 'bank', which is also exactly what the saved `payment_type` means.
   */
  get paymentMethod(): 'cash' | 'bank' {
    return this.receivedInto === 'cash' ? 'cash' : 'bank';
  }
  customerHasBank: boolean = false;
  customerBankBalance: number = 0;
  customerBankId: number | null = null;

  /**
   * "Received Into": 'cash', or `house:<bank_id>`, or `customer:<bank_id>`.
   *
   * One control for both kinds of account, because the client confirmed both
   * cases happen and a single dropdown is the only place a user would look.
   * The two write paths behind it are NOT the same, though, which is why the
   * kind travels in the value and is stored on the bill:
   *
   *   house     the owner's own account. Money IN — a deposit on that account,
   *             keyed to this bill (`billHouseReceiptOps`).
   *   customer  the deposit this customer already holds with the farm. Money
   *             OUT of the customer's account, in the shape this screen has
   *             always written it (`applyBankPaymentChange` →
   *             `deductCustomerBank`), untouched by this change.
   *
   * `paymentMethod` stays as the cash/bank flag the rest of this component and
   * the saved `payment_type` already read; it is derived from this, never set
   * independently.
   */
  receivedInto: string = 'cash';
  /** The owner's own accounts. Never a customer's — see getHouseBankAccounts(). */
  houseBanks: any[] = [];

  /**
   * How one house account reads in the dropdown: bank name plus the account's
   * title. Shared with every other bank picker — see bank-source.util.ts.
   */
  bankOptionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }

  paidAmount: number = 0;
  isSubmitting: boolean = false;
  private lastCartSubtotal: number = 0;
  /**
   * The user has deliberately said this bill is not (fully) paid — by pressing
   * Unpaid, by typing 0, or by opening an unpaid bill to edit.
   *
   * `syncPaidAmountWithTotal()` auto-fills the paid amount to the cart total
   * whenever it currently reads 0, which is a convenience on a fresh bill but
   * silently re-marked a bill Paid the moment anything else changed after the
   * Unpaid button was pressed. This flag suppresses that one auto-fill; the
   * "keep it in step while it matches the total" behaviour is untouched.
   */
  private explicitUnpaid: boolean = false;

  // ── STATE PERSISTENCY KEYS ────────────────────────────────
  private readonly FORM_KEY = 'sales_orders_form_state';
  private saveTimeout: any = null;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private formState: FormStateService
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadData();
  }

  ngOnDestroy() {
    if (this.viewMode !== 'list' && !this.isSubmitting) {
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
      if (this.viewMode !== 'list') {
        const state = {
          viewMode: this.viewMode,
          gridItems: this.gridItems,
          customerType: this.customerType,
          selectedCustomerId: this.selectedCustomerId,
          paidAmount: this.paidAmount,
          explicitUnpaid: this.explicitUnpaid,
          receivedInto: this.receivedInto,
          customerHasBank: this.customerHasBank,
          customerBankBalance: this.customerBankBalance,
          customerBankId: this.customerBankId,
          internalTargetModule: this.internalTargetModule,
          internalTargetFlockId: this.internalTargetFlockId,
          productSearchTerm: this.productSearchTerm,
          isEditMode: this.isEditMode,
          editingBillId: this.editingBillId,
          currentPage: this.currentPage,
          billSearchTerm: this.billSearchTerm
        };
        this.formState.saveState(this.FORM_KEY, state);
        console.log('💾 Sales orders state auto-saved');
      } else {
        this.formState.clearState(this.FORM_KEY);
      }
    }, 500);
  }

  private restoreState(): void {
    const state = this.formState.getState(this.FORM_KEY);
    if (state && state.viewMode && state.viewMode !== 'list') {
      console.log('📂 Restoring Sales Orders form state:', state);
      this.viewMode = state.viewMode;
      this.gridItems = state.gridItems || [];
      this.customerType = state.customerType || 'walkin';
      this.selectedCustomerId = state.selectedCustomerId || null;
      this.paidAmount = state.paidAmount || 0;
      this.explicitUnpaid = state.explicitUnpaid === true;
      // `receivedInto` replaced `paymentMethod` as the stored choice. A state
      // saved by the previous version has only the latter, and the only account
      // it could have meant is the customer's own deposit — that was the one
      // bank axis a bill had — so it restores as that rather than silently
      // reverting a half-finished bill to cash.
      this.receivedInto = state.receivedInto
        || (state.paymentMethod === 'bank' && state.customerBankId
              ? `customer:${state.customerBankId}`
              : 'cash');
      this.customerHasBank = state.customerHasBank || false;
      this.customerBankBalance = state.customerBankBalance || 0;
      this.customerBankId = state.customerBankId || null;
      this.internalTargetModule = state.internalTargetModule || 'broiler';
      this.internalTargetFlockId = state.internalTargetFlockId || null;
      this.productSearchTerm = state.productSearchTerm || '';
      this.isEditMode = state.isEditMode || false;
      this.editingBillId = state.editingBillId || null;
      this.currentPage = state.currentPage || 1;
      this.billSearchTerm = state.billSearchTerm || '';
      
      if (this.customerType === 'internal') {
        this.loadInternalTargets();
      }
      if (this.selectedCustomerId) {
        this.checkCustomerBank(this.selectedCustomerId);
      }
      
      if (this.isEditMode && this.editingBillId) {
        this.loadBillItemsForEdit(this.editingBillId);
      }
      
      // Apply search if there's a search term
      if (this.billSearchTerm) {
        this.applySearch();
      }
      
      this.cdr.detectChanges();
    }
  }

  private async loadBillItemsForEdit(billId: number) {
    try {
      const items = await this.db.get('SELECT * FROM bill_items WHERE bill_id=?', [billId]);
      if (items.success && items.data) {
        this.gridItems = items.data.map((i: any) => ({
          productId: i.product_id,
          productName: i.product_name,
          quantity: i.quantity,
          unitPrice: i.unit_price,
          totalPrice: i.total_price,
          itemId: i.item_id
        }));
      }
    } catch (error) {
      console.error('Error loading bill items for edit:', error);
    }
  }

  onFormChange(): void {
    if (this.viewMode !== 'list') {
      this.saveState();
    }
  }

  async loadData() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      const pr = await this.db.get('SELECT * FROM products WHERE farm_id=?', [this.currentFarm.farm_id]);
      this.products = pr.success ? pr.data : [];
      
      for (const product of this.products) {
        const totalStock = await this.db.getTotalStock(product.product_id);
        product.calculated_stock = totalStock;
      }
      
      // Own-farm customers are excluded here on purpose: they are the owner's
      // own farms, reachable only through the "Own Farm" customer type, which
      // resolves them from the target flock/batch. Offering one in the Regular
      // dropdown would let a farm be billed as though it were an outside
      // customer, with none of the internal-transfer cost or elimination.
      const cr = await this.db.get(
        `SELECT * FROM customers WHERE farm_id=? AND COALESCE(customer_type,'external') <> 'own_farm'`,
        [this.currentFarm.farm_id]
      );
      this.customers = cr.success ? cr.data : [];

      // The owner's OWN accounts only. getBankAccounts() unscoped would also
      // return every customer's deposit account, and a customer's money is not
      // somewhere this farm's receipts may be banked — the deposit accounts are
      // loaded separately, per customer, by checkCustomerBank().
      const hb = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
      this.houseBanks = hb.success ? hb.data : [];

      await this.loadBills();
      this.restoreState();
      this.cdr.detectChanges();
    } catch (error: any) {
      this.errorMessage = 'Failed to load data: ' + error.message;
      console.error('Load error:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadBills() {
    // This screen's own bills only. A layer sale's receivable is a `bills`
    // row as well, but it has no bill_items, no stock movement and nothing to
    // print here — and this screen's edit path would rewrite it as a
    // distribution bill, taking the layer sale's debt with it.
    const br = await this.db.get(
      `SELECT * FROM bills WHERE farm_id=? AND ${distributionBillsOnly()} ORDER BY bill_date DESC`,
      [this.currentFarm.farm_id]);
    this.allBills = br.success ? br.data : [];
    this.filteredBills = [...this.allBills];
    
    // If there's a search term, apply it
    if (this.billSearchTerm) {
      this.applySearch();
    }
  }

  // ── SEARCH METHODS (FIXED) ─────────────────────────────────

  onBillSearch() {
    setTimeout(() => {
      this.applySearch();
    }, 0);
  }

  private applySearch() {
    const term = this.billSearchTerm?.toLowerCase().trim() || '';
    
    if (!term) {
      this.filteredBills = [...this.allBills];
      this.currentPage = 1;
      this.cdr.detectChanges();
      this.onFormChange();
      return;
    }
    
    this.filteredBills = this.allBills.filter(bill => {
      const billNumber = (bill.bill_number || '').toLowerCase();
      const customerName = (bill.customer_name || '').toLowerCase();
      const customerId = bill.customer_id ? String(bill.customer_id) : '';
      const billId = bill.bill_id ? String(bill.bill_id) : '';
      
      return billNumber.includes(term) || 
             customerName.includes(term) ||
             customerId.includes(term) ||
             billId.includes(term);
    });
    
    this.currentPage = 1;
    this.cdr.detectChanges();
    this.onFormChange();
    
    console.log(`🔍 Search term: "${term}", Found: ${this.filteredBills.length} bills`);
  }

  clearSearch() {
    this.billSearchTerm = '';
    this.filteredBills = [...this.allBills];
    this.currentPage = 1;
    this.cdr.detectChanges();
    this.onFormChange();
  }

  // ── END SEARCH METHODS ─────────────────────────────────────

  onCreateNewBill() {
    this.resetForm();
    this.viewMode = 'create';
    this.isEditMode = false;
    this.editingBillId = null;
    this.errorMessage = '';
    this.receivedInto = 'cash';
    this.lastCartSubtotal = 0;
    this.onFormChange();
  }

  async selectBill(bill: any) {
    this.viewMode = 'edit';
    this.isEditMode = true;
    this.editingBillId = bill.bill_id;
    this.errorMessage = '';
    this.lastCartSubtotal = bill.total_amount || 0;
    // Restored from the bill's own columns rather than inferred from
    // payment_type, which reads 'bank' for both kinds of account. A legacy bank
    // bill has no kind stored and can only have been the customer's deposit,
    // and its account is whichever one that customer is linked to — read back
    // by checkCustomerBank() below.
    this.receivedInto =
      bill.payment_type !== 'bank' ? 'cash'
      : bill.payment_account_kind === 'house' && bill.bank_id ? `house:${bill.bank_id}`
      : bill.bank_id ? `customer:${bill.bank_id}`
      : RESOLVE_DEPOSIT_ACCOUNT;
    // Opening an unpaid bill to edit must not quietly settle it: without this,
    // the first quantity change would auto-fill the paid amount to the total.
    this.explicitUnpaid = (Number(bill.amount_paid) || 0) === 0;

    // ── FIX: Correctly restore customerType (internal must not map to walkin) ──
    if (bill.payment_type === 'internal') {
      this.customerType = 'internal';
      // selectedCustomerId stays null: the own-farm customer is not chosen from
      // the dropdown, it is re-resolved from the target flock/batch on save.
      this.selectedCustomerId = null;
      // What the farm has actually settled. This used to be hard-coded to 0
      // while the save path forced the bill fully paid, so the box and the
      // Paid/Unpaid badge contradicted each other on every internal bill.
      this.paidAmount = Number(bill.amount_paid) || 0;
      // Restore internal transfer targets from the stored internal_transfers record
      const transferRes = await this.db.get(
        'SELECT * FROM internal_transfers WHERE bill_id = ? LIMIT 1',
        [bill.bill_id]
      );
      if (transferRes.success && transferRes.data && transferRes.data.length > 0) {
        const t = transferRes.data[0];
        this.internalTargetModule = t.target_module || 'broiler';
        this.internalTargetFlockId = t.target_flock_id || null;
      } else {
        this.internalTargetModule = 'broiler';
        this.internalTargetFlockId = null;
      }
      await this.loadInternalTargets();
    } else if (bill.customer_id) {
      this.customerType = 'regular';
      this.selectedCustomerId = bill.customer_id;
      this.paidAmount = bill.amount_paid;
      await this.checkCustomerBank(this.selectedCustomerId, true);
      // A legacy bank bill stored no account at all. The one it drew on is
      // whichever account this customer is linked to, which is exactly what
      // checkCustomerBank() just read, so the placeholder is resolved here
      // rather than guessed above.
      if (this.receivedInto === RESOLVE_DEPOSIT_ACCOUNT) {
        this.receivedInto = this.customerBankId ? `customer:${this.customerBankId}` : 'cash';
      }
    } else {
      this.customerType = 'walkin';
      this.selectedCustomerId = null;
      this.paidAmount = bill.amount_paid;
      // No customer, so there is no deposit account to resolve the placeholder
      // against. Nothing today can write such a row — the old Bank button was
      // only offered on a regular customer — but a stored one reads as cash
      // rather than as an account that cannot be named.
      if (this.receivedInto === RESOLVE_DEPOSIT_ACCOUNT) this.receivedInto = 'cash';
    }

    const items = await this.db.get('SELECT * FROM bill_items WHERE bill_id=?', [bill.bill_id]);
    this.gridItems = items.success ? items.data.map((i: any) => ({
      productId: i.product_id,
      productName: i.product_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      totalPrice: i.total_price,
      itemId: i.item_id,
      batches: [],
      selectedBatchId: null
    })) : [];

    this.cdr.detectChanges();
    this.onFormChange();
  }

  backToList() { 
    this.resetForm(); 
    this.viewMode = 'list'; 
    this.errorMessage = ''; 
    this.receivedInto = 'cash'; 
    this.loadBills();
    this.formState.clearState(this.FORM_KEY);
    this.cdr.detectChanges();
  }

  resetForm() {
    this.gridItems = []; 
    this.productSearchTerm = ''; 
    this.productOptions = []; 
    this.showProductDropdown = false;
    this.customerType = 'walkin'; 
    this.selectedCustomerId = null;
    this.paidAmount = 0;
    this.explicitUnpaid = false;
    this.lastCartSubtotal = 0;
    this.isEditMode = false;
    this.editingBillId = null; 
    this.errorMessage = ''; 
    this.receivedInto = 'cash';
    this.customerHasBank = false; 
    this.customerBankBalance = 0; 
    this.customerBankId = null;
    this.internalTargetModule = 'broiler'; 
    this.internalTargetFlockId = null; 
    this.internalFlocks = [];
  }

  // ── CUSTOMER TYPE CHANGE ──────────────────────────────────

  async onCustomerTypeChange(type: string) {
    this.customerType = type as 'walkin' | 'regular' | 'internal';
    this.selectedCustomerId = null;
    
    if (type === 'internal') {
      await this.loadInternalTargets();
      // Own-farm sales default to UNPAID: distribution has supplied the goods
      // and the farm owes for them until it settles. The Paid/Unpaid buttons
      // work here exactly as they do for any other customer.
      this.paidAmount = 0;
      this.explicitUnpaid = true;
      this.lastCartSubtotal = this.cartSubtotal;
    } else if (type === 'walkin') {
      this.paidAmount = this.cartSubtotal; 
    } else { 
      this.paidAmount = this.cartSubtotal; 
    }
    
    this.cdr.detectChanges();
    this.onFormChange();
  }

  async loadInternalTargets() {
    if (this.internalTargetModule === 'broiler') {
      const flocks = await this.db.get('SELECT flock_id, flock_name FROM flocks WHERE farm_id=? AND status=?', [this.currentFarm.farm_id, 'active']);
      this.internalFlocks = flocks.success ? flocks.data : [];
    } else {
      const batches = await this.db.get('SELECT batch_id, batch_name FROM batches WHERE farm_id=? AND status=?', [this.currentFarm.farm_id, 'active']);
      this.internalFlocks = batches.success ? batches.data : [];
    }
    this.cdr.detectChanges();
  }

  async getAvailableStock(productId: number): Promise<number> { 
    return await this.db.getTotalStock(productId); 
  }

  // ── CUSTOMER BANK METHODS ──────────────────────────────────

  async checkCustomerBank(customerId: number | null, preserveDepositChoice: boolean = false) {
    if (!customerId) { 
      this.customerHasBank = false; 
      this.customerBankBalance = 0; 
      this.customerBankId = null; 
      this.dropCustomerDepositChoice();
      return; 
    }
    
    try {
      const result = await this.db.getCustomerBankAccount(customerId);
      if (result.success && result.data && result.data.length > 0) { 
        this.customerHasBank = true; 
        this.customerBankId = result.data[0].bank_id; 
        this.customerBankBalance = result.data[0].current_balance || 0; 
        if (!preserveDepositChoice) this.dropCustomerDepositChoice(); 
      } else { 
        this.customerHasBank = false; 
        this.customerBankBalance = 0; 
        this.customerBankId = null; 
        this.dropCustomerDepositChoice(); 
      }
    } catch (error) { 
      this.customerHasBank = false; 
      this.customerBankBalance = 0; 
      this.customerBankId = null; 
      this.dropCustomerDepositChoice(); 
    }
    
    this.cdr.detectChanges();
    this.onFormChange();
  }

  // ── "RECEIVED INTO" ───────────────────────────────────────
  //
  // One dropdown, two kinds of account, two different write paths behind it.
  // Everything that has to know which kind is in play reads it from here, so
  // the rule is written once.

  /** The kind of account the current choice names, or null for cash. */
  get receivedIntoKind(): 'house' | 'customer' | null {
    if (this.receivedInto.startsWith('house:')) return 'house';
    if (this.receivedInto.startsWith('customer:')) return 'customer';
    return null;
  }

  /** The account the current choice names, or null for cash. */
  get receivedIntoBankId(): number | null {
    const kind = this.receivedIntoKind;
    if (!kind) return null;
    return Number(this.receivedInto.split(':')[1]) || null;
  }

  /**
   * Forgets a customer-deposit choice while LEAVING a house choice alone.
   *
   * A deposit account belongs to the customer it was picked for, so changing
   * customer has to drop it. One of the owner's own accounts does not — the
   * money lands there whoever is buying — and wiping it on every customer
   * change would silently turn a banked receipt into a cash one.
   */
  private dropCustomerDepositChoice() {
    if (this.receivedIntoKind === 'customer') this.receivedInto = 'cash';
  }

  /**
   * What to store on the bill: the normalized `payment_source` / `bank_id`
   * pair every money table in this app carries, plus the one extra column a
   * bill needs — WHICH KIND of account it was, because payment_type reads
   * 'bank' for both and the edit and delete paths must be able to tell a house
   * receipt from a customer-deposit payment.
   *
   * An own-farm bill is never bankable here: it is settled on the Internal
   * Settlement screen, which has its own FROM and TO accounts, and a receipt
   * posted on the bill as well would record the same money twice.
   */
  private bankFieldsForBill(): BillPaymentFields {
    const kind = this.receivedIntoKind;
    const bankId = this.receivedIntoBankId;
    if (this.customerType === 'internal' || !kind || !bankId) {
      return { payment_source: 'cash', bank_id: null, payment_account_kind: null };
    }
    return { payment_source: 'bank', bank_id: bankId, payment_account_kind: kind };
  }

  /**
   * Is this SAVED bill's payment the customer-deposit axis?
   *
   * The legacy rule lives here and nowhere else: a row written before
   * `payment_account_kind` existed has it NULL, and `payment_type = 'bank'` on
   * such a row can only have meant the customer's deposit, because that was
   * the only bank axis a bill had. Read it any other way and the refund paths
   * either skip a deposit that really was deducted or credit one that never
   * was.
   */
  private isCustomerDepositBill(bill: any): boolean {
    if (!bill) return false;
    if (bill.payment_account_kind) return bill.payment_account_kind === 'customer';
    return bill.payment_type === 'bank';
  }

  /** The reason this bill cannot be saved yet, or ''. */
  private receivedIntoError(): string {
    const kind = this.receivedIntoKind;
    if (!kind) return '';
    if (!this.receivedIntoBankId) return 'Choose which account the money was received into.';
    if (kind === 'house') {
      if (!this.houseBanks.some(b => Number(b.bank_id) === this.receivedIntoBankId)) {
        return 'That account no longer exists — choose another.';
      }
      return '';
    }
    // A deposit choice is only ever offered for the selected customer's own
    // account, and `checkCustomerBank()` is what put it there. If the two have
    // come apart, the deduction would come out of an account the user did not
    // pick, so it is refused rather than guessed at.
    if (!this.selectedCustomerId || this.receivedIntoBankId !== Number(this.customerBankId)) {
      return 'That customer deposit account is no longer available — choose another.';
    }
    return '';
  }

  /** The selected regular customer's name, for the deposit-account option. */
  get selectedCustomerName(): string {
    const c = this.customers.find(x => x.customer_id === this.selectedCustomerId);
    return c ? (c.customer_name || 'Customer') : 'Customer';
  }

  /** How a saved bill's payment reads in the list. */
  billPaymentLabel(bill: any): string {
    if (bill?.payment_type === 'internal') return '🏠 Internal';
    if (bill?.payment_type !== 'bank') return '💰 Cash';
    return this.isCustomerDepositBill(bill) ? '🏦 Customer Deposit' : '🏦 Bank';
  }

  onCustomerSelect() { 
    this.checkCustomerBank(this.selectedCustomerId); 
    this.onFormChange();
  }

  async processBankPayment(customerId: number, amount: number, billNumber: string) {
    try { 
      const result = await this.db.deductCustomerBank(customerId, amount, `Payment - Bill #${billNumber}`); 
      if (result.success) return true; 
      this.errorMessage = 'Bank payment failed: ' + friendlySqlError(result.error, 'Unknown error');
      return false;
    } catch (error: any) { 
      this.errorMessage = 'Bank payment error: ' + error.message; 
      return false; 
    }
  }

  private async addCustomerBankCredit(customerId: number, amount: number, description: string): Promise<any> {
    const bankResult = await this.db.getCustomerBankAccount(customerId);
    if (!bankResult.success || !bankResult.data || bankResult.data.length === 0) {
      return { success: false, error: 'Customer has no bank account' };
    }

    return this.db.addBankLedgerEntry({
      bank_id: bankResult.data[0].bank_id,
      transaction_date: toLocalDateString(),
      description,
      debit: amount,
      credit: 0,
      reference_type: 'payment',
      reference_id: null
    });
  }

  private async applyBankPaymentChange(oldBill: any, newCustomerId: number | null, newBankPaid: number, billNumber: string): Promise<boolean> {
    // Only a bill that really drew on the customer's DEPOSIT has something to
    // give back here. Taken off `isCustomerDepositBill()` rather than
    // payment_type, which now also reads 'bank' for a receipt into one of the
    // owner's own accounts — reversing one of those on this path would credit a
    // refund into a customer's account the money never came out of.
    const wasDeposit = this.isCustomerDepositBill(oldBill);
    const oldCustomerId = wasDeposit ? oldBill.customer_id : null;
    const oldBankPaid = wasDeposit ? Number(oldBill.amount_paid || 0) : 0;
    const label = billNumber || oldBill?.bill_number || 'EDIT';

    if (oldCustomerId && oldCustomerId !== newCustomerId && oldBankPaid > 0) {
      const refund = await this.addCustomerBankCredit(oldCustomerId, oldBankPaid, `Refund - Bill #${label}`);
      if (!refund.success) {
        this.errorMessage = 'Bank refund failed: ' + friendlySqlError(refund.error, 'Unknown error');
        return false;
      }
    }

    if (!newCustomerId || newBankPaid <= 0) {
      if (oldCustomerId && oldCustomerId === newCustomerId && oldBankPaid > 0) {
        const refund = await this.addCustomerBankCredit(oldCustomerId, oldBankPaid, `Refund - Bill #${label}`);
        if (!refund.success) {
          this.errorMessage = 'Bank refund failed: ' + friendlySqlError(refund.error, 'Unknown error');
          return false;
        }
      }
      return true;
    }

    const delta = oldCustomerId === newCustomerId ? newBankPaid - oldBankPaid : newBankPaid;
    if (delta > 0) {
      const deductResult = await this.db.deductCustomerBank(newCustomerId, delta, `Payment - Bill #${label}`);
      if (!deductResult.success) {
        this.errorMessage = 'Bank payment failed: ' + friendlySqlError(deductResult.error, 'Unknown error');
        return false;
      }
    } else if (delta < 0) {
      const refund = await this.addCustomerBankCredit(newCustomerId, Math.abs(delta), `Refund - Bill #${label}`);
      if (!refund.success) {
        this.errorMessage = 'Bank refund failed: ' + friendlySqlError(refund.error, 'Unknown error');
        return false;
      }
    }

    return true;
  }

  createBankAccount() { 
    this.saveState();
    this.router.navigate(['/app/bank-ledger'], { queryParams: { customerId: this.selectedCustomerId } }); 
  }

  // ── PRODUCT SEARCH ────────────────────────────────────────

  onProductSearch() {
    const term = this.productSearchTerm.trim().toLowerCase();
    if (!term) { 
      this.productOptions = []; 
      this.showProductDropdown = false; 
      this.highlightedIndex = -1;
      return; 
    }
    
    this.productOptions = this.products.filter(p => 
      p.product_name.toLowerCase().includes(term) || 
      (p.category && p.category.toLowerCase().includes(term)) || 
      (p.unit && p.unit.toLowerCase().includes(term))
    );
    
    this.highlightedIndex = this.productOptions.length > 0 ? 0 : -1;
    this.showProductDropdown = true; 
    this.cdr.detectChanges();
    this.onFormChange();
  }

  onProductSearchKeydown(event: KeyboardEvent) {
    if (!this.showProductDropdown || this.productOptions.length === 0) {
      if (event.key === 'Tab') {
        event.preventDefault();
        this.focusPaidAmount();
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.highlightedIndex = Math.min(this.highlightedIndex + 1, this.productOptions.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.highlightedIndex = Math.max(this.highlightedIndex - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const index = this.highlightedIndex >= 0 ? this.highlightedIndex : 0;
      const product = this.productOptions[index];
      if (product) this.selectProductOption(product);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.focusPaidAmount();
    } else if (event.key === 'Escape') {
      this.showProductDropdown = false;
      this.highlightedIndex = -1;
    }
  }

  private focusPaidAmount() {
    this.showProductDropdown = false;
    setTimeout(() => {
      this.paidAmountInputRef?.nativeElement?.focus();
      this.paidAmountInputRef?.nativeElement?.select();
    }, 0);
  }

  private focusLastQtyInput() {
    setTimeout(() => {
      const inputs = this.qtyInputs?.toArray();
      if (inputs && inputs.length > 0) {
        const last = inputs[inputs.length - 1];
        last.nativeElement.focus();
        last.nativeElement.select();
      }
    }, 0);
  }

  onQtyKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      setTimeout(() => {
        this.productSearchInputRef?.nativeElement?.focus();
      }, 0);
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) { 
    if (!(event.target as HTMLElement).closest('.psearch-wrap')) { 
      this.showProductDropdown = false; 
      this.highlightedIndex = -1;
      this.cdr.detectChanges(); 
    } 
  }

  async selectProductOption(product: any) {
    const availableStock = await this.getAvailableStock(product.product_id);
    const existingForCheck = this.gridItems.find(i => i.productId === product.product_id);
    const alreadyInCart = existingForCheck ? existingForCheck.quantity : 0;

    if (availableStock <= 0) {
      this.errorMessage = `${product.product_name} is out of stock.`;
      this.showProductDropdown = false;
      this.cdr.detectChanges();
      return;
    }
    if (alreadyInCart + 1 > availableStock) {
      this.errorMessage = `${product.product_name} has only ${availableStock} in stock.`;
      this.showProductDropdown = false;
      this.cdr.detectChanges();
      return;
    }

    const previousTotal = this.cartSubtotal;
    const existing = this.gridItems.find(i => i.productId === product.product_id);
    if (existing) { 
      existing.quantity += 1; 
      existing.totalPrice = existing.quantity * existing.unitPrice; 
    } else { 
      const newItem: any = { 
        productId: product.product_id, 
        productName: product.product_name, 
        quantity: 1, 
        unitPrice: product.selling_price, 
        totalPrice: product.selling_price,
        batches: [],
        selectedBatchId: null
      };
      
      const batchesResult = await this.db.getBatchesByProduct(product.product_id, this.currentFarm.farm_id);
      if (batchesResult.success && batchesResult.data) {
        newItem.batches = batchesResult.data
          .filter((b: any) => (b.calculated_status === 'active' || b.calculated_status === 'expiring') && b.quantity > 0)
          .sort((a: any, b: any) => (a.expiry_date || '').localeCompare(b.expiry_date || ''));
          
        if (newItem.batches.length > 0) {
          newItem.selectedBatchId = newItem.batches[0].batch_id;
        }
      }
      
      this.gridItems.push(newItem); 
    }
    
    this.productSearchTerm = ''; 
    this.productOptions = []; 
    this.showProductDropdown = false;
    this.highlightedIndex = -1;
    this.syncPaidAmountWithTotal(previousTotal);
    this.errorMessage = ''; 
    this.cdr.detectChanges();
    this.onFormChange();
    this.focusLastQtyInput();
  }

  selectInputText(event: FocusEvent) {
    (event.target as HTMLInputElement).select();
  }

  recalcItem(item: any) {
    const previousTotal = this.cartSubtotal;
    if (item.quantity < 1) item.quantity = 1; 

    const product = this.products.find(p => p.product_id === item.productId);
    const maxStock = product ? (product.calculated_stock || 0) : null;
    if (maxStock !== null && item.quantity > maxStock) {
      item.quantity = maxStock > 0 ? maxStock : 1;
      this.errorMessage = `${item.productName} has only ${maxStock} in stock.`;
      this.cdr.detectChanges();
    }

    item.totalPrice = item.quantity * item.unitPrice; 
    this.syncPaidAmountWithTotal(previousTotal);
    this.onFormChange();
  }
  
  removeItem(item: any) { 
    const previousTotal = this.cartSubtotal;
    this.gridItems = this.gridItems.filter(i => i !== item); 
    this.syncPaidAmountWithTotal(previousTotal);
    this.onFormChange();
  }
  
  get cartSubtotal() { 
    return this.gridItems.reduce((s, i) => s + i.totalPrice, 0); 
  }
  
  onPaidAmountChange() {
    // Typing 0 by hand says the same thing the Unpaid button says.
    this.explicitUnpaid = (Number(this.paidAmount) || 0) === 0;
    this.lastCartSubtotal = this.cartSubtotal;
    this.onFormChange();
  }

  markPaid() {
    this.explicitUnpaid = false;
    this.paidAmount = this.cartSubtotal;
    this.lastCartSubtotal = this.cartSubtotal;
    this.onFormChange();
  }

  markUnpaid() {
    this.explicitUnpaid = true;
    this.paidAmount = 0;
    this.lastCartSubtotal = this.cartSubtotal;
    this.onFormChange();
  }

  private syncPaidAmountWithTotal(previousTotal: number = this.lastCartSubtotal) {
    const total = this.cartSubtotal;
    // The `paidAmount === 0` arm is skipped once the user has said the bill is
    // unpaid, or Unpaid would be undone by the next quantity change.
    if (this.paidAmount === previousTotal || (this.paidAmount === 0 && !this.explicitUnpaid)) {
      this.paidAmount = total;
    } else if (this.isEditMode && this.paidAmount === previousTotal) {
      this.paidAmount = total;
    }
    this.lastCartSubtotal = total;
  }

  async getNextBillNumber(): Promise<string> {
    const r = await this.db.get("SELECT COALESCE(MAX(CAST(SUBSTR(bill_number, 6) AS INTEGER)), 0) + 1 as next_number FROM bills WHERE farm_id=? AND bill_number LIKE 'BILL-%'", [this.currentFarm.farm_id]);
    return 'BILL-' + String((r.success && r.data[0] ? r.data[0].next_number : 1)).padStart(3, '0');
  }

  private async getBillItems(billId: number): Promise<any[]> { 
    const items = await this.db.get('SELECT * FROM bill_items WHERE bill_id=?', [billId]); 
    return items.success ? items.data : []; 
  }

  private async validateStockForBill(): Promise<boolean> {
    this.errorMessage = '';
    const existingItems = this.isEditMode && this.editingBillId ? await this.getBillItems(this.editingBillId) : [];
    
    for (const item of this.gridItems) {
      const availableStock = await this.getAvailableStock(item.productId);
      const existingQty = existingItems
        .filter((e: any) => Number(e.product_id) === Number(item.productId))
        .reduce((sum: number, e: any) => sum + Number(e.quantity || 0), 0);
      
      if (Number(item.quantity) > availableStock + existingQty) { 
        this.errorMessage = `${item.productName} has only ${availableStock + existingQty} in stock.`; 
        this.cdr.detectChanges(); 
        return false; 
      }
    }
    return true;
  }

  // ── TRANSACTIONAL WRITE HELPERS ───────────────────────────

  /**
   * db.run(), db.get() and the DatabaseService helpers report failures as
   * { success: false } instead of throwing, so a bad write inside a transaction
   * would otherwise pass unnoticed and get committed along with everything
   * else. Everything on the bill-save path goes through this.
   */
  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'unknown error')}`);
    }
    return result;
  }

  /** run() that aborts the enclosing transaction instead of failing quietly. */
  private async mustRun(sql: string, params: any[] = []): Promise<any> {
    return this.assertOk(await this.db.run(sql, params), 'Database write failed');
  }

  /** runBatch() that aborts the enclosing transaction if any statement fails. */
  private async mustRunBatch(ops: DbBatchOp[], what: string): Promise<any> {
    if (ops.length === 0) return { success: true, results: [] };
    return this.assertOk(await this.db.runBatch(ops), what);
  }

  // ── OWN-FARM CUSTOMER ─────────────────────────────────────

  /**
   * The `customers` row that stands for the farm this transfer is going to.
   *
   * Distribution is its own business and the owner's farms are its customers,
   * so an own-farm bill is billed to a real customer row and the farm carries
   * the debt in `customer_ledger` until it settles — the same machinery every
   * outside customer uses.
   *
   * Keyed on the FARM UNIT, not the flock or batch: flocks close and are
   * deleted, the farm that owes the money does not. `farm_units.unit_id` is
   * also the grain Overview's per-farm breakdown already reports on.
   *
   * A flock/batch with no `unit_id` (nothing creates one today — both
   * flock-management and batch-management require a farm — but legacy rows
   * predate the column) falls back to a single per-account customer with
   * `unit_id IS NULL`, matching what the migration does for the same case.
   *
   * Called from inside the bill transaction, so its reads see the insert it
   * just made and the whole thing rolls back with the rest on failure.
   */
  private async resolveOwnFarmCustomerId(): Promise<number> {
    const farmId = this.currentFarm.farm_id;

    const ownerRes = this.internalTargetModule === 'layer'
      ? await this.db.get('SELECT unit_id FROM batches WHERE batch_id=? AND farm_id=?', [this.internalTargetFlockId, farmId])
      : await this.db.get('SELECT unit_id FROM flocks WHERE flock_id=? AND farm_id=?', [this.internalTargetFlockId, farmId]);
    this.assertOk(ownerRes, 'Could not read the target farm for this transfer');
    const unitId = ownerRes.data.length > 0 && ownerRes.data[0].unit_id != null
      ? ownerRes.data[0].unit_id
      : null;

    const findSql = unitId == null
      ? `SELECT customer_id FROM customers WHERE farm_id=? AND customer_type='own_farm' AND unit_id IS NULL`
      : `SELECT customer_id FROM customers WHERE farm_id=? AND customer_type='own_farm' AND unit_id=?`;
    const findParams = unitId == null ? [farmId] : [farmId, unitId];

    const existing = this.assertOk(await this.db.get(findSql, findParams), 'Could not look up the own-farm customer');
    if (existing.data.length > 0) return existing.data[0].customer_id;

    let name = 'Own Farm (Unassigned)';
    if (unitId != null) {
      const unitRes = await this.db.get('SELECT unit_name FROM farm_units WHERE unit_id=?', [unitId]);
      this.assertOk(unitRes, 'Could not read the target farm name');
      // Plain hyphen, not an em dash: this name is printed into jsPDF's
      // helvetica, which has no glyph for one.
      if (unitRes.data.length > 0 && unitRes.data[0].unit_name) name = `Own Farm - ${unitRes.data[0].unit_name}`;
    }

    await this.mustRun(
      `INSERT INTO customers (farm_id, customer_name, unit_id, customer_type, outstanding_balance)
       VALUES (?, ?, ?, 'own_farm', 0)`,
      [farmId, name, unitId]
    );

    // Re-selected rather than trusting lastId, for the same reason the
    // migration does: sql.js's last_insert_rowid() has proved unreliable here.
    const created = this.assertOk(await this.db.get(findSql, findParams), 'Could not read back the own-farm customer');
    if (created.data.length === 0) throw new Error('The own-farm customer was created but could not be read back');
    return created.data[0].customer_id;
  }

  // ── CUSTOMER LEDGER ───────────────────────────────────────

  async addToCustomerLedger(customerId: number, billId: number, totalAmount: number, paidAmount: number, billNumber: string) {
    if (!customerId) return;

    this.assertOk(await this.db.addCustomerLedgerEntry({
      customer_id: customerId,
      transaction_date: toLocalDateString(),
      description: `Bill #${billNumber}`,
      debit: totalAmount,
      credit: 0,
      reference_type: 'bill',
      reference_id: billId
    }), 'Writing the customer ledger entry failed');

    if (paidAmount > 0) {
      this.assertOk(await this.db.addCustomerLedgerEntry({
        customer_id: customerId,
        transaction_date: toLocalDateString(),
        description: `Payment - Bill #${billNumber}`,
        debit: 0,
        credit: paidAmount,
        reference_type: 'payment',
        reference_id: billId
      }), 'Writing the customer payment entry failed');
    }

    this.assertOk(await this.db.updateCustomerOutstandingBalance(customerId), 'Updating the customer balance failed');
  }

  // strict is set by the bill-save path, where a failed write has to take the
  // whole transaction down. The delete path keeps the older lenient behaviour.
  async removeFromCustomerLedger(billId: number, customerId: number, strict: boolean = false) {
    if (!customerId) return;
    const check = (result: any, what: string) => { if (strict) this.assertOk(result, what); };
    check(await this.db.run('DELETE FROM customer_ledger WHERE reference_id = ? AND reference_type IN (?, ?)', [billId, 'bill', 'payment']), 'Clearing the old ledger entries failed');
    check(await this.db.updateCustomerOutstandingBalance(customerId), 'Updating the customer balance failed');
  }

  // ── STOCK OPERATIONS ──────────────────────────────────────

  private async restoreBillStock(billId: number, strict: boolean = false) {
    // strict is set by the bill-save path, where a failed restore has to take
    // the whole transaction down. The delete path keeps the older behaviour.
    const check = (result: any, what: string) => { if (strict) this.assertOk(result, what); };

    const existingItems = await this.getBillItems(billId);
    const today = toLocalDateString();

    // 🔥 FIX: compute the NET outstanding quantity per batch (sale − return)
    // for this bill, not the raw sum of every 'sale' transaction ever logged
    // against it. A bill edited more than once accumulates a 'sale' entry
    // and a 'return' entry on every edit — summing only 'sale' rows without
    // subtracting the matching 'return' rows causes stock that was already
    // restored in a previous edit to be restored AGAIN, inflating stock
    // with phantom units on every subsequent edit.
    const netResult = await this.db.get(
      `SELECT batch_id, product_id,
              SUM(CASE WHEN type = 'sale' THEN quantity WHEN type = 'return' THEN -quantity ELSE 0 END) as net_qty
       FROM batch_transactions
       WHERE reference_id = ? AND type IN ('sale', 'return')
       GROUP BY batch_id, product_id
       HAVING net_qty > 0`,
      [billId]
    );
    check(netResult, 'Could not read the batch history for this bill');
    const netRows = netResult.success && netResult.data ? netResult.data : [];

    if (netRows.length > 0) {
      for (const row of netRows) {
        if (!row.batch_id) continue;
        const batchResult = await this.db.get('SELECT * FROM product_batches WHERE batch_id = ?', [row.batch_id]);
        check(batchResult, 'Could not read the stock batch to restore');
        if (batchResult.success && batchResult.data && batchResult.data.length > 0) {
          const targetBatch = batchResult.data[0];
          check(await this.db.updateBatch(targetBatch.batch_id, { quantity: (targetBatch.quantity || 0) + row.net_qty }), 'Restoring stock failed');
          check(await this.db.addBatchTransaction(
            targetBatch.batch_id,
            row.product_id,
            'return',
            row.net_qty,
            today,
            billId,
            `Restored from deleted/edited sale`
          ), 'Logging the stock restore failed');
        }
      }
    } else {
      // Legacy bill with no tracked batch_transactions — fall back to
      // restoring against any available batch for each item.
      for (const item of existingItems) {
        if (!item.product_id) continue;

        const batchesResult = await this.db.getBatchesByProduct(item.product_id, this.currentFarm.farm_id);
        check(batchesResult, 'Could not read the stock batches to restore');
        let targetBatch = null;

        if (batchesResult.success && batchesResult.data && batchesResult.data.length > 0) {
          targetBatch = batchesResult.data.find((b: any) => b.calculated_status === 'active') || batchesResult.data[0];
        }

        if (targetBatch) {
          check(await this.db.updateBatch(targetBatch.batch_id, { quantity: (targetBatch.quantity || 0) + item.quantity }), 'Restoring stock failed');
          check(await this.db.addBatchTransaction(
            targetBatch.batch_id,
            item.product_id,
            'return',
            item.quantity,
            today,
            billId,
            `Restored from deleted/edited sale`
          ), 'Logging the stock restore failed');
        } else {
          const oneYearLater = new Date();
          oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
          const batchResult = await this.db.addBatch({
            product_id: item.product_id,
            farm_id: this.currentFarm.farm_id,
            manufacturing_date: today,
            expiry_date: toLocalDateString(oneYearLater),
            quantity: item.quantity,
            purchase_price: 0
          });
          check(batchResult, 'Creating a batch to restore stock into failed');
          if (batchResult.success && batchResult.batch_id) {
            check(await this.db.addBatchTransaction(
              batchResult.batch_id,
              item.product_id,
              'return',
              item.quantity,
              today,
              billId,
              `Restored from deleted/edited sale`
            ), 'Logging the stock restore failed');
          }
        }
      }
    }
  }

  private async cleanupInternalTransfers(billId: number, strict: boolean = false) {
    // strict is set by the bill-save path, where leaving a stale medicine/feed/
    // vaccination/expense row behind has to take the whole transaction down.
    // The delete path keeps the older log-and-continue behaviour.
    const check = (result: any, what: string) => { if (strict) this.assertOk(result, what); };

    try {
      const oldTransfers = await this.db.get('SELECT * FROM internal_transfers WHERE bill_id=?', [billId]);
      check(oldTransfers, 'Could not read the existing internal transfers');
      if (oldTransfers.success && oldTransfers.data) {
        for (const t of oldTransfers.data) {
          const targetType = t.target_type || (t.expense_id ? 'expense' : null);
          const refId = t.reference_id || t.expense_id;

          if (targetType === 'medicine' && refId) {
            check(await this.db.run('DELETE FROM medicine_entries WHERE entry_id=?', [refId]), 'Removing the old medicine entry failed');
          } else if (targetType === 'feed' && refId) {
            check(await this.db.run('DELETE FROM feed_entries WHERE entry_id=?', [refId]), 'Removing the old feed entry failed');
          } else if (targetType === 'chick' && refId) {
            check(await this.db.run('DELETE FROM chick_entries WHERE entry_id=?', [refId]), 'Removing the old chick entry failed');
          } else if (targetType === 'vaccination' && refId) {
            check(await this.db.run('DELETE FROM vaccinations WHERE vaccination_id=?', [refId]), 'Removing the old vaccination failed');
          } else if (t.expense_id) {
            check(await this.db.run('DELETE FROM expenses WHERE expense_id=?', [t.expense_id]), 'Removing the old expense failed');
          }
        }
      }
      check(await this.db.run('DELETE FROM internal_transfers WHERE bill_id=?', [billId]), 'Removing the old internal transfers failed');
    } catch (e) {
      if (strict) throw e;
      console.error('Error cleaning up internal transfers:', e);
    }
  }

  private async deductFromBatches(productId: number, quantity: number, selectedBatchId: number | null, billId?: number) {
    const batchesResult = await this.db.getBatchesByProduct(productId, this.currentFarm.farm_id);
    this.assertOk(batchesResult, 'Could not read the stock batches for this product');
    if (!batchesResult.data) return;

    let activeBatches = batchesResult.data
      .filter((b: any) => (b.calculated_status === 'active' || b.calculated_status === 'expiring') && b.quantity > 0)
      .sort((a: any, b: any) => (a.expiry_date || '').localeCompare(b.expiry_date || ''));

    if (selectedBatchId) {
      const selectedBatch = activeBatches.find((b: any) => b.batch_id === selectedBatchId);
      if (selectedBatch) {
        activeBatches = [selectedBatch, ...activeBatches.filter((b: any) => b.batch_id !== selectedBatchId)];
      }
    }

    // Unchanged FIFO walk — the difference is that the writes are collected and
    // sent as one atomic batch instead of a round trip (and a full rewrite of
    // the database file) per statement.
    const today = toLocalDateString();
    const ops: DbBatchOp[] = [];
    let remaining = quantity;

    for (const batch of activeBatches) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, batch.quantity || 0);
      ops.push({
        sql: 'UPDATE product_batches SET quantity = ? WHERE batch_id = ?',
        params: [(batch.quantity || 0) - deduct, batch.batch_id]
      });
      ops.push({
        sql: `INSERT INTO batch_transactions
       (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [batch.batch_id, productId, 'sale', deduct, today, billId || null, 'Sale order']
      });
      remaining -= deduct;
    }

    await this.mustRunBatch(ops, 'Deducting stock failed');
    this.assertOk(await this.db.updateBatchStatuses(), 'Updating the batch statuses failed');
  }

  // ── SAVE BILL ─────────────────────────────────────────────

  async saveBill(): Promise<number | null> {
    if (this.gridItems.length === 0 || this.isSubmitting) return null;

    if (this.customerType === 'internal' && !this.internalTargetFlockId) {
      this.errorMessage = 'Please select a target Flock/Batch.';
      this.cdr.detectChanges();
      return null;
    }

    // A bill that says it was received into an account but names none, or names
    // one that has gone, is refused rather than quietly saved as cash — the
    // same rule `bankSourceError()` enforces on every other money screen. A
    // bank payment that never reaches a bank account is the whole defect this
    // wiring exists to prevent.
    const receivedIntoError = this.receivedIntoError();
    if (receivedIntoError) {
      this.errorMessage = receivedIntoError;
      this.cdr.detectChanges();
      return null;
    }

    if (!(await this.validateStockForBill())) return null;
    this.isSubmitting = true;

    // For an own-farm bill this is replaced inside the transaction with the
    // resolved farm's own name, once the target flock/batch has been read.
    let customerName = this.customerType === 'internal' ? 'Own Farm' :
                       (this.customerType === 'regular' ?
                         (this.customers.find(c => c.customer_id === this.selectedCustomerId)?.customer_name || 'Walk-in') :
                         'Walk-in');
    const oldBill = this.isEditMode && this.editingBillId
      ? this.allBills.find(b => b.bill_id === this.editingBillId)
      : null;
    const billNumber = this.isEditMode ? (oldBill?.bill_number || '') : await this.getNextBillNumber();
    const totalAmount = this.cartSubtotal;
    const clampPaidAmount = (amount: number) => Math.min(Math.max(Number(amount) || 0, 0), totalAmount);
    let savedBillId: number | null = null;

    try {
      // One transaction for the whole bill: the bank movement, the bill row, its
      // items, the stock deductions, the ledger entries and the internal
      // transfers either all land together or none of them do — and the database
      // file is written once, on commit, instead of once per statement. A failure
      // or a power cut part way through leaves the books exactly as they were.
      //
      // Reads inside here see the transaction's own uncommitted writes, so the
      // steps that depend on reading back what an earlier step wrote (restore
      // stock, then re-deduct it) still behave the way they always have.
      savedBillId = await this.db.transaction(async () => {
        // ── CALCULATE PAYMENTS ────────────────────────────────────

        let effectivePaid = 0;
        let bankDeductAmount = 0;
        let paymentType = 'cash';
        // Which customer the bill is billed to. For an own-farm sale this is
        // resolved from the target flock/batch rather than picked in the UI.
        let billCustomerId: number | null = this.selectedCustomerId;

        // Where the money was received, as the bill will store it. Computed
        // once, up here, because four things downstream read it: the bill's own
        // columns, the receipt posted onto a house account, the reversal of
        // whatever the bill said before, and the deposit path's own branch.
        const bankFields = this.bankFieldsForBill();
        const intoHouse = bankFields.payment_account_kind === 'house';
        const intoDeposit = bankFields.payment_account_kind === 'customer';

        if (this.customerType === 'internal') {
          paymentType = 'internal';
          // An own-farm sale is a real sale: distribution earns the revenue and
          // the farm owes for the goods until it settles, so amount_paid means
          // exactly what it means on any other bill and the Paid/Unpaid buttons
          // drive it. This used to be forced to totalAmount — a workaround for
          // internal bills having no receivable to settle against and so sitting
          // "Unpaid" forever, which also made the Unpaid button do nothing.
          effectivePaid = clampPaidAmount(this.paidAmount);

          billCustomerId = await this.resolveOwnFarmCustomerId();
          const nameRes = await this.db.get('SELECT customer_name FROM customers WHERE customer_id=?', [billCustomerId]);
          this.assertOk(nameRes, 'Could not read the own-farm customer name');
          if (nameRes.data.length > 0) customerName = nameRes.data[0].customer_name;

          if (this.isCustomerDepositBill(oldBill)) {
            const bankApplied = await this.applyBankPaymentChange(oldBill, oldBill.customer_id, 0, billNumber);
            if (!bankApplied) throw new BillWriteAborted(this.errorMessage);
          }
        } else if (intoDeposit && this.selectedCustomerId) {
          // THE EXISTING AXIS, unchanged. The customer is paying out of the
          // deposit they already hold with the farm, so money comes OUT of the
          // customer's own account — a credit on it, reference_type 'payment'
          // with a NULL reference_id, delta-adjusted on an edit. Nothing about
          // this shape changed; it only stopped being the only way to say
          // "bank".
          paymentType = 'bank';
          effectivePaid = clampPaidAmount(this.paidAmount);
          bankDeductAmount = effectivePaid;

          const bankApplied = await this.applyBankPaymentChange(oldBill, this.selectedCustomerId, effectivePaid, billNumber);
          if (!bankApplied) throw new BillWriteAborted(this.errorMessage);
        } else if (intoHouse) {
          // THE NEW AXIS. The customer paid into one of the owner's own
          // accounts, so this is a plain receipt: money IN, on a house account,
          // keyed to this bill. The entry itself is written at the end of the
          // transaction, once the bill has an id to key it to.
          //
          // A walk-in always pays in full, exactly as on the cash path below —
          // there is no receivable for it to be short against.
          paymentType = 'bank';
          effectivePaid = this.customerType === 'walkin' ? totalAmount : clampPaidAmount(this.paidAmount);

          // Whatever this bill said BEFORE could have been a deposit payment,
          // which has to be given back on the customer's account before the
          // receipt replaces it.
          if (this.isCustomerDepositBill(oldBill)) {
            const bankApplied = await this.applyBankPaymentChange(oldBill, oldBill.customer_id, 0, billNumber);
            if (!bankApplied) throw new BillWriteAborted(this.errorMessage);
          }
        } else {
          // A walk-in has no receivable to settle against, so it can never be
          // left partially paid — it always pays in full, regardless of what
          // the Amount Received field holds (which may exceed the total, to
          // compute change).
          effectivePaid = this.customerType === 'walkin' ? totalAmount : clampPaidAmount(this.paidAmount);
          paymentType = 'cash';

          if (this.isCustomerDepositBill(oldBill)) {
            const bankApplied = await this.applyBankPaymentChange(oldBill, this.selectedCustomerId, 0, billNumber);
            if (!bankApplied) throw new BillWriteAborted(this.errorMessage);
          }
        }

        console.log('📊 Payment Details:', {
          totalAmount,
          paidAmount: this.paidAmount,
          effectivePaid,
          bankDeductAmount,
          receivedInto: this.receivedInto,
          paymentType,
          paymentSource: bankFields.payment_source,
          bankId: bankFields.bank_id,
          accountKind: bankFields.payment_account_kind,
          customerId: billCustomerId
        });

        // NO HOUSE ACCOUNT MAY BE TAKEN BELOW ZERO. A new bill's receipt is
        // money IN and can never overdraw anything — an EDIT can, because the
        // save reverses whatever receipt the bill carried and posts the new
        // one: cutting a 900,000 receipt to 10,000 takes 890,000 back out, and
        // moving it to another account takes all of it. Both are netted by
        // checkBillHouseReceipt(), over the union of the two accounts.
        //
        // Weighed here, before a single row of this bill is written, so the
        // transaction has nothing to roll back. The customer-DEPOSIT axis is a
        // different mechanism on a different (customer's) account and is not
        // this guard's business — applyBankPaymentChange() owns it.
        const receiptGuard = await this.db.checkBillHouseReceipt({
          ...bankFields,
          billId: this.isEditMode ? this.editingBillId : null,
          amount: effectivePaid
        });
        if (!receiptGuard.success) {
          // BillWriteAborted rolls back without overwriting the message, so
          // the refusal has to be on screen before it is thrown.
          this.errorMessage = receiptGuard.error || 'Not enough balance in that account.';
          throw new BillWriteAborted(this.errorMessage);
        }

        // ── SAVE OR UPDATE BILL ───────────────────────────────────

        let billId: number | null;

        if (this.isEditMode && this.editingBillId) {
          billId = this.editingBillId;
          if (oldBill?.customer_id) await this.removeFromCustomerLedger(this.editingBillId, oldBill.customer_id, true);

          await this.cleanupInternalTransfers(this.editingBillId, true);

          await this.restoreBillStock(this.editingBillId, true);

          // The receipt this bill used to carry comes off BEFORE the row is
          // rewritten and before the new one is posted at the end. The account
          // it was on is read inside here, while the entry is still there to be
          // read — once it is gone nothing says which balance to rebuild.
          const oldReceipt = await this.db.billHouseReversalOps(this.editingBillId);
          this.assertOk(oldReceipt, 'Could not read the bank receipt on this bill');
          await this.mustRunBatch(oldReceipt.ops || [], 'Reversing the old bank receipt failed');

          await this.mustRun(
            `UPDATE bills SET customer_id=?, customer_name=?, subtotal=?, total_amount=?, amount_paid=?,
                              payment_type=?, payment_source=?, bank_id=?, payment_account_kind=?
             WHERE bill_id=?`,
            [billCustomerId, customerName, totalAmount, totalAmount, effectivePaid, paymentType,
             bankFields.payment_source, bankFields.bank_id, bankFields.payment_account_kind,
             this.editingBillId]
          );

          // The bill has just moved to a different customer — which an own-farm
          // bill does whenever its target flock/batch is changed to one on
          // another farm. removeFromCustomerLedger() above recomputed the OLD
          // customer's stored balance while this bill still pointed at them, so
          // it still counts this debt. Recompute it now the bill has moved, or
          // the farm that no longer owes the money goes on showing it.
          if (oldBill?.customer_id && oldBill.customer_id !== billCustomerId) {
            this.assertOk(
              await this.db.updateCustomerOutstandingBalance(oldBill.customer_id),
              'Updating the previous customer balance failed'
            );
          }

          await this.mustRun('DELETE FROM bill_items WHERE bill_id=?', [this.editingBillId]);
          for (const item of this.gridItems) {
            await this.mustRun(
              'INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?)',
              [this.editingBillId, item.productId, item.productName, item.quantity, item.unitPrice, item.totalPrice]
            );
            await this.deductFromBatches(item.productId, item.quantity, item.selectedBatchId, this.editingBillId);
          }

          if (billCustomerId) {
            await this.addToCustomerLedger(billCustomerId, this.editingBillId, totalAmount, effectivePaid, billNumber);
          }
        } else {
          await this.mustRun(
            `INSERT INTO bills (farm_id, bill_number, customer_id, customer_name, bill_date, subtotal,
                                total_amount, amount_paid, payment_type, payment_source, bank_id,
                                payment_account_kind)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [this.currentFarm.farm_id, billNumber, billCustomerId, customerName,
             toLocalDateString(), totalAmount, totalAmount, effectivePaid, paymentType,
             bankFields.payment_source, bankFields.bank_id, bankFields.payment_account_kind]
          );

          const lastBill = await this.db.get('SELECT MAX(bill_id) as bid FROM bills WHERE farm_id=?', [this.currentFarm.farm_id]);
          this.assertOk(lastBill, 'Could not read back the saved bill');
          billId = lastBill.data[0] ? lastBill.data[0].bid : null;

          // This used to fall through silently, leaving a bill row with no items,
          // no stock movement and no ledger entry. Now it takes the save down.
          if (!billId) throw new Error('The bill was saved but its id could not be read back');

          for (const item of this.gridItems) {
            await this.mustRun(
              'INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?)',
              [billId, item.productId, item.productName, item.quantity, item.unitPrice, item.totalPrice]
            );
            await this.deductFromBatches(item.productId, item.quantity, item.selectedBatchId, billId);
          }

          if (billCustomerId) {
            await this.addToCustomerLedger(billCustomerId, billId, totalAmount, effectivePaid, billNumber);
          }
        }

        // ── INTERNAL TRANSFER ──────────────────────────────────────

        if (this.customerType === 'internal' && billId && this.internalTargetFlockId) {
          for (const item of this.gridItems) {
            const billTag = billNumber ? ` (Bill #${billNumber})` : '';
            const desc = item.productName + ' × ' + item.quantity + billTag;
            const todayDate = toLocalDateString();

            const productRes = await this.db.get('SELECT category FROM products WHERE product_id=?', [item.productId]);
            this.assertOk(productRes, 'Could not read the product category');
            const category = (productRes.data.length > 0) ? (productRes.data[0].category || '').toLowerCase() : '';

            // The target-module row and the internal_transfers row that points at
            // it go over as one batch: { $lastId: -1 } stands in for the id the
            // previous statement produced, so no id has to make a round trip and
            // a half-written transfer can't survive a failure.
            const ops: DbBatchOp[] = [];
            let targetType = 'expense';
            let expenseIdRef: any = null;
            let referenceIdRef: any = null;

            if (category === 'medicine') {
              targetType = 'medicine';
              const traderRes = await this.db.get('SELECT trader_id FROM medicine_traders WHERE flock_id=? AND module_type=? AND trader_name=?', [this.internalTargetFlockId, this.internalTargetModule, 'Internal Distribution']);
              this.assertOk(traderRes, 'Could not look up the internal distribution trader');

              let traderIdRef: any = traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
              if (traderIdRef === null) {
                ops.push({
                  sql: 'INSERT INTO medicine_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
                  params: [this.internalTargetFlockId, 'Internal Distribution', this.internalTargetModule]
                });
                traderIdRef = { $lastId: -1 };
              }

              ops.push({
                sql: 'INSERT INTO medicine_entries (trader_id, flock_id, date, medicine_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
                params: [traderIdRef, this.internalTargetFlockId, todayDate, item.productName + billTag, item.quantity, item.unitPrice, item.totalPrice, this.internalTargetModule, billId, billNumber]
              });
              referenceIdRef = { $lastId: -1 };
            } else if (category === 'feed') {
              targetType = 'feed';
              const traderRes = await this.db.get('SELECT trader_id FROM feed_traders WHERE flock_id=? AND module_type=? AND trader_name=?', [this.internalTargetFlockId, this.internalTargetModule, 'Internal Distribution']);
              this.assertOk(traderRes, 'Could not look up the internal distribution trader');

              let traderIdRef: any = traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
              if (traderIdRef === null) {
                ops.push({
                  sql: 'INSERT INTO feed_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
                  params: [this.internalTargetFlockId, 'Internal Distribution', this.internalTargetModule]
                });
                traderIdRef = { $lastId: -1 };
              }

              ops.push({
                sql: 'INSERT INTO feed_entries (trader_id, flock_id, date, feed_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
                params: [traderIdRef, this.internalTargetFlockId, todayDate, item.productName + billTag, item.quantity, item.unitPrice, item.totalPrice, this.internalTargetModule, billId, billNumber]
              });
              referenceIdRef = { $lastId: -1 };
            } else if (category === 'chick' || category === 'chicks') {
              // Chicks go to the broiler Chicks screen, the same way feed and
              // medicine reach theirs: an 'Internal Distribution' supplier is
              // created once per flock/batch and every transfer lands under it.
              targetType = 'chick';
              const traderRes = await this.db.get('SELECT trader_id FROM chick_traders WHERE flock_id=? AND module_type=? AND trader_name=?', [this.internalTargetFlockId, this.internalTargetModule, 'Internal Distribution']);
              this.assertOk(traderRes, 'Could not look up the internal distribution supplier');

              let traderIdRef: any = traderRes.data.length > 0 ? traderRes.data[0].trader_id : null;
              if (traderIdRef === null) {
                ops.push({
                  sql: 'INSERT INTO chick_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)',
                  params: [this.internalTargetFlockId, 'Internal Distribution', this.internalTargetModule]
                });
                traderIdRef = { $lastId: -1 };
              }

              ops.push({
                sql: 'INSERT INTO chick_entries (trader_id, flock_id, date, chick_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
                params: [traderIdRef, this.internalTargetFlockId, todayDate, item.productName + billTag, item.quantity, item.unitPrice, item.totalPrice, this.internalTargetModule, billId, billNumber]
              });
              referenceIdRef = { $lastId: -1 };
            } else if (category === 'vaccine' || category === 'vaccination') {
              targetType = 'vaccination';
              ops.push({
                sql: 'INSERT INTO vaccinations (batch_id, flock_id, date, vaccine_name, dose, notes, cost, done, bill_id, bill_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
                params: [this.internalTargetModule === 'layer' ? this.internalTargetFlockId : null, this.internalTargetModule === 'broiler' ? this.internalTargetFlockId : null, todayDate, item.productName, String(item.quantity), 'Internal Transfer' + billTag, item.totalPrice, 1, billId, billNumber]
              });
              referenceIdRef = { $lastId: -1 };
            } else {
              targetType = 'expense';
              ops.push({
                sql: 'INSERT INTO expenses (flock_id, date, description, amount, module_type) VALUES (?,?,?,?,?)',
                params: [this.internalTargetFlockId, todayDate, desc, item.totalPrice, this.internalTargetModule]
              });
              expenseIdRef = { $lastId: -1 };
              referenceIdRef = { $lastId: -1 };
            }

            ops.push({
              sql: 'INSERT INTO internal_transfers (bill_id, expense_id, target_module, target_flock_id, target_type, reference_id) VALUES (?,?,?,?,?,?)',
              params: [billId, expenseIdRef, this.internalTargetModule, this.internalTargetFlockId, targetType, referenceIdRef]
            });

            await this.mustRunBatch(ops, `Internal transfer for ${item.productName} failed`);
          }
        }

        // ── THE BANK RECEIPT ───────────────────────────────────────
        //
        // Last, because it is keyed to the bill and the insert path only learns
        // the bill's id part way through. Still inside the same transaction, so
        // a receipt and the bill it belongs to cannot exist without each other.
        //
        // Returns no ops at all unless a HOUSE account was picked: cash writes
        // nothing, and the customer-deposit axis has already written its own
        // entry on the customer's account through applyBankPaymentChange().
        if (billId) {
          await this.mustRunBatch(
            this.db.billHouseReceiptOps({
              ...bankFields,
              billId,
              date: toLocalDateString(),
              description: `Bill #${billNumber} - ${customerName}`,
              amount: effectivePaid
            }),
            'Recording the bank receipt failed'
          );
        }

        return billId;
      });
    } catch (error: any) {
      // The transaction rolled back — nothing at all was written.
      if (!(error instanceof BillWriteAborted)) {
        this.errorMessage = 'Error saving: ' + (error?.message || error);
      }
      console.error('Save error:', error);
      this.isSubmitting = false;
      this.cdr.detectChanges();
      return null;
    }

    // Committed. A failure from here on is a screen-refresh problem, not a
    // failed save, and must not be reported as one.
    try {
      this.formState.clearState(this.FORM_KEY);
      this.resetForm();
      this.viewMode = 'list';
      await this.loadBills();
      await this.loadData();
    } catch (error: any) {
      console.error('The bill was saved, but refreshing the screen failed:', error);
    } finally {
      this.isSubmitting = false;
      this.cdr.detectChanges();
    }

    return savedBillId;
  }

  // ── DELETE METHODS (FIXED) ────────────────────────────────────

  confirmDeleteBill(event: Event, billId: number) { 
    event.stopPropagation();
    event.preventDefault();
    
    console.log('🗑️ Delete clicked for bill:', billId);
    
    this.deletingBillId = billId;
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
    this.deletingBillId = null;
    this.cdr.detectChanges();
  }

  async onDeleteConfirmed() {
    if (!this.deletingBillId) return;

    console.log('✅ Delete confirmed for bill:', this.deletingBillId);

    // Captured because the narrowing above does not survive into the closure,
    // and because nothing below should re-read a field the UI can change.
    const billId = this.deletingBillId;

    try {
      // Same shape as the save path: the bank refund, the ledger removal, the
      // internal-transfer cleanup, the stock restore and both deletes either all
      // land together or none of them do, and the database file is written once,
      // on commit. A failure part way through used to leave a bill whose stock
      // had been restored but whose row was still there, or the reverse.
      await this.db.transaction(async () => {
        const bill = this.allBills.find(b => b.bill_id === billId);

        // 🔥 FIX: refund the customer's bank if this bill was paid via bank —
        // otherwise the deducted amount is lost with no trace once the bill
        // (and its reference) is gone.
        if (this.isCustomerDepositBill(bill) && bill.customer_id && Number(bill.amount_paid) > 0) {
          const refundOk = await this.applyBankPaymentChange(bill, bill.customer_id, 0, bill.bill_number);
          if (!refundOk) throw new BillWriteAborted(this.errorMessage);
        }

        // And the mirror of that for the other kind of account: a receipt into
        // one of the owner's own accounts goes with the bill it recorded. The
        // money never arrived once the bill is gone, so the balance must stop
        // saying it did. Read before anything is deleted, for the same reason
        // every other reversal in this app is.
        const receipt = await this.db.billHouseReversalOps(billId);
        this.assertOk(receipt, 'Could not read the bank receipt on this bill');
        await this.mustRunBatch(receipt.ops || [], 'Reversing the bank receipt failed');

        if (bill?.customer_id) {
          await this.removeFromCustomerLedger(billId, bill.customer_id, true);
        }

        await this.cleanupInternalTransfers(billId, true);

        await this.restoreBillStock(billId, true);

        await this.mustRunBatch([
          { sql: 'DELETE FROM bill_items WHERE bill_id=?', params: [billId] },
          { sql: 'DELETE FROM bills WHERE bill_id=?', params: [billId] }
        ], 'Deleting the bill failed');
      });
    } catch (error: any) {
      // The transaction rolled back — nothing at all was written.
      console.error('Delete error:', error);

      if (error instanceof BillWriteAborted) {
        // applyBankPaymentChange has already said why. Leave the confirmation
        // dialog up so the user can retry, the way this path always has.
        this.cdr.detectChanges();
        return;
      }

      this.errorMessage = 'Error deleting: ' + (error?.message || error);
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
      return;
    }

    // Committed. A failure from here on is a screen-refresh problem, not a
    // failed delete, and must not be reported as one.
    this.showDeleteDialog = false;
    this.deletingBillId = null;
    try {
      await this.loadData();
    } catch (error: any) {
      console.error('The bill was deleted, but refreshing the screen failed:', error);
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() { 
    this.showDeleteDialog = false; 
    this.deletingBillId = null; 
    this.cdr.detectChanges();
  }

  async saveAndPrint() { 
    const billId = await this.saveBill(); 
    if (billId == null) return; 
    const r = await this.db.get('SELECT * FROM bills WHERE bill_id=?', [billId]); 
    const bill = r.success && r.data[0] ? r.data[0] : null; 
    if (bill) this.printBill(bill); 
  }

  async printBill(bill: any) {
    const items = await this.db.get('SELECT * FROM bill_items WHERE bill_id=?', [bill.bill_id]);
    const billItems = items.success ? items.data : [];
    const doc = new jsPDF(); 
    const pw = doc.internal.pageSize.getWidth(); 
    const ph = doc.internal.pageSize.getHeight();
    const B: [number,number,number] = [0,0,0];
    let y = 20;

    try {
      const bgData = await this.loadImageAsBase64('reportimage.png');
      const bgProps = doc.getImageProperties(bgData);
      const bgW = 120;
      const bgH = (bgProps.height * bgW) / bgProps.width;
      doc.saveGraphicsState();
      doc.setGState(new (doc as any).GState({ opacity: 0.08 }));
      doc.addImage(bgData, 'PNG', (pw - bgW) / 2, (ph - bgH) / 2, bgW, bgH);
      doc.restoreGraphicsState();
    } catch {}

    try {
      const logoData = await this.loadImageAsBase64('report-boiler.jpeg');
      const logoProps = doc.getImageProperties(logoData);
      const logoHeight = 30;
      const logoWidth = (logoProps.width * logoHeight) / logoProps.height;
      const textX = 14 + logoWidth + 10;

      doc.addImage(logoData, 'JPEG', 14, y, logoWidth, logoHeight);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(...B);
      doc.text('TALHA POULTRY FEEDS AND CHICKS', textX, y + 7);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text('Shop # 33 Jinnah Market Akal Wala Road, Toba Tek Singh', textX, y + 13);
      doc.text('Proprietor: Muhammad Tariq 0321-7546630', textX, y + 18);
      doc.text('Managing Director: Ghulam Abbas 0322-7778826', textX, y + 23);

      y += logoHeight + 6;
    } catch {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(...B);
      doc.text('TALHA POULTRY FEEDS AND CHICKS', pw / 2, y, { align: 'center' });
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text('Shop # 33 Jinnah Market Akal Wala Road, Toba Tek Singh', pw / 2, y, { align: 'center' });
      y += 5;
      doc.text('Proprietor: Muhammad Tariq — 0321-7546630', pw / 2, y, { align: 'center' });
      y += 4.5;
      doc.text('Managing Director: Ghulam Abbas — 0322-7778826', pw / 2, y, { align: 'center' });
      y += 8;
    }

    doc.setDrawColor(...B);
    doc.setLineWidth(0.5);
    doc.line(14, y, pw - 14, y);
    y += 8;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...B);
    doc.text('Sales Receipt', pw / 2, y, { align: 'center' });
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Bill #: ' + bill.bill_number, 14, y);
    doc.text('Date: ' + bill.bill_date, pw - 14, y, { align: 'right' });
    y += 6;
    doc.text('Customer: ' + (bill.customer_name || 'Walk-in'), 14, y);
    y += 4;
    doc.setDrawColor(...B);
    doc.line(14, y, pw - 14, y);
    y += 6;
    
    autoTable(doc, {
      startY: y,
      head: [['Product', 'Qty', 'Price', 'Total']],
      body: billItems.map((i: any) => [i.product_name, String(i.quantity), 'Rs. ' + i.unit_price.toLocaleString(), 'Rs. ' + i.total_price.toLocaleString()]),
      theme: 'plain',
      headStyles: { fontStyle: 'bold', fontSize: 9, textColor: B, fillColor: false as any },
      bodyStyles: { fontSize: 9 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
      margin: { left: 14, right: 14 },
      didParseCell: alignHeadFootWithColumnStyles
    });
    
    const finalY = (doc as any).lastAutoTable.finalY + 4;
    const billTableRight = getTableRightEdge(doc);
    doc.setDrawColor(...B);
    doc.line(14, finalY, pw - 14, finalY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Total: Rs. ' + bill.total_amount.toLocaleString(), billTableRight, finalY + 6, { align: 'right' });
    doc.text('Paid: Rs. ' + bill.amount_paid.toLocaleString(), billTableRight, finalY + 12, { align: 'right' });
    
    doc.setFontSize(7.5); 
    doc.setFont('helvetica', 'normal'); 
    doc.setTextColor(120,120,120);
    doc.text('Software By: www.devinfantary.com  |  Contact: 0302 6938217', pw / 2, 290, { align: 'center' });
    await this.printPdf(doc, bill.bill_number + '.pdf');
  }

  private async printPdf(doc: jsPDF, filename: string) {
    try {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1];
      const result = await (window as any).electronAPI.printPdfBase64(base64);
      if (!result || !result.success) {
        console.error('Print failed, falling back to save:', result?.error);
        doc.save(filename);
      }
    } catch (e) {
      console.error('Print error, falling back to save:', e);
      doc.save(filename);
    }
  }

  private loadImageAsBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}

