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

/**
 * DEBT PAYMENT — A NOTEBOOK. IT IS CONNECTED TO NOTHING, ON PURPOSE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR
 * ─────────────────────────────────────────────────────────────────────────
 * Somewhere for the client to write down who took money off him and
 * disappeared — and anything of that shape. He asked for it as a place to
 * REMEMBER, not as a place to account for money. So that is all it is: a name,
 * a figure, a date, a status and a note.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT MUST STAY DISCONNECTED
 * ─────────────────────────────────────────────────────────────────────────
 * Nothing outside this screen reads `debt_records`. Not Cash in Hand, not any
 * bank account or ledger, not the Overview dashboard, not one report, not one
 * delete cascade. That is the client's own instruction and it is also the only
 * honest option: the app has no idea whether the money written down here ever
 * moved through a drawer or an account. If it did, some other screen already
 * recorded it and counting it again would double it; if it did not, counting it
 * would invent a rupee that never existed.
 *
 * So this file has NO bank selector, NO `payment_source`, NO account dropdown
 * and NO totals that leave the screen. The one sum it does show — outstanding,
 * at the top — is computed here over the rows on display and goes nowhere else.
 *
 * THE NEXT PERSON HERE: it will be tempting to "finish" this by wiring it into
 * the cash position or putting a card on the dashboard. Don't.
 * `scripts/verify/verify_debt_records.js` fails if you do, and the reason is
 * above rather than in the script.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT DIFFERS FROM LOANS, which looks similar and is not
 * ─────────────────────────────────────────────────────────────────────────
 * Overview > Loans records money that really moved: it carries a Cash/Bank
 * selector, writes `bank_ledger` entries, is weighed by the overdraw guard and
 * has four cash-position terms. A loan is a transaction. This is a memo. If the
 * client wants a figure here to start affecting his cash, the row belongs on
 * Loans, not a change to this screen.
 */
@Component({
  selector: 'app-debt-payment',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe],
  templateUrl: './debt-payment.component.html',
  styleUrl: './debt-payment.component.scss'
})
export class DebtPaymentComponent implements OnInit {
  currentFarm: any = null;
  isLoading = true;
  errorMessage = '';

  records: any[] = [];

  /** A view filter over the rows below. Changes nothing that is stored. */
  filter: 'all' | 'outstanding' | 'recovered' | 'written_off' = 'all';
  searchTerm = '';

  // ── The form ──────────────────────────────────────────────
  showForm = false;
  editingId: number | null = null;
  form: any = this.emptyForm();
  formError = '';
  isSaving = false;

  // ── Delete ────────────────────────────────────────────────
  showDeleteCodeDialog = false;
  showDeleteDialog = false;
  deletingId: number | null = null;

  readonly STATUSES: { value: string; label: string }[] = [
    { value: 'outstanding', label: 'Still owed' },
    { value: 'recovered',   label: 'Got it back' },
    { value: 'written_off', label: 'Written off' }
  ];

  constructor(
    private db: DatabaseService,
    private auth: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.auth.getCurrentFarm();
    await this.load();
  }

  async load() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const res = await this.db.getDebtRecords(this.currentFarm.farm_id);
      if (!res.success) {
        this.errorMessage = 'Could not load the list: ' +
          friendlySqlError(res.error, 'unknown error');
      }
      this.records = res.success ? (res.data || []) : [];
    } catch (err: any) {
      this.errorMessage = 'Could not load the list: ' + (err?.message || err);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── Display ───────────────────────────────────────────────

  get filteredRecords(): any[] {
    const term = this.searchTerm.trim().toLowerCase();
    return this.records.filter(r => {
      if (this.filter !== 'all' && this.statusOf(r) !== this.filter) return false;
      if (!term) return true;
      return (r.person_name || '').toLowerCase().includes(term) ||
             (r.phone || '').toLowerCase().includes(term) ||
             (r.notes || '').toLowerCase().includes(term);
    });
  }

  /** NULL reads as 'outstanding' — a note with no status is money still gone. */
  statusOf(record: any): string {
    const s = record?.status;
    return s === 'recovered' || s === 'written_off' ? s : 'outstanding';
  }

  statusLabel(record: any): string {
    return this.STATUSES.find(s => s.value === this.statusOf(record))?.label || 'Still owed';
  }

  /**
   * Summed over the rows on display and used nowhere else. It is a convenience
   * for reading the list, not a figure the app reports — see the class comment.
   */
  get outstandingTotal(): number {
    return this.records
      .filter(r => this.statusOf(r) === 'outstanding')
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  }

  get recoveredTotal(): number {
    return this.records
      .filter(r => this.statusOf(r) === 'recovered')
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  }

  get writtenOffTotal(): number {
    return this.records
      .filter(r => this.statusOf(r) === 'written_off')
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  }

  // ── The form ──────────────────────────────────────────────

  private emptyForm() {
    return {
      person_name: '',
      phone: '',
      date: toLocalDateString(),
      amount: null as number | null,
      status: 'outstanding',
      notes: ''
    };
  }

  openForm() {
    this.editingId = null;
    this.form = this.emptyForm();
    this.formError = '';
    this.showForm = true;
    this.cdr.detectChanges();
  }

  editRecord(record: any) {
    this.editingId = record.debt_id;
    this.form = {
      person_name: record.person_name || '',
      phone: record.phone || '',
      date: String(record.date || '').split('T')[0],
      amount: record.amount,
      status: this.statusOf(record),
      notes: record.notes || ''
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

  async saveRecord() {
    if (this.isSaving) return;
    if (!this.form.person_name.trim()) {
      this.formError = 'Enter who this is about.';
      this.cdr.detectChanges();
      return;
    }

    this.isSaving = true;
    this.formError = '';
    try {
      // Both report failure in `.success` rather than throwing, so without this
      // check a refused write would close the form as if it had been saved.
      const result = this.editingId
        ? await this.db.updateDebtRecord(this.editingId, {
            person_name: this.form.person_name,
            phone: this.form.phone,
            date: this.form.date,
            amount: this.form.amount,
            status: this.form.status,
            notes: this.form.notes
          })
        : await this.db.addDebtRecord({
            farm_id: this.currentFarm.farm_id,
            person_name: this.form.person_name,
            phone: this.form.phone,
            date: this.form.date,
            amount: this.form.amount,
            status: this.form.status,
            notes: this.form.notes
          });

      if (!result?.success) {
        this.formError = friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was saved.';
        return;
      }
      this.closeForm();
      await this.load();
    } catch (err: any) {
      this.formError = 'Could not save: ' + (err?.message || err);
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  /** Flipping the status from the row itself — the commonest edit by far. */
  async setStatus(record: any, status: string) {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const res = await this.db.updateDebtRecord(record.debt_id, { status });
      if (!res?.success) {
        this.errorMessage = 'Could not update: ' +
          friendlySqlError(res?.error, 'the database refused the change.');
        return;
      }
      await this.load();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ────────────────────────────────────────────────

  confirmDelete(debtId: number) {
    this.deletingId = debtId;
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
  }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    try {
      const res = await this.db.deleteDebtRecord(this.deletingId);
      if (!res?.success) {
        this.errorMessage = 'Could not delete: ' +
          friendlySqlError(res?.error, 'the database refused the change.') + ' Nothing was removed.';
        return;
      }
      await this.load();
    } catch (err: any) {
      this.errorMessage = 'Could not delete: ' + (err?.message || err);
    } finally {
      this.showDeleteDialog = false;
      this.deletingId = null;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }
}
