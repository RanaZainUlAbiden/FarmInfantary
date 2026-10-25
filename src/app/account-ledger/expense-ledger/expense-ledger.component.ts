import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DatabaseService } from '../../shared/services/database.service';
import { AuthService } from '../../shared/services/auth.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles } from '../../shared/utils/pdf-table.util';
import { DeleteCodeDialogComponent } from '../../shared/components/delete-code-dialog/delete-code-dialog.component';

import { toLocalDateString } from '../../shared/utils/date.util';
import { byNewestFirst } from '../../shared/utils/group.util';
import { BackLinkComponent } from '../../shared/components/back-link/back-link.component';
import { BankPickerComponent } from '../../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankNameOf } from '../../shared/utils/bank-source.util';

import { printPdfBase64 } from '../../shared/utils/browser-print.util';
@Component({
  selector: 'app-expense-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent,
            BackLinkComponent, BankPickerComponent],
  templateUrl: './expense-ledger.component.html',
  styleUrl: './expense-ledger.component.scss'
})
export class ExpenseLedgerComponent implements OnInit {
  currentFarm: any = null;
  expenses: any[] = [];
  filteredExpenses: any[] = [];
  isLoading = true;
  errorMessage = '';

  /**
   * The owner's OWN accounts. Never `getBankAccounts()` unscoped: paying the
   * distribution business's rent out of a customer's account would record it as
   * that customer's withdrawal.
   */
  houseBanks: any[] = [];

  // ── Filter ────────────────────────────────────────────────
  filterDateFrom: string = '';
  filterDateTo: string = '';

  /** The category card the user clicked into, or null for the grid. */
  selectedCategoryGroup: string | null = null;

  // ── Categories (DB-backed, CRUD) ─────────────────────────
  private readonly SEED_CATEGORIES = ['Rent', 'Tea', 'Land', 'Utilities', 'Salary', 'Maintenance', 'Transport', 'Office', 'Other'];
  dbCategories: any[] = [];
  get categories(): string[] {
    return this.dbCategories.map((c: any) => c.category_name);
  }

  showCategoryModal = false;
  showDeleteCategoryDialog = false;
  deletingCategoryId: number | null = null;
  newCategoryName = '';
  categoryError = '';

  // ── Form ──────────────────────────────────────────────────
  showForm = false;
  isEditing = false;
  editingId: number | null = null;
  expenseForm: any = {
    transaction_date: '',
    description: '',
    amount: 0,
    category: '',
    // 'cash' = paid, 'credit' = unpaid. A SETTLEMENT STATUS, not a source --
    // the `purchase_orders` shape -- so Cash/Bank is its own control below and
    // is only shown on a paid expense.
    payment_type: 'cash',
    payment_source: 'cash',
    bank_id: null,
    notes: ''
  };

