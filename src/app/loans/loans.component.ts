import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { bankOptionLabel } from '../shared/utils/bank-source.util';

/**
 * LOANS AND ADVANCES — money the owner lent out, and money other people left
 * with him.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN SCREEN AND NOT A PERSONAL EXPENSE
 * ─────────────────────────────────────────────────────────────────────────
 * A personal expense is money GONE. A loan is money that is coming back (or
 * that has to be given back), so recording one as an expense would overstate
 * what the farm costs to run and leave no record of what is owed in either
 * direction. Equally it is not a customer or a supplier: those are trading
 * parties with bills and stock behind them, and putting a lender among them
 * would pollute Distribution's revenue and payable figures.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A LOAN IS NEVER INCOME AND NEVER AN EXPENSE
 * ─────────────────────────────────────────────────────────────────────────
 * Nothing on this screen enters any profit figure on any report. What a loan
 * moves is:
 *
 *   - the CASH or BANK position, because the money physically went somewhere
 *     (`cash-position.service.ts` has four terms for it);
 *   - the two outstanding cards on the Overview dashboard.
 *
 * That is the whole of it. Lending Rs. 100,000 makes the owner no poorer and
 * no richer; it moves the money from his drawer into a receivable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE TABLE, TWO DIRECTIONS
 * ─────────────────────────────────────────────────────────────────────────
 * `direction` is 'given' (he lent it — a RECEIVABLE) or 'received' (he is
 * holding it, or borrowed it — a PAYABLE). The money runs opposite ways on the
 * two, and a settlement runs opposite to its own principal:
 *
 *   given     principal OUT, repayments IN
 *   received  principal IN,  repayments OUT
 *
 * which is exactly why `loans` is not a `BANK_SOURCES` table — that mechanism
 * declares one direction per table. See `LOAN_REF` in database.service.ts.
 *
 * Standing rules, the same ones every money screen here follows: HOUSE accounts
 * only (`getHouseBankAccounts()` — lending out of a customer's account would
 * record it as that customer's withdrawal); Bank with no account chosen is
 * REFUSED rather than quietly saved as cash; a settlement past square is
 * refused; and a delete is never refused for an overdraw, because removing a
 * movement puts the money back.
 */
@Component({
  selector: 'app-loans',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe],
  templateUrl: './loans.component.html',
  styleUrl: './loans.component.scss'
})
export class LoansComponent implements OnInit {
  currentFarm: any = null;
  isLoading = true;
  errorMessage = '';

  loans: any[] = [];
  houseBanks: any[] = [];
  totals = { receivable: 0, payable: 0 };

  /** 'all' | 'given' | 'received' — a view filter, never a scope on the save. */
  filter: 'all' | 'given' | 'received' = 'all';

  // ── The loan form ─────────────────────────────────────────
  showForm = false;
  editingId: number | null = null;
  form: any = this.emptyForm();
  formError = '';
  isSaving = false;

  // ── The settlement form ───────────────────────────────────
  showPaymentForm = false;
  paymentLoan: any = null;
  paymentForm: any = this.emptyPaymentForm();
  paymentError = '';

  // ── The drill-down ────────────────────────────────────────
  selectedLoan: any = null;
  payments: any[] = [];

  // ── Deletes ───────────────────────────────────────────────
  showDeleteCodeDialog = false;
  showDeleteDialog = false;
  deletingLoanId: number | null = null;
  deletingPaymentId: number | null = null;

  constructor(
    private db: DatabaseService,
    private auth: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.auth.getCurrentFarm();
    await this.loadAll();
  }

  // ── Loading ───────────────────────────────────────────────

  async loadAll() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const [loans, banks, totals] = await Promise.all([
        this.db.getLoans(this.currentFarm.farm_id),
        this.db.getHouseBankAccounts(this.currentFarm.farm_id),
        this.db.getLoanTotals(this.currentFarm.farm_id)
      ]);

      if (!loans.success) {
        this.errorMessage = 'Could not load loans: ' + friendlySqlError(loans.error, 'unknown error');
      }
      this.loans = loans.success ? (loans.data || []) : [];
      this.houseBanks = banks.success ? (banks.data || []) : [];
      this.totals = { receivable: totals.receivable, payable: totals.payable };
      if (totals.error) {
        this.errorMessage = 'Could not total the loans: ' + totals.error;
      }

