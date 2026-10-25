import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { toLocalDateString } from '../shared/utils/date.util';
import { printPdfReport } from '../shared/utils/print-report.util';
import { paymentSourceLabel, bankOptionLabel } from '../shared/utils/bank-source.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';

const CATEGORIES = ['Vehicle', 'Equipment', 'Building', 'Land', 'Other'];

@Component({
  selector: 'app-assets',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe],
  templateUrl: './assets.component.html',
  styleUrl: './assets.component.scss'
})
export class AssetsComponent implements OnInit {
  currentFarm: any = null;
  categories = CATEGORIES;

  assets: any[] = [];
  isLoading = true;
  errorMessage = '';

  /**
   * The owner's OWN bank accounts (`bank_accounts` with no customer_id), which
   * are the only ones an asset may be paid from — see getHouseBankAccounts().
   * A customer's account holds the customer's money.
   *
   * Every payment made against one of these writes a real withdrawal into that
   * account's `bank_ledger`, so the balance on the Overview > Bank screen falls
   * by what was paid. Deleting the payment (or the asset) puts it back.
   */
  houseBanks: any[] = [];

  // ── Search / date filter ───────────────────────────────────
  searchTerm = '';
  filterDateFrom: string = '';
  filterDateTo: string = '';

  /**
   * The card the user clicked into, or null for the grid. The screen is one
   * component in two states rather than two routes — the detail view is a view
   * of a card, and coming "back" should not reload the whole grid.
   */
  selectedAsset: any = null;
  payments: any[] = [];
  isLoadingPayments = false;
  detailError = '';

  showForm = false;
  editingId: number | null = null;
  form: any = this.emptyForm();
  formError = '';

  showPaymentForm = false;
  paymentForm: any = this.emptyPaymentForm();
  paymentError = '';
  paymentWarning = '';
  /** Set once the user has seen the overpay warning and clicked Save again. */
  overpayConfirmed = false;

  showSellForm = false;
  sellingAsset: any = null;
  // payment_source/bank_id here fund the SETTLEMENT the sale writes for whatever
  // is still owed. Defaulted to cash on purpose: see confirmSell().
  sellForm = {
    sale_date: toLocalDateString(),
    sale_amount: null as number | null,
    payment_source: 'cash',
    bank_id: null as number | null,
    // And where the sale MONEY was received. The opposite direction to the two
    // above, and a separate pair of fields because one sale can legitimately
    // take the proceeds into one account and clear the outstanding balance out
    // of another.
    proceeds_source: 'cash',
    proceeds_bank_id: null as number | null
  };
  sellError = '';

  // ── Inline total-price edit (detail view) ──────────────────
  editingPrice = false;
  priceEditValue: number | null = null;
  priceEditError = '';

  showDeleteDialog = false;
  deletingId: number | null = null;