  // ── Delete ─────────────────────────────────────────────────
  showDeleteDialog = false;
  showDeleteCodeDialog: boolean = false;
  deletingId: number | null = null;
  isSubmitting = false;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.expenseForm.transaction_date = toLocalDateString();
    await this.loadCategories();
    await this.loadHouseBanks();
    this.loadExpenses();
  }

  /**
   * Re-read on every load rather than cached: the account list is farm-wide, so
   * an account added on the Bank screen has to appear here without a reload.
   */
  private async loadHouseBanks() {
    const res = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
    this.houseBanks = res.success ? (res.data || []) : [];
  }

  /** Has the client any account of his own to pay out of? */
  get hasHouseBanks(): boolean {
    return this.houseBanks.length > 0;
  }

  /** The account a saved row was paid from, for the Payment column. */
  bankNameOf(bankId: number | null): string {
    return bankNameOf(this.houseBanks, bankId);
  }

  /**
   * Cash/Bank only means anything on a PAID expense. An unpaid one has moved no
   * money, so it carries no entry whatever the selector says -- the same
   * normalization `bankFieldsFor()` does on the Purchase Orders screen, and the
   * reason the control is hidden rather than merely ignored.
   */
  private bankFieldsFor(form: any): { payment_source: string; bank_id: number | null } {
    const paid = (form.payment_type || 'cash') === 'cash';
    const bankId = Number(form.bank_id) || null;
    return paid && form.payment_source === 'bank' && bankId
      ? { payment_source: 'bank', bank_id: bankId }
      : { payment_source: 'cash', bank_id: null };
  }

  // ── LOAD ──────────────────────────────────────────────────

  async loadExpenses() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const result = await this.db.getExpenses(this.currentFarm.farm_id);
      if (result.success) {
        this.expenses = result.data || [];
        this.applyFilters();
      }
    } catch (err: any) {
      this.errorMessage = 'Failed to load expenses: ' + err.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── CATEGORY MANAGEMENT ──────────────────────────────────

  private async loadCategories(): Promise<void> {
    try {
      const result = await this.db.getCategories(this.currentFarm.farm_id, 'expense');
      this.dbCategories = result.success ? result.data : [];
      if (this.dbCategories.length === 0) {
        // First run — seed with the original preset list, preserving case so any
        // expenses already saved against these names (from before this CRUD
        // feature existed) keep matching exactly in filters/breakdowns.
        for (const cat of this.SEED_CATEGORIES) {
          await this.db.run(
            'INSERT OR IGNORE INTO categories (farm_id, category_name, category_type) VALUES (?, ?, ?)',
            [this.currentFarm.farm_id, cat, 'expense']
          );
        }
        const refreshed = await this.db.getCategories(this.currentFarm.farm_id, 'expense');
        this.dbCategories = refreshed.success ? refreshed.data : [];
      }
    } catch {
      this.dbCategories = [];
    }
  }

  openCategoryModal(): void {
    this.newCategoryName = '';
    this.categoryError = '';
    this.showCategoryModal = true;
    this.cdr.detectChanges();
  }

  closeCategoryModal(): void {
    this.showCategoryModal = false;
    this.newCategoryName = '';
    this.categoryError = '';
    this.cdr.detectChanges();
  }

  async saveCategory(): Promise<void> {
    const name = this.newCategoryName.trim();
    if (!name) { this.categoryError = 'Category name is required.'; return; }
    if (this.categories.some(c => c.toLowerCase() === name.toLowerCase())) {
      this.categoryError = 'Category already exists.';
      return;
    }
    const result = await this.db.addCategory(this.currentFarm.farm_id, name, 'expense');
    if (!result || !result.success) {
      this.categoryError = 'Failed to save category. It may already exist.';
      return;
    }
    await this.loadCategories();
    this.closeCategoryModal();
    this.cdr.detectChanges();
  }

  confirmDeleteCategory(cat: any) {
    this.deletingCategoryId = cat.category_id;
    this.showDeleteCategoryDialog = true;
  }

  async onDeleteCategoryConfirmed() {
    if (!this.deletingCategoryId) return;
    await this.db.deleteCategory(this.deletingCategoryId);
    this.showDeleteCategoryDialog = false;
    this.deletingCategoryId = null;
    await this.loadCategories();
    this.cdr.detectChanges();
  }

  onDeleteCategoryCancelled() {
    this.showDeleteCategoryDialog = false;
    this.deletingCategoryId = null;
  }

  // ── FILTERS ──────────────────────────────────────────────

  applyFilters() {
    let filtered = [...this.expenses];

    if (this.filterDateFrom) {
      filtered = filtered.filter(e => e.transaction_date >= this.filterDateFrom);
    }
    if (this.filterDateTo) {
      filtered = filtered.filter(e => e.transaction_date <= this.filterDateTo);
    }

    this.filteredExpenses = filtered;
    this.cdr.detectChanges();
  }

  clearFilters() {
    this.filterDateFrom = '';
    this.filterDateTo = '';
    this.filteredExpenses = [...this.expenses];
    this.cdr.detectChanges();
  }

  // ── CALCULATIONS ─────────────────────────────────────────

  getTotalExpenses(): number {
    return this.filteredExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  getCategoryTotal(category: string): number {
    return this.filteredExpenses
      .filter(e => e.category === category)
      .reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  getCategoryCount(category: string): number {
    return this.filteredExpenses.filter(e => e.category === category).length;
  }

  // 🔥 NEW: helper methods for template (no arrow functions)
  getActiveCategoryCount(): number {
    return this.categories.filter(c => this.getCategoryCount(c) > 0).length;
  }

  getAverageExpense(): number {
    if (this.filteredExpenses.length === 0) return 0;
    return this.getTotalExpenses() / this.filteredExpenses.length;
  }

  // ── CARD <-> DETAIL NAVIGATION ────────────────────────────
  // Cards are derived from `filteredExpenses` (so they honour the date
  // filters), not a separate query — the underlying `expense_ledger` table
  // and its category text column are unchanged.

  /** One card per known category, its total/count for the current date range (0 if unused), highest total first. */
  get categoryGroups(): { category: string; total: number; count: number }[] {
    return this.categories
      .map(cat => ({ category: cat, total: this.getCategoryTotal(cat), count: this.getCategoryCount(cat) }))
      .sort((a, b) => b.total - a.total);
  }

  get selectedCategoryExpenses(): any[] {
    if (!this.selectedCategoryGroup) return [];
    return this.filteredExpenses
      .filter(e => e.category === this.selectedCategoryGroup)
      .slice()
      .sort((a, b) => byNewestFirst(a.transaction_date, b.transaction_date, a.expense_id, b.expense_id));
  }

  get selectedCategoryTotal(): number {
    return this.selectedCategoryExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  openCategoryGroup(category: string) {
    this.selectedCategoryGroup = category;
  }

  closeCategoryGroup() {
    this.selectedCategoryGroup = null;
  }

  // ── FORM ──────────────────────────────────────────────────

  openAddForm() {
    this.showForm = true;
    this.isEditing = false;
    this.editingId = null;
    this.expenseForm = {
      transaction_date: toLocalDateString(),
      description: '',
      amount: 0,
      category: this.selectedCategoryGroup || '',
      payment_type: 'cash',
      payment_source: 'cash',
      bank_id: null,
      notes: ''
    };
    this.errorMessage = '';
  }

  editExpense(expense: any) {
    this.showForm = true;
    this.isEditing = true;
    this.editingId = expense.expense_id;
    this.expenseForm = {
      transaction_date: expense.transaction_date,
      description: expense.description,
      amount: expense.amount,
      category: expense.category || '',
      payment_type: expense.payment_type || 'cash',
      payment_source: expense.payment_source === 'bank' ? 'bank' : 'cash',
      bank_id: expense.bank_id ?? null,
      notes: expense.notes || ''
    };
    this.errorMessage = '';
  }

  closeForm() {
    this.showForm = false;
    this.isEditing = false;
    this.editingId = null;
  }

  async saveExpense() {
    if (!this.expenseForm.description.trim()) {
      this.errorMessage = 'Description is required';
      return;
    }
    if (!this.expenseForm.amount || this.expenseForm.amount <= 0) {
      this.errorMessage = 'Please enter a valid amount';
      return;
    }
    if (!this.expenseForm.category) {
      this.errorMessage = 'Please select a category';
      return;
    }
    // Bank with no account chosen is REFUSED, not quietly saved as cash: a bank
    // expense that never reaches a bank account is the whole defect this
    // records. Only on a paid expense -- an unpaid one has no source to give.
    if ((this.expenseForm.payment_type || 'cash') === 'cash') {
      const bankErr = bankSourceError(this.expenseForm, this.houseBanks);
      if (bankErr) {
        this.errorMessage = bankErr;
        return;
      }
    }

    this.isSubmitting = true;
    this.errorMessage = '';

    try {
      const bank = this.bankFieldsFor(this.expenseForm);
      // Both report failure in `.success` rather than throwing, so without
      // these checks a refused write -- an overdrawn account, most of all --
      // closed the form and reloaded as if the expense had been saved.
      const result = (this.isEditing && this.editingId)
        ? await this.db.updateExpense(this.editingId, {
            transaction_date: this.expenseForm.transaction_date,
            description: this.expenseForm.description,
            amount: this.expenseForm.amount,
            category: this.expenseForm.category,
            payment_type: this.expenseForm.payment_type,
            notes: this.expenseForm.notes,
            ...bank
          })
        : await this.db.addExpense({
            farm_id: this.currentFarm.farm_id,
            transaction_date: this.expenseForm.transaction_date,
            description: this.expenseForm.description,
            amount: this.expenseForm.amount,
            category: this.expenseForm.category,
            payment_type: this.expenseForm.payment_type,
            notes: this.expenseForm.notes,
            ...bank
          });
      if (!result?.success) {
        this.errorMessage = (result?.error || 'The database refused the change.') +
          ' Nothing was saved.';
        return;
      }
      this.closeForm();
      await Promise.all([this.loadExpenses(), this.loadHouseBanks()]);
    } catch (err: any) {
      this.errorMessage = 'Failed to save expense: ' + err.message;
    } finally {
      this.isSubmitting = false;
      this.cdr.detectChanges();
    }
  }

  // ── DELETE ─────────────────────────────────────────────────

  confirmDelete(id: number) {
    this.deletingId = id;
    this.showDeleteCodeDialog = true;
  }

  onDeleteCodeVerified() {
    this.showDeleteCodeDialog = false;
    this.showDeleteDialog = true;
  }

  onDeleteCodeCancelled() {
    this.showDeleteCodeDialog = false;
    this.deletingId = null;
  }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    try {
      const res = await this.db.deleteExpense(this.deletingId);
      if (!res?.success) {
        this.errorMessage = 'Failed to delete expense: ' +
          (res?.error || 'the database refused the change.') + ' Nothing was removed.';
        return;
      }
      this.showDeleteDialog = false;
      this.deletingId = null;
      await Promise.all([this.loadExpenses(), this.loadHouseBanks()]);
    } catch (err: any) {
      this.errorMessage = 'Failed to delete expense: ' + err.message;
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  // ── PDF REPORT ────────────────────────────────────────────

  async printReport() {
    const doc = new jsPDF('p', 'mm', 'a4');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];
    const farmName = this.currentFarm?.farm_name || 'Farm';
    const today = toLocalDateString();
    const margin = 14;
    const pageWidth = pw - (margin * 2);

    let y = 20;

    // ── HEADER ──────────────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...B);
    doc.text(farmName.toUpperCase(), pw / 2, y, { align: 'center' });
    y += 8;

    doc.setFontSize(14);
    doc.setTextColor(...B);
    doc.text('EXPENSE LEDGER REPORT', pw / 2, y, { align: 'center' });
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...G);
    doc.text(`Report Date: ${today}`, margin, y);
    doc.text(`Farm ID: ${this.currentFarm?.farm_id || ''}`, pw - margin, y, { align: 'right' });
    y += 10;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;

    // ── SUMMARY ──────────────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text('SUMMARY', margin, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Total Expenses: Rs. ${this.getTotalExpenses().toLocaleString()}`, margin + 5, y);
    y += 5;
    doc.text(`Total Entries: ${this.filteredExpenses.length}`, margin + 5, y);
    y += 8;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;

    // ── CATEGORY BREAKDOWN ──────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...B);
    doc.text('CATEGORY BREAKDOWN', margin, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const cat of this.categories) {
      const total = this.getCategoryTotal(cat);
      if (total > 0) {
        const count = this.getCategoryCount(cat);
        doc.text(`${cat}: Rs. ${total.toLocaleString()} (${count} entries)`, margin + 5, y);
        y += 5;
      }
    }
    y += 8;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;

    // ── TABLE ──────────────────────────────────────────────
    const tableData = this.filteredExpenses.map((e: any) => [
      e.transaction_date || '',
      e.category || '—',
      e.description || '—',
      // The account, not just the status — a printed statement has to say which
      // bank the money came out of, the same way the Supplier Ledger's does.
      e.payment_source === 'bank'
        ? 'Bank — ' + this.bankNameOf(e.bank_id)
        : (e.payment_type === 'cash' ? 'Cash' : 'Credit'),
      'Rs. ' + (e.amount || 0).toLocaleString(),
      e.notes || ''
    ]);

    autoTable(doc, {
      startY: y,
      head: [['Date', 'Category', 'Description', 'Payment', 'Amount', 'Notes']],
      body: tableData.length > 0 ? tableData : [['No expenses found', '', '', '', '', '']],
      theme: 'striped',
      headStyles: {
        fontStyle: 'bold',
        fontSize: 8,
        fillColor: [26, 92, 56],
        textColor: [255, 255, 255],
        halign: 'center'
      },
      bodyStyles: {
        fontSize: 8,
        textColor: [0, 0, 0]
      },
      alternateRowStyles: {
        fillColor: [245, 245, 245]
      },
      margin: { left: margin, right: margin },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 25 },
        2: { cellWidth: 40 },
        3: { cellWidth: 22 },
        4: { cellWidth: 25, halign: 'right' },
        5: { cellWidth: 30 }
      },
      tableWidth: pageWidth,
      styles: {
        overflow: 'linebreak',
        cellPadding: 3
      },
      // jspdf-autotable only applies columnStyles to the body section — the head
      // cell otherwise keeps headStyles' halign, so a right-aligned amount column's
      // header sits centered while its values sit right.
      didParseCell: alignHeadFootWithColumnStyles,
      didDrawPage: (data: any) => {
        const pageNumber = (doc as any).internal.getCurrentPageInfo().pageNumber;
        const totalPages = (doc as any).internal.getNumberOfPages();
        doc.setFontSize(7);
        doc.setTextColor(...G);
        doc.text(`Page ${pageNumber} of ${totalPages}`, pw / 2, ph - 8, { align: 'center' });
      }
    });

    const finalY = (doc as any).lastAutoTable.finalY + 8;

    // ── FOOTER ──────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(...G);
    const footer = 'Generated by: www.devinfantary.com  |  Contact: 0302 6938217';
    doc.text(footer, pw / 2, ph - 4, { align: 'center' });

    await this.printPdf(doc, `Expense_Report_${today}.pdf`);
  }

  private async printPdf(doc: jsPDF, filename: string) {
    try {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1];
      const result = await printPdfBase64(base64);
      if (!result || !result.success) {
        console.error('Print failed, falling back to save:', result?.error);
        doc.save(filename);
      }
    } catch (e) {
      console.error('Print error, falling back to save:', e);
      doc.save(filename);
    }
  }
}