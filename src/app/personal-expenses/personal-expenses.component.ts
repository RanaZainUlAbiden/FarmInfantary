import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { printPdfReport } from '../shared/utils/print-report.util';
import { paymentSourceLabel, bankOptionLabel } from '../shared/utils/bank-source.util';

function firstOfMonth(): string {
  const d = new Date();
  return toLocalDateString(new Date(d.getFullYear(), d.getMonth(), 1));
}

@Component({
  selector: 'app-personal-expenses',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe],
  templateUrl: './personal-expenses.component.html',
  styleUrl: './personal-expenses.component.scss'
})
export class PersonalExpensesComponent implements OnInit {
  currentFarm: any = null;

  /** Categories are user-defined rows now, not a hardcoded list. */
  categories: any[] = [];
  isLoading = true;
  errorMessage = '';

  fromDate = firstOfMonth();
  toDate = toLocalDateString();

  /**
   * The category card the user clicked into, or null for the grid. One
   * component in two states — the same shape the Assets screen uses.
   */
  selectedCategory: any = null;
  entries: any[] = [];
  isLoadingEntries = false;
  detailError = '';

  showCategoryForm = false;
  editingCategoryId: number | null = null;
  categoryForm = { category_name: '' };
  categoryError = '';

  showForm = false;
  editingId: number | null = null;
  form: any = this.emptyForm();
  formError = '';

  showDeleteDialog = false;
  deletingId: number | null = null;

  showDeleteCategoryDialog = false;
  deletingCategoryId: number | null = null;