  showDeletePaymentDialog = false;
  deletingPaymentId: number | null = null;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
  }

  private emptyForm() {
    return {
      asset_name: '',
      category: 'Vehicle',
      purchase_date: toLocalDateString(),
      total_price: null as number | null,
      initial_payment: null as number | null,
      // Source of the INITIAL payment only. Cash by default, so nothing is
      // taken out of a bank account unless it is chosen.
      payment_source: 'cash',
      bank_id: null as number | null,
      notes: ''
    };
  }

  private emptyPaymentForm() {
    return {
      date: toLocalDateString(),
      amount: null as number | null,
      payment_source: 'cash',
      bank_id: null as number | null,
      notes: ''
    };
  }

  async loadHouseBanks() {
    const result = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
    this.houseBanks = result.success ? (result.data || []) : [];
    this.cdr.detectChanges();
  }

  /** No account to pay from means Bank cannot be offered as a source. */
  get hasHouseBanks(): boolean {
    return this.houseBanks.length > 0;
  }

  bankName(bankId: number | null): string {
    if (!bankId) return '—';
    const bank = this.houseBanks.find(b => b.bank_id === bankId);
    return bank ? bank.bank_name : '—';
  }

  /**
   * The one place a form's Cash/Bank choice is checked before it is saved.
   * Returns an error message, or '' when the pair is usable.
   */
  private validateSource(source: string, bankId: number | null, direction: 'in' | 'out' = 'out'): string {
    if (source !== 'bank') return '';
    if (!this.hasHouseBanks) {
      return 'You have no bank accounts of your own yet. Add one under Overview > Bank first.';
    }
    if (!bankId) {
      return direction === 'in'
        ? 'Select which bank account the money was received into.'
        : 'Select which bank account the money came out of.';
    }
    return '';
  }

  // ── Search / date filter ────────────────────────────────────

  get filteredAssets() {
    let filtered = this.assets;
    const term = this.searchTerm.trim().toLowerCase();
    if (term) {
      filtered = filtered.filter(a => (a.asset_name || '').toLowerCase().includes(term));
    }
    if (this.filterDateFrom) {
      filtered = filtered.filter(a => a.purchase_date >= this.filterDateFrom);
    }
    if (this.filterDateTo) {
      filtered = filtered.filter(a => a.purchase_date <= this.filterDateTo);
    }
    return filtered;
  }

  clearFilters() {
    this.searchTerm = '';
    this.filterDateFrom = '';
    this.filterDateTo = '';
  }

  // ── Grid totals ───────────────────────────────────────────
  // Figures follow the currently filtered set, same as Personal Expenses.

  get activeAssets() {
    return this.filteredAssets.filter(a => a.status !== 'sold');
  }

  get soldAssets() {
    return this.filteredAssets.filter(a => a.status === 'sold');
  }

  /** Active assets at their full agreed price, not at what has been paid so far. */
  get totalActiveValue(): number {
    return this.activeAssets.reduce((sum, a) => sum + this.agreedPrice(a), 0);
  }

  get totalPaid(): number {
    return this.filteredAssets.reduce((sum, a) => sum + this.paidAmount(a), 0);
  }

  /** What is still owed across every asset, sold ones included — selling
   *  something you still owe on does not clear the debt. Assets with no known
   *  agreed price contribute nothing — there is no figure to add in. */
  get totalOutstanding(): number {
    return this.filteredAssets.reduce((sum, a) => sum + (this.outstanding(a) ?? 0), 0);
  }

  get totalRealizedGainLoss(): number {
    return this.soldAssets.reduce((sum, a) => sum + (this.gainLoss(a) ?? 0), 0);
  }

  // ── Per-asset figures ─────────────────────────────────────

  /** The agreed price is optional — false when it has never been set. */
  hasPrice(asset: any): boolean {
    return asset?.agreed_price !== null && asset?.agreed_price !== undefined;
  }

  /** COALESCE covers rows written before the installments migration. Falls
   *  back to 0 for arithmetic when the price is unknown — callers that need
   *  to tell "unknown" apart from "zero" must check hasPrice() first. */
  agreedPrice(asset: any): number {
    return Number(asset?.agreed_price ?? asset?.total_price ?? asset?.purchase_amount ?? 0);
  }

  paidAmount(asset: any): number {
    return Number(asset?.amount_paid || 0);
  }

  /** Floored at zero — a total price lowered below what's already been paid
   *  leaves the asset overpaid, not "negative outstanding". Null when the
   *  agreed price is unknown — there is nothing to compute outstanding from. */
  outstanding(asset: any): number | null {
    if (!this.hasPrice(asset)) return null;
    return Math.max(0, this.agreedPrice(asset) - this.paidAmount(asset));
  }

  isOverpaid(asset: any): boolean {
    if (!this.hasPrice(asset)) return false;
    return this.paidAmount(asset) > this.agreedPrice(asset);
  }

  overpaidAmount(asset: any): number {
    if (!this.hasPrice(asset)) return 0;
    return Math.max(0, this.paidAmount(asset) - this.agreedPrice(asset));
  }

  isFullyPaid(asset: any): boolean {
    if (!this.hasPrice(asset)) return false;
    return (this.outstanding(asset) ?? 0) <= 0;
  }

  /** Percent of the agreed price handed over, for the card's progress bar.
   *  No agreed price means no target to measure progress against. */
  paidPercent(asset: any): number {
    if (!this.hasPrice(asset)) return 0;
    const price = this.agreedPrice(asset);
    if (price <= 0) return 100;
    return Math.min(100, Math.max(0, (this.paidAmount(asset) / price) * 100));
  }

  /** Measured against the full agreed price, whether or not it is paid off.
   *  Null when the price is unknown — a gain/loss figure against an unknown
   *  price would be meaningless, not just imprecise. */
  gainLoss(asset: any): number | null {
    if (!this.hasPrice(asset)) return null;
    return (asset.sale_amount || 0) - this.agreedPrice(asset);
  }

  /** Display helpers — a dash when the agreed price is unknown, never a
   *  silent zero that would read as "nothing owed" or "no loss". */
  priceLabel(asset: any): string {
    return this.hasPrice(asset) ? ('Rs. ' + this.agreedPrice(asset).toLocaleString()) : '—';
  }

  outstandingLabel(asset: any): string {
    const outstanding = this.outstanding(asset);
    return outstanding !== null ? ('Rs. ' + outstanding.toLocaleString()) : '—';
  }

  gainLossLabel(asset: any): string {
    const gainLoss = this.gainLoss(asset);
    return gainLoss !== null ? ('Rs. ' + gainLoss.toLocaleString()) : '—';
  }

  /**
   * True for the row the app wrote itself when the asset was sold, clearing
   * whatever was still owed. Flagged on the row rather than read out of its
   * note, so an edited note cannot disguise it — see `sellAsset()`.
   */
  isSettlement(payment: any): boolean {
    return Number(payment?.is_settlement || 0) === 1;
  }

  /**
   * How a payment was made, for the history table. `bank_name` comes off
   * getAssetPayments()'s LEFT JOIN, so it survives even if the account has
   * since been renamed.
   */
  /**
   * How one house account reads in the dropdown: bank name plus the account's
   * title. Shared with every other bank picker — see bank-source.util.ts.
   */
  bankOptionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }

  paymentSourceLabel(payment: any): string {
    return paymentSourceLabel(payment, this.houseBanks);
  }

  /** The settlement row, if the sale wrote one. Drives the detail-view note. */
  get settlementPayment(): any {
    return this.payments.find(p => this.isSettlement(p)) || null;
  }

  /** Deleting a settlement puts the balance back, so the dialog says so. */
  get deletingPaymentIsSettlement(): boolean {
    if (this.deletingPaymentId === null) return false;
    return this.isSettlement(this.payments.find(p => p.payment_id === this.deletingPaymentId));
  }

  // ── Loading ───────────────────────────────────────────────

  async loadAssets() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const result = await this.db.getAssets(this.currentFarm.farm_id);
      this.assets = result.success ? result.data : [];
      if (!result.success) this.errorMessage = friendlySqlError(result.error, 'Failed to load assets.');

      // Keep the open detail view pointed at the refreshed row.
      if (this.selectedAsset) {
        const refreshed = this.assets.find(a => a.asset_id === this.selectedAsset.asset_id);
        this.selectedAsset = refreshed || null;
      }
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadPayments(assetId: number) {
    this.isLoadingPayments = true;
    this.detailError = '';
    try {
      const result = await this.db.getAssetPayments(assetId, this.currentFarm.farm_id);
      this.payments = result.success ? result.data : [];
      if (!result.success) this.detailError = friendlySqlError(result.error, 'Failed to load payment history.');
    } finally {
      this.isLoadingPayments = false;
      this.cdr.detectChanges();
    }
  }

  // ── Card <-> detail navigation ────────────────────────────

  async openAsset(asset: any) {
    this.selectedAsset = asset;
    this.payments = [];
    this.detailError = '';
    await this.loadPayments(asset.asset_id);
  }

  closeAsset() {
    this.selectedAsset = null;
    this.payments = [];
    this.detailError = '';
  }

  // ── Asset form ────────────────────────────────────────────

  openAddForm() {
    this.editingId = null;
    this.form = this.emptyForm();
    this.formError = '';
    this.showForm = true;
  }

  /**
   * Edit deliberately carries no Cash/Bank selector. The source belongs to each
   * PAYMENT, and those are already made — flipping an asset's source here would
   * either do nothing (confusing) or have to move money after the fact
   * (wrong). Payments are added and removed from the payment history instead,
   * which is where their source is chosen and where a bank withdrawal is
   * written or reversed.
   */
  openEditForm(a: any) {
    this.editingId = a.asset_id;
    this.form = {
      asset_name: a.asset_name,
      category: a.category || 'Vehicle',
      purchase_date: a.purchase_date,
      total_price: this.hasPrice(a) ? this.agreedPrice(a) : null,
      initial_payment: null,
      payment_source: 'cash',
      bank_id: null,
      notes: a.notes || ''
    };
    this.formError = '';
    this.showForm = true;
  }

  cancelForm() {
    this.showForm = false;
    this.editingId = null;
  }

  async saveForm() {
    if (!this.form.asset_name.trim() || !this.form.purchase_date) {
      this.formError = 'Asset name and purchase date are required.';
      return;
    }
    // Total price is optional — the client sometimes does not know it up
    // front. Left null, outstanding cannot be calculated until it is set.
    if (this.form.total_price !== null && this.form.total_price < 0) {
      this.formError = 'Total price cannot be negative.';
      return;
    }

    const price = this.form.total_price !== null ? Number(this.form.total_price) : null;

    // Total price is freely editable, including below what has already been
    // paid — prices get renegotiated. The asset then shows as overpaid rather
    // than a negative outstanding figure; see outstanding()/isOverpaid().
    if (!this.editingId) {
      const down = Number(this.form.initial_payment || 0);
      if (down < 0) {
        this.formError = 'Initial payment cannot be negative.';
        return;
      }
      if (price !== null && down > price) {
        this.formError = 'The initial payment is more than the total price.';
        return;
      }
      // Only an actual payment moves money, so the source is only checked when
      // there is one.
      if (down > 0) {
        const sourceError = this.validateSource(this.form.payment_source, this.form.bank_id);
        if (sourceError) {
          this.formError = sourceError;
          return;
        }
      }
    }

    this.formError = '';
    try {
      const payload = {
        asset_name: this.form.asset_name.trim(),
        category: this.form.category,
        purchase_date: this.form.purchase_date,
        total_price: price,
        notes: this.form.notes?.trim() || null
      };

      const result = this.editingId
        ? await this.db.updateAsset(this.editingId, payload)
        : await this.db.addAsset({
            farm_id: this.currentFarm.farm_id,
            ...payload,
            payment_source: this.form.payment_source,
            bank_id: this.form.bank_id,
            initial_payment: Number(this.form.initial_payment || 0)
          });

      if (!result.success) {
        this.formError = friendlySqlError(result.error, 'Failed to save asset.');
        this.cdr.detectChanges();
        return;
      }

      this.showForm = false;
      this.editingId = null;
      // A bank-funded initial payment just moved a balance — refresh the
      // accounts so the dropdown's figures are not a screen behind.
      await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
      if (this.selectedAsset) await this.loadPayments(this.selectedAsset.asset_id);
    } catch (err: any) {
      this.formError = 'Failed to save asset: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  // ── Payments ──────────────────────────────────────────────

  openPaymentForm() {
    this.paymentForm = this.emptyPaymentForm();
    this.paymentError = '';
    this.paymentWarning = '';
    this.overpayConfirmed = false;
    this.showPaymentForm = true;
  }

  cancelPaymentForm() {
    this.showPaymentForm = false;
  }

  async savePayment() {
    if (!this.selectedAsset) return;
    if (!this.paymentForm.date || this.paymentForm.amount === null) {
      this.paymentError = 'Payment date and amount are required.';
      return;
    }
    const amount = Number(this.paymentForm.amount);
    if (amount <= 0) {
      this.paymentError = 'Payment amount must be greater than zero.';
      return;
    }
    const sourceError = this.validateSource(this.paymentForm.payment_source, this.paymentForm.bank_id);
    if (sourceError) {
      this.paymentError = sourceError;
      return;
    }
    // Paying more than agreed is unusual but no longer refused — charges get
    // added and prices renegotiated. Warn once with the real figure; a second
    // click on Save Payment (with the same amount) proceeds anyway. No agreed
    // price on file means there is nothing to be "over", so no warning applies.
    const owed = this.outstanding(this.selectedAsset);
    if (owed !== null && amount > owed && !this.overpayConfirmed) {
      this.paymentWarning =
        `This payment is Rs. ${(amount - owed).toLocaleString()} more than the ` +
        `Rs. ${owed.toLocaleString()} outstanding. Click "Save Payment" again to proceed anyway.`;
      this.overpayConfirmed = true;
      return;
    }

    this.paymentError = '';
    this.paymentWarning = '';
    try {
      const result = await this.db.addAssetPayment({
        asset_id: this.selectedAsset.asset_id,
        farm_id: this.currentFarm.farm_id,
        date: this.paymentForm.date,
        amount,
        payment_source: this.paymentForm.payment_source,
        bank_id: this.paymentForm.bank_id,
        asset_name: this.selectedAsset.asset_name,
        notes: this.paymentForm.notes?.trim() || null
      });

      if (!result.success) {
        this.paymentError = friendlySqlError(result.error, 'Failed to record payment.');
        this.cdr.detectChanges();
        return;
      }

      this.showPaymentForm = false;
      await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
      await this.loadPayments(this.selectedAsset.asset_id);
    } catch (err: any) {
      this.paymentError = 'Failed to record payment: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  confirmDeletePayment(paymentId: number) {
    this.deletingPaymentId = paymentId;
    this.detailError = '';
    this.showDeletePaymentDialog = true;
  }

  onDeletePaymentCancelled() {
    this.showDeletePaymentDialog = false;
    this.deletingPaymentId = null;
  }

  async onDeletePaymentConfirmed() {
    if (this.deletingPaymentId === null || !this.selectedAsset) return;
    try {
      const result = await this.db.deleteAssetPayment(this.deletingPaymentId, this.currentFarm.farm_id);
      this.showDeletePaymentDialog = false;
      if (!result.success) {
        this.detailError = friendlySqlError(result.error, 'Failed to delete payment.');
        this.cdr.detectChanges();
        return;
      }
      this.deletingPaymentId = null;
      // Deleting a bank-sourced payment reverses its withdrawal, so the
      // accounts have moved too.
      await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
      await this.loadPayments(this.selectedAsset.asset_id);
    } catch (err: any) {
      this.detailError = 'Failed to delete payment: ' + err.message;
      this.showDeletePaymentDialog = false;
      this.cdr.detectChanges();
    }
  }

  // ── Inline total-price edit ─────────────────────────────────
  // Separate from the full Edit form — a quick affordance right on the
  // detail view's Total Price figure, since prices get renegotiated often.

  startEditPrice() {
    if (!this.selectedAsset) return;
    this.priceEditValue = this.hasPrice(this.selectedAsset) ? this.agreedPrice(this.selectedAsset) : null;
    this.priceEditError = '';
    this.editingPrice = true;
  }

  cancelEditPrice() {
    this.editingPrice = false;
    this.priceEditError = '';
  }

  async saveEditPrice() {
    if (!this.selectedAsset) return;
    if (this.priceEditValue === null || this.priceEditValue < 0) {
      this.priceEditError = 'Enter a valid price.';
      return;
    }
    this.priceEditError = '';
    try {
      const result = await this.db.updateAsset(this.selectedAsset.asset_id, {
        total_price: Number(this.priceEditValue)
      });
      if (!result.success) {
        this.priceEditError = friendlySqlError(result.error, 'Failed to update total price.');
        this.cdr.detectChanges();
        return;
      }
      this.editingPrice = false;
      await this.loadAssets();
      if (this.selectedAsset) await this.loadPayments(this.selectedAsset.asset_id);
    } catch (err: any) {
      this.priceEditError = 'Failed to update total price: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  // ── Selling ───────────────────────────────────────────────

  openSellForm(a: any) {
    this.sellingAsset = a;
    this.sellForm = {
      sale_date: toLocalDateString(),
      sale_amount: null,
      // Cash, never the asset's own source — see confirmSell().
      payment_source: 'cash',
      bank_id: null,
      proceeds_source: 'cash',
      proceeds_bank_id: null
    };
    this.sellError = '';
    this.showSellForm = true;
  }

  cancelSellForm() {
    this.showSellForm = false;
    this.sellingAsset = null;
  }

  /** True when this sale will write a settlement payment for what is still
   *  owed. Never true without a known agreed price — there is no outstanding
   *  figure to settle, and inventing one would move money nobody agreed to. */
  get sellWillSettle(): boolean {
    return !!this.sellingAsset && (this.outstanding(this.sellingAsset) ?? 0) > 0;
  }

  /**
   * Selling an asset clears whatever is still owed on it by writing a real
   * settlement payment — so that payment needs a real source, and the seller is
   * asked for one here rather than having it inferred.
   *
   * The old behaviour copied `assets.payment_source`/`bank_id` onto it. That
   * recorded how the asset's FIRST payment was made, so with bank ledger
   * entries now being written it would post a withdrawal of the entire
   * remaining balance — potentially the largest single movement on the account
   * — off a form that never mentioned a bank. The selector defaults to Cash,
   * which moves no bank balance, and only touches an account when the seller
   * picks one.
   */
  async confirmSell() {
    if (!this.sellingAsset || !this.sellForm.sale_date || this.sellForm.sale_amount === null) {
      this.sellError = 'Sale date and sale amount are required.';
      return;
    }
    if (this.sellWillSettle) {
      const sourceError = this.validateSource(this.sellForm.payment_source, this.sellForm.bank_id);
      if (sourceError) {
        this.sellError = sourceError;
        return;
      }
    }
    // Money coming IN needs an account named just as money going out does —
    // refused rather than quietly downgraded to cash, which would put the
    // proceeds in the drawer instead of the bank and move two figures at once.
    const proceedsError = this.validateSource(
      this.sellForm.proceeds_source, this.sellForm.proceeds_bank_id, 'in');
    if (proceedsError) {
      this.sellError = proceedsError;
      return;
    }
    this.sellError = '';
    try {
      const result = await this.db.sellAsset(
        this.sellingAsset.asset_id, this.sellForm.sale_date, this.sellForm.sale_amount,
        { payment_source: this.sellForm.payment_source, bank_id: this.sellForm.bank_id },
        { payment_source: this.sellForm.proceeds_source, bank_id: this.sellForm.proceeds_bank_id }
      );
      if (!result.success) {
        this.sellError = friendlySqlError(result.error, 'Failed to sell asset.');
        this.cdr.detectChanges();
        return;
      }
      const soldId = this.sellingAsset.asset_id;
      this.showSellForm = false;
      this.sellingAsset = null;
      await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
      // The sale may have written a settlement payment. Reload the history so
      // the row that cleared the balance is on screen straight away, rather
      // than the balance simply vanishing.
      if (this.selectedAsset && this.selectedAsset.asset_id === soldId) {
        await this.loadPayments(soldId);
      }
    } catch (err: any) {
      this.sellError = 'Failed to sell asset: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  // ── Deleting an asset ─────────────────────────────────────

  confirmDelete(id: number) {
    this.deletingId = id;
    this.errorMessage = '';
    this.showDeleteDialog = true;
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  async onDeleteConfirmed() {
    if (this.deletingId === null) return;
    try {
      const result = await this.db.deleteAsset(this.deletingId);
      this.showDeleteDialog = false;
      if (!result.success) {
        this.errorMessage = friendlySqlError(result.error, 'Failed to delete asset.');
        this.cdr.detectChanges();
        return;
      }
      // The detail view cannot survive its own asset being deleted.
      if (this.selectedAsset && this.selectedAsset.asset_id === this.deletingId) {
        this.closeAsset();
      }
      this.deletingId = null;
      // Deleting the asset reverses every bank withdrawal its payments wrote.
      await Promise.all([this.loadAssets(), this.loadHouseBanks()]);
    } catch (err: any) {
      this.errorMessage = 'Failed to delete asset: ' + err.message;
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
    }
  }

  // ── PDF REPORT ────────────────────────────────────────────
  // Prints exactly what the card grid shows — filteredAssets already honours
  // the search box and the purchase-date range above it.

  async printReport() {
    const rows = this.filteredAssets.map(a => {
      const sold = a.status === 'sold';
      return [
        a.asset_name || '—',
        a.category || '—',
        a.purchase_date || '',
        this.priceLabel(a),
        'Rs. ' + this.paidAmount(a).toLocaleString(),
        this.isOverpaid(a)
          ? `Overpaid Rs. ${this.overpaidAmount(a).toLocaleString()}`
          : this.outstandingLabel(a),
        sold ? `Sold ${a.sale_date || ''} · Rs. ${(a.sale_amount || 0).toLocaleString()}` : '—'
      ];
    });

    const totalAgreed = this.filteredAssets.reduce((s, a) => s + this.agreedPrice(a), 0);
    const totalPaid = this.filteredAssets.reduce((s, a) => s + this.paidAmount(a), 0);
    const totalOutstanding = this.filteredAssets.reduce((s, a) => s + this.outstanding(a), 0);

    const rangeLabel = (this.filterDateFrom || this.filterDateTo)
      ? `${this.filterDateFrom || 'earliest'} to ${this.filterDateTo || 'latest'} (purchase date)`
      : 'All assets';

    await printPdfReport({
      farmName: this.currentFarm?.farm_name || 'Farm',
      farmId: this.currentFarm?.farm_id,
      title: 'ASSETS REPORT',
      rangeLabel: this.searchTerm ? `${rangeLabel} · matching "${this.searchTerm}"` : rangeLabel,
      // The same five figures the card grid's summary row shows, so the printed
      // sheet and the screen cannot disagree. "Paid" includes the settlement a
      // sale writes for the balance still owed, which is why a sold asset prints
      // as fully paid with nothing outstanding.
      summaryLines: [
        `Total Assets: ${this.filteredAssets.length} (${this.activeAssets.length} active, ${this.soldAssets.length} sold)`,
        `Total Price: Rs. ${totalAgreed.toLocaleString()}`,
        `Total Paid: Rs. ${totalPaid.toLocaleString()}`,
        `Total Outstanding: Rs. ${totalOutstanding.toLocaleString()}`,
        {
          text: `Realised Gain / Loss on assets sold: Rs. ${this.totalRealizedGainLoss.toLocaleString()}`,
          color: this.totalRealizedGainLoss > 0 ? 'positive' : this.totalRealizedGainLoss < 0 ? 'negative' : undefined
        }
      ],
      columns: [
        { header: 'Name', width: 32 },
        { header: 'Category', width: 22 },
        { header: 'Purchase Date', width: 22 },
        { header: 'Total Price', width: 24, align: 'right' },
        { header: 'Paid', width: 24, align: 'right' },
        { header: 'Outstanding', width: 30, align: 'right' },
        { header: 'Sale', width: 28 }
      ],
      rows,
      totalsRow: [
        'Total', '', '',
        'Rs. ' + totalAgreed.toLocaleString(),
        'Rs. ' + totalPaid.toLocaleString(),
        'Rs. ' + totalOutstanding.toLocaleString(),
        ''
      ],
      filename: `Assets_Report_${toLocalDateString()}.pdf`
    });
  }
}