      // Keep the open drill-down pointing at the freshly read row, so an edit
      // or a settlement is reflected without closing it.
      if (this.selectedLoan) {
        const again = this.loans.find(l => l.loan_id === this.selectedLoan.loan_id);
        this.selectedLoan = again || null;
        if (this.selectedLoan) await this.loadPayments(this.selectedLoan.loan_id);
        else this.payments = [];
      }
    } catch (err: any) {
      this.errorMessage = 'Could not load loans: ' + (err?.message || err);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  private async loadPayments(loanId: number) {
    const res = await this.db.getLoanPayments(loanId, this.currentFarm.farm_id);
    this.payments = res.success ? (res.data || []) : [];
  }

  // ── Display ───────────────────────────────────────────────

  get filteredLoans(): any[] {
    if (this.filter === 'all') return this.loans;
    return this.loans.filter(l => this.directionOf(l) === this.filter);
  }

  /** NULL reads as 'given', which is what every row written before this was. */
  directionOf(loan: any): string {
    return loan?.direction === 'received' ? 'received' : 'given';
  }

  isGiven(loan: any): boolean { return this.directionOf(loan) === 'given'; }

  directionLabel(loan: any): string {
    return this.isGiven(loan) ? 'Lent out' : 'Holding';
  }

  /** What a settlement on this loan means, in the client's own terms. */
  settleLabel(loan: any): string {
    return this.isGiven(loan) ? 'Record repayment received' : 'Record payment made';
  }

  outstanding(loan: any): number {
    return Number(loan?.outstanding) || 0;
  }

  isSettled(loan: any): boolean {
    return this.outstanding(loan) <= 0.005;
  }

  get hasHouseBanks(): boolean { return this.houseBanks.length > 0; }

  bankOptionLabel(bank: any): string { return bankOptionLabel(bank); }

  /** The account a saved row moved through, or 'Cash'. */
  accountOf(row: any): string {
    if (row?.payment_source !== 'bank') return 'Cash';
    return row.bank_name ? 'Bank — ' + row.bank_name : 'Bank';
  }

  // ── The loan form ─────────────────────────────────────────

  private emptyForm() {
    return {
      direction: 'given',
      party_name: '',
      phone: '',
      date: toLocalDateString(),
      principal: null as number | null,
      notes: '',
      payment_source: 'cash',
      bank_id: null as number | null
    };
  }

  openForm(direction: 'given' | 'received' = 'given') {
    this.editingId = null;
    this.form = this.emptyForm();
    this.form.direction = direction;
    this.formError = '';
    this.showForm = true;
    this.cdr.detectChanges();
  }

  editLoan(loan: any) {
    this.editingId = loan.loan_id;
    this.form = {
      direction: this.directionOf(loan),
      party_name: loan.party_name || '',
      phone: loan.phone || '',
      date: String(loan.date || '').split('T')[0],
      principal: loan.principal,
      notes: loan.notes || '',
      payment_source: loan.payment_source === 'bank' ? 'bank' : 'cash',
      bank_id: loan.bank_id ?? null
    };
    this.formError = '';
    this.showForm = true;
    this.cdr.detectChanges();
  }

  closeForm() {
    this.showForm = false;
    this.editingId = null;
    this.formError = '';
  }

  /** The reason this form cannot be saved yet, or null. */
  private formProblem(form: any): string | null {
    if (!(form.party_name || '').trim()) return 'Enter who the loan is with.';
    if (!form.date) return 'Enter the date.';
    if (!(Number(form.principal) > 0)) return 'Enter an amount greater than zero.';
    if (form.payment_source === 'bank') {
      if (!this.hasHouseBanks) {
        return 'You have no bank accounts of your own yet. Add one under Overview > Bank first, ' +
               'or record this as cash.';
      }
      if (!Number(form.bank_id)) return 'Choose which bank account this money moved through.';
    }
    return null;
  }

  async saveLoan() {
    if (this.isSaving) return;
    const problem = this.formProblem(this.form);
    if (problem) { this.formError = problem; this.cdr.detectChanges(); return; }

    this.isSaving = true;
    this.formError = '';
    try {
      // Both report failure in `.success` rather than throwing — the overdraw
      // refusal most of all — so a save is never treated as done without this.
      const result = this.editingId
        ? await this.db.updateLoan(this.editingId, {
            direction: this.form.direction,
            party_name: this.form.party_name,
            phone: this.form.phone,
            date: this.form.date,
            principal: this.form.principal,
            notes: this.form.notes,
            payment_source: this.form.payment_source,
            bank_id: this.form.bank_id
          })
        : await this.db.addLoan({
            farm_id: this.currentFarm.farm_id,
            direction: this.form.direction,
            party_name: this.form.party_name,
            phone: this.form.phone,
            date: this.form.date,
            principal: Number(this.form.principal),
            notes: this.form.notes,
            payment_source: this.form.payment_source,
            bank_id: this.form.bank_id
          });

      if (!result?.success) {
        this.formError = friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was saved.';
        return;
      }
      this.closeForm();
      await this.loadAll();
    } catch (err: any) {
      this.formError = 'Could not save: ' + (err?.message || err);
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── The settlement form ───────────────────────────────────

  private emptyPaymentForm() {
    return {
      date: toLocalDateString(),
      amount: null as number | null,
      notes: '',
      payment_source: 'cash',
      bank_id: null as number | null
    };
  }

  openPaymentForm(loan: any) {
    this.paymentLoan = loan;
    this.paymentForm = this.emptyPaymentForm();
    // Defaulted to the whole remaining balance, which is the common case; the
    // client types over it for a part settlement.
    this.paymentForm.amount = this.outstanding(loan) || null;
    this.paymentError = '';
    this.showPaymentForm = true;
    this.cdr.detectChanges();
  }

  closePaymentForm() {
    this.showPaymentForm = false;
    this.paymentLoan = null;
    this.paymentError = '';
  }

  async savePayment() {
    if (this.isSaving || !this.paymentLoan) return;
    const amount = Number(this.paymentForm.amount) || 0;
    if (!this.paymentForm.date) { this.paymentError = 'Enter the date.'; return; }
    if (!(amount > 0)) { this.paymentError = 'Enter an amount greater than zero.'; return; }
    if (this.paymentForm.payment_source === 'bank') {
      if (!this.hasHouseBanks) {
        this.paymentError = 'You have no bank accounts of your own yet. Add one under ' +
          'Overview > Bank first, or record this as cash.';
        return;
      }
      if (!Number(this.paymentForm.bank_id)) {
        this.paymentError = 'Choose which bank account this money moved through.';
        return;
      }
    }
    // The overpayment refusal itself lives in the service, over the loan's own
    // outstanding figure, so this screen cannot disagree with it.

    this.isSaving = true;
    this.paymentError = '';
    try {
      const res = await this.db.addLoanPayment({
        loan_id: this.paymentLoan.loan_id,
        farm_id: this.currentFarm.farm_id,
        date: this.paymentForm.date,
        amount,
        notes: this.paymentForm.notes,
        payment_source: this.paymentForm.payment_source,
        bank_id: this.paymentForm.bank_id
      });
      if (!res?.success) {
        this.paymentError = friendlySqlError(res?.error, 'the database refused the change.') +
          ' Nothing was recorded.';
        return;
      }
      this.closePaymentForm();
      await this.loadAll();
    } catch (err: any) {
      this.paymentError = 'Could not record: ' + (err?.message || err);
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── The drill-down ────────────────────────────────────────

  async openLoan(loan: any) {
    this.selectedLoan = loan;
    await this.loadPayments(loan.loan_id);
    this.cdr.detectChanges();
  }

  closeLoan() {
    this.selectedLoan = null;
    this.payments = [];
  }

  // ── Deletes ───────────────────────────────────────────────

  confirmDeleteLoan(loanId: number) {
    this.deletingLoanId = loanId;
    this.deletingPaymentId = null;
    this.showDeleteCodeDialog = true;
    this.cdr.detectChanges();
  }

  confirmDeletePayment(paymentId: number) {
    this.deletingPaymentId = paymentId;
    this.deletingLoanId = null;
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
    this.deletingLoanId = null;
    this.deletingPaymentId = null;
  }

  get deleteMessage(): string {
    return this.deletingLoanId
      ? 'This removes the loan, every settlement recorded against it, and any bank entries they ' +
        'wrote. The money goes back onto whichever accounts it came out of. Cannot be undone.'
      : 'This removes the settlement and any bank entry it wrote, putting the money back and ' +
        'raising the outstanding balance again. Cannot be undone.';
  }

  async onDeleteConfirmed() {
    try {
      const res = this.deletingLoanId
        ? await this.db.deleteLoan(this.deletingLoanId)
        : await this.db.deleteLoanPayment(this.deletingPaymentId!);
      if (!res?.success) {
        this.errorMessage = 'Could not delete: ' +
          friendlySqlError(res?.error, 'the database refused the change.') + ' Nothing was removed.';
        return;
      }
      if (this.deletingLoanId && this.selectedLoan?.loan_id === this.deletingLoanId) {
        this.closeLoan();
      }
      await this.loadAll();
    } catch (err: any) {
      this.errorMessage = 'Could not delete: ' + (err?.message || err);
    } finally {
      this.showDeleteDialog = false;
      this.deletingLoanId = null;
      this.deletingPaymentId = null;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingLoanId = null;
    this.deletingPaymentId = null;
  }
}