  /**
   * The owner's OWN bank accounts — the same set the Assets screen draws from,
   * and for the same reason: a personal expense paid by bank comes out of his
   * money, not a customer's. Choosing one here writes a real withdrawal into
   * that account's ledger; editing or deleting the entry adjusts or reverses it.
   */
  houseBanks: any[] = [];

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    await Promise.all([this.loadCategories(), this.loadHouseBanks()]);
  }

  private emptyForm() {
    return {
      date: toLocalDateString(),
      category_id: null as number | null,
      description: '',
      amount: null as number | null,
      // Cash by default, so nothing leaves a bank account unless it is chosen.
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

  /** Returns an error message, or '' when the Cash/Bank pair is usable. */
  private validateSource(source: string, bankId: number | null): string {
    if (source !== 'bank') return '';
    if (!this.hasHouseBanks) {
      return 'You have no bank accounts of your own yet. Add one under Overview > Bank first.';
    }
    if (!bankId) return 'Select which bank account the money came out of.';
    return '';
  }

  /**
   * How an entry was paid, for the table. `bank_name` comes off the query's
   * LEFT JOIN. An entry recorded as bank before this screen had a selector has
   * no account on it at all, so it reads as plain "Bank" rather than claiming
   * one — and it has no ledger entry either; see updatePersonalExpense().
   */
  /** Shared with every other money screen — see bank-source.util.ts. */
  /**
   * How one house account reads in the dropdown: bank name plus the account's
   * title. Shared with every other bank picker — see bank-source.util.ts.
   */
  bankOptionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }

  paymentSourceLabel(entry: any): string {
    return paymentSourceLabel(entry);
  }

  // ── Grid totals ───────────────────────────────────────────

  get grandTotal(): number {
    return this.categories.reduce((sum, c) => sum + Number(c.total_spent || 0), 0);
  }

  get totalEntries(): number {
    return this.categories.reduce((sum, c) => sum + Number(c.entry_count || 0), 0);
  }

  /** Total of the entries currently listed on the detail view. */
  get categoryTotal(): number {
    return this.entries.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  }

  // ── Loading ───────────────────────────────────────────────

  async loadCategories() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const result = await this.db.getPersonalExpenseCategories(
        this.currentFarm.farm_id, this.fromDate, this.toDate
      );
      this.categories = result.success ? result.data : [];
      if (!result.success) this.errorMessage = friendlySqlError(result.error, 'Failed to load categories.');

      if (this.selectedCategory) {
        const refreshed = this.categories.find(c => c.category_id === this.selectedCategory.category_id);
        this.selectedCategory = refreshed || null;
      }
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadEntries(category: any) {
    this.isLoadingEntries = true;
    this.detailError = '';
    try {
      const result = await this.db.getPersonalExpensesByCategory(
        this.currentFarm.farm_id, category.category_id, category.category_name,
        this.fromDate, this.toDate
      );
      this.entries = result.success ? result.data : [];
      if (!result.success) this.detailError = friendlySqlError(result.error, 'Failed to load entries.');
    } finally {
      this.isLoadingEntries = false;
      this.cdr.detectChanges();
    }
  }

  async applyFilter() {
    await this.loadCategories();
    if (this.selectedCategory) await this.loadEntries(this.selectedCategory);
  }

  // ── Card <-> detail navigation ────────────────────────────

  async openCategory(category: any) {
    this.selectedCategory = category;
    this.entries = [];
    this.detailError = '';
    await this.loadEntries(category);
  }

  closeCategory() {
    this.selectedCategory = null;
    this.entries = [];
    this.detailError = '';
  }

  // ── Category add / rename / delete ────────────────────────

  openAddCategoryForm() {
    this.editingCategoryId = null;
    this.categoryForm = { category_name: '' };
    this.categoryError = '';
    this.showCategoryForm = true;
  }

  openRenameCategoryForm(c: any, event?: Event) {
    // The card itself is clickable, so the action buttons on it must not also
    // open the detail view.
    event?.stopPropagation();
    this.editingCategoryId = c.category_id;
    this.categoryForm = { category_name: c.category_name };
    this.categoryError = '';
    this.showCategoryForm = true;
  }

  cancelCategoryForm() {
    this.showCategoryForm = false;
    this.editingCategoryId = null;
  }

  async saveCategoryForm() {
    const name = this.categoryForm.category_name.trim();
    if (!name) {
      this.categoryError = 'A category name is required.';
      return;
    }
    this.categoryError = '';
    try {
      const result = this.editingCategoryId
        ? await this.db.renamePersonalExpenseCategory(this.editingCategoryId, this.currentFarm.farm_id, name)
        : await this.db.addPersonalExpenseCategory(this.currentFarm.farm_id, name);

      if (!result.success) {
        this.categoryError = friendlySqlError(result.error, 'Failed to save category.');
        this.cdr.detectChanges();
        return;
      }

      this.showCategoryForm = false;
      this.editingCategoryId = null;
      await this.loadCategories();
      if (this.selectedCategory) await this.loadEntries(this.selectedCategory);
    } catch (err: any) {
      this.categoryError = 'Failed to save category: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  confirmDeleteCategory(categoryId: number, event?: Event) {
    event?.stopPropagation();
    this.deletingCategoryId = categoryId;
    this.errorMessage = '';
    this.showDeleteCategoryDialog = true;
  }

  onDeleteCategoryCancelled() {
    this.showDeleteCategoryDialog = false;
    this.deletingCategoryId = null;
  }

  /**
   * The refusal for a category that still has entries comes back from the
   * service as { success: false } with the count in the message — foreign keys
   * are not enforced here, so that check is the only thing keeping a delete from
   * stranding rows no card would ever show again.
   */
  async onDeleteCategoryConfirmed() {
    if (this.deletingCategoryId === null) return;
    try {
      const result = await this.db.deletePersonalExpenseCategory(
        this.deletingCategoryId, this.currentFarm.farm_id
      );
      this.showDeleteCategoryDialog = false;
      if (!result.success) {
        this.errorMessage = friendlySqlError(result.error, 'Failed to delete category.');
        this.cdr.detectChanges();
        return;
      }
      if (this.selectedCategory && this.selectedCategory.category_id === this.deletingCategoryId) {
        this.closeCategory();
      }
      this.deletingCategoryId = null;
      await this.loadCategories();
    } catch (err: any) {
      this.errorMessage = 'Failed to delete category: ' + err.message;
      this.showDeleteCategoryDialog = false;
      this.cdr.detectChanges();
    }
  }

  // ── Entry add / edit / delete ─────────────────────────────

  openAddForm() {
    this.editingId = null;
    this.form = this.emptyForm();
    // Inside a category, entries default to it; from the grid, to the first one.
    this.form.category_id = this.selectedCategory
      ? this.selectedCategory.category_id
      : (this.categories[0]?.category_id ?? null);
    this.formError = '';
    this.showForm = true;
  }

  /**
   * Unlike the Assets edit form, this one DOES carry the Cash/Bank selector.
   * An asset's source belongs to each individual payment and those are already
   * made; a personal expense IS the single payment, so correcting how it was
   * paid is a legitimate edit — and updatePersonalExpense() adjusts the bank
   * ledger to match, whichever way it moves.
   */
  openEditForm(e: any) {
    this.editingId = e.pexpense_id;
    this.form = {
      date: e.date,
      category_id: e.category_id ?? this.selectedCategory?.category_id ?? null,
      description: e.description || '',
      amount: e.amount,
      payment_source: e.payment_source === 'bank' ? 'bank' : 'cash',
      bank_id: e.bank_id ?? null,
      notes: e.notes || ''
    };
    this.formError = '';
    this.showForm = true;
  }

  cancelForm() {
    this.showForm = false;
    this.editingId = null;
  }

  private categoryNameFor(categoryId: number | null): string | null {
    const match = this.categories.find(c => c.category_id === categoryId);
    return match ? match.category_name : null;
  }

  async saveForm() {
    if (!this.form.date || this.form.amount === null) {
      this.formError = 'Date and amount are required.';
      return;
    }
    if (!this.form.category_id) {
      this.formError = 'Select a category.';
      return;
    }
    const sourceError = this.validateSource(this.form.payment_source, this.form.bank_id);
    if (sourceError) {
      this.formError = sourceError;
      return;
    }
    this.formError = '';
    try {
      // category and category_id are written together so the denormalised name
      // never drifts from the link.
      const payload = {
        date: this.form.date,
        category_id: this.form.category_id,
        category: this.categoryNameFor(this.form.category_id),
        description: this.form.description?.trim() || null,
        amount: this.form.amount || 0,
        payment_source: this.form.payment_source,
        bank_id: this.form.bank_id,
        notes: this.form.notes?.trim() || null
      };

      const result = this.editingId
        ? await this.db.updatePersonalExpense(this.editingId, payload)
        : await this.db.addPersonalExpense({ farm_id: this.currentFarm.farm_id, ...payload });

      if (!result.success) {
        this.formError = friendlySqlError(result.error, 'Failed to save personal expense.');
        this.cdr.detectChanges();
        return;
      }

      this.showForm = false;
      this.editingId = null;
      // A bank-paid entry just moved a balance — refresh the accounts so the
      // dropdown's figures are not a screen behind.
      await Promise.all([this.loadCategories(), this.loadHouseBanks()]);
      if (this.selectedCategory) await this.loadEntries(this.selectedCategory);
    } catch (err: any) {
      this.formError = 'Failed to save personal expense: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) {
    this.deletingId = id;
    this.detailError = '';
    this.showDeleteDialog = true;
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  async onDeleteConfirmed() {
    if (this.deletingId === null) return;
    try {
      const result = await this.db.deletePersonalExpense(this.deletingId);
      this.showDeleteDialog = false;
      if (!result.success) {
        this.detailError = friendlySqlError(result.error, 'Failed to delete personal expense.');
        this.cdr.detectChanges();
        return;
      }
      this.deletingId = null;
      // Deleting a bank-paid entry reverses its withdrawal.
      await Promise.all([this.loadCategories(), this.loadHouseBanks()]);
      if (this.selectedCategory) await this.loadEntries(this.selectedCategory);
    } catch (err: any) {
      this.detailError = 'Failed to delete personal expense: ' + err.message;
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
    }
  }

  // ── PDF REPORT ────────────────────────────────────────────
  // Prints exactly what the detail table shows — `entries` is already scoped
  // to the selected category and the fromDate/toDate range above it.

  async printCategoryReport() {
    if (!this.selectedCategory) return;
    const rows = this.entries.map(e => [
      e.date || '',
      e.description || '—',
      'Rs. ' + (e.amount || 0).toLocaleString(),
      this.paymentSourceLabel(e),
      e.notes || ''
    ]);

    await printPdfReport({
      farmName: this.currentFarm?.farm_name || 'Farm',
      farmId: this.currentFarm?.farm_id,
      title: `PERSONAL EXPENSES — ${this.selectedCategory.category_name.toUpperCase()}`,
      rangeLabel: `${this.fromDate} to ${this.toDate}`,
      summaryLines: [
        `Total: Rs. ${this.categoryTotal.toLocaleString()}`,
        `Entries: ${this.entries.length}`
      ],
      columns: [
        { header: 'Date', width: 26 },
        { header: 'Description', width: 48 },
        { header: 'Amount', width: 28, align: 'right' },
        { header: 'Paid From', width: 32 },
        { header: 'Notes', width: 28 }
      ],
      rows,
      totalsRow: ['Total', '', 'Rs. ' + this.categoryTotal.toLocaleString(), '', ''],
      filename: `${this.selectedCategory.category_name}_Expenses_${toLocalDateString()}.pdf`
    });
  }
}
