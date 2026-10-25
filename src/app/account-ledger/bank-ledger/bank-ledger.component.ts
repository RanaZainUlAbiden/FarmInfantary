import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { DatabaseService } from '../../shared/services/database.service';
import { AuthService } from '../../shared/services/auth.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { friendlySqlError } from '../../shared/utils/sql-error.util';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles, getTableRightEdge } from '../../shared/utils/pdf-table.util';
import { DeleteCodeDialogComponent } from '../../shared/components/delete-code-dialog/delete-code-dialog.component';

import { toLocalDateString } from '../../shared/utils/date.util';
import { BackLinkComponent } from '../../shared/components/back-link/back-link.component';

import { printPdfBase64 } from '../../shared/utils/browser-print.util';
@Component({
  selector: 'app-bank-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, BackLinkComponent],
  templateUrl: './bank-ledger.component.html',
  styleUrl: './bank-ledger.component.scss'
})
/**
 * One screen serving two routes, told apart by the route's `bankScope` data.
 *
 *   'customer'  Distribution > Bank Ledger — the accounts belonging to
 *               customers, each linked to a `customers` row.
 *   'house'     Overview > Bank — the owner's OWN accounts, the ones with no
 *               customer_id at all. He adds, edits and deletes these himself,
 *               deposits and withdraws against them, and they are the accounts
 *               an asset payment can be drawn from.
 *
 * Both read the same `bank_accounts`/`bank_ledger` tables; the scope is a
 * filter on `customer_id`, not a second bank system. Everything below that
 * differs — whether a customer is required, which columns show, whether an
 * account may be deleted — hangs off `isHouse`, so the two never fork.
 */
export class BankLedgerComponent implements OnInit {
  currentFarm: any = null;
  customers: any[] = [];
  bankAccounts: any[] = [];

  /** True on the Overview route: the owner's own accounts, no customer. */
  isHouse = false;
  selectedBank: any = null;
  ledgerEntries: any[] = [];
  filteredLedgerEntries: any[] = [];
  isLoading = true;
  errorMessage = '';
  
  // ── SEARCH ──────────────────────────────────────────────
  transactionNumberSearch: string = '';
  
  // Bank form
  showBankForm = false;
  isEditingBank = false;
  editingBankId: number | null = null;
  bankForm: any = {
    customer_id: null,
    bank_name: '',
    account_number: '',
    account_holder: '',
    opening_balance: 0
  };
  
  // Transaction form
  showTransactionForm = false;
  transactionType: 'deposit' | 'withdrawal' = 'deposit';
  transactionAmount: number = 0;
  transactionDate: string = '';
  transactionNote: string = '';
  isSubmitting = false;
  
  showDeleteDialog = false;
  showDeleteCodeDialog: boolean = false;
  deletingId: number | null = null;
  deleteType: 'bank' | 'entry' = 'bank';

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.transactionDate = toLocalDateString();
    this.isHouse = this.route.snapshot.data['bankScope'] === 'house';

    if (this.isHouse) {
      // House accounts belong to nobody, so there is no customer list to load
      // and no ?customerId= hand-off from Customer Management to honour.
      this.loadBanks();
      return;
    }

    this.loadCustomers().then(() => {
      this.loadBanks();
    });

    this.route.queryParams.subscribe(params => {
      const customerId = params['customerId'];
      if (customerId) {
        this.bankForm.customer_id = Number(customerId);
        setTimeout(() => {
          this.openBankForm();
        }, 600);
      }
    });
  }

  // ── LOAD METHODS ──────────────────────────────────────────

  async loadCustomers() {
    try {
      // Own-farm customers are excluded: a bank account belongs to a real
      // customer who pays by transfer. One of the owner's own farms settles by
      // being marked paid on its bill, never out of a customer bank balance.
      const result = await this.db.get(
        `SELECT customer_id, customer_name FROM customers
         WHERE farm_id = ? AND COALESCE(customer_type,'external') <> 'own_farm'
         ORDER BY customer_name ASC`,
        [this.currentFarm.farm_id]
      );
      if (result.success) {
        this.customers = result.data || [];
        console.log(`✅ Loaded ${this.customers.length} customers`);
      }
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  }

  async loadBanks() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      const result = await this.db.getBankAccounts(
        this.currentFarm.farm_id, this.isHouse ? 'house' : 'customer'
      );
      if (result.success) {
        this.bankAccounts = result.data || [];
        for (const bank of this.bankAccounts) {
          const customer = this.customers.find(c => c.customer_id === bank.customer_id);
          bank.customer_name = customer ? customer.customer_name : '—';
        }
        console.log(`✅ Loaded ${this.bankAccounts.length} bank accounts`);
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load bank accounts: ' + error.message;
      console.error('Error loading banks:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadBankDetail(bankId: number) {
    this.isLoading = true;
    this.errorMessage = '';
    this.selectedBank = null;
    this.ledgerEntries = [];
    this.filteredLedgerEntries = [];
    this.transactionNumberSearch = '';
    
    try {
      const bank = await this.db.getBankAccount(bankId);
      if (bank) {
        const customer = this.customers.find(c => c.customer_id === bank.customer_id);
        bank.customer_name = customer ? customer.customer_name : '—';
        this.selectedBank = bank;
        
        const ledgerResult = await this.db.getBankLedgerWithBalance(bankId);
        if (ledgerResult.success) {
          this.ledgerEntries = ledgerResult.data || [];
          this.filteredLedgerEntries = [...this.ledgerEntries];
          console.log(`✅ Loaded ${this.ledgerEntries.length} ledger entries for bank ${bankId}`);
        }
      } else {
        this.errorMessage = 'Bank account not found';
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load bank details: ' + error.message;
      console.error('Error loading bank detail:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  selectBank(bank: any) {
    this.selectedBank = bank;
    this.loadBankDetail(bank.bank_id);
  }

  goBack() {
    this.selectedBank = null;
    this.ledgerEntries = [];
    this.filteredLedgerEntries = [];
    this.transactionNumberSearch = '';
    this.loadBanks();
  }

  // ── SEARCH / FILTER ──────────────────────────────────────

  filterLedger() {
    const term = this.transactionNumberSearch.trim().toLowerCase();
    if (!term) {
      this.filteredLedgerEntries = [...this.ledgerEntries];
      return;
    }
    this.filteredLedgerEntries = this.ledgerEntries.filter(e =>
      (e.transaction_number && e.transaction_number.toLowerCase().includes(term)) ||
      (e.description && e.description.toLowerCase().includes(term))
    );
    this.cdr.detectChanges();
  }

  clearTransactionSearch() {
    this.transactionNumberSearch = '';
    this.filteredLedgerEntries = [...this.ledgerEntries];
    this.cdr.detectChanges();
  }

  // ── CALCULATION METHODS ──────────────────────────────────

  getTotalBalance(): number {
    return this.bankAccounts.reduce((sum, b) => sum + (b.current_balance || 0), 0);
  }

  getBankBalance(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (Number(e.debit) || 0) - (Number(e.credit) || 0), 0);
  }

  getTotalDeposits(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (e.debit || 0), 0);
  }

  getTotalWithdrawals(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (e.credit || 0), 0);
  }

  /** House accounts are the owner's own money; customer accounts are theirs. */
  get screenTitle(): string {
    return this.isHouse ? 'Bank Accounts' : 'Bank Ledger';
  }

  getCustomerName(customerId: number): string {
    if (!customerId) return '—';
    const customer = this.customers.find(c => c.customer_id === customerId);
    return customer ? customer.customer_name : '—';
  }

  // ── Bank Account CRUD ─────────────────────────────────────

  openBankForm(bank?: any) {
    this.showBankForm = true;
    if (bank) {
      this.isEditingBank = true;
      this.editingBankId = bank.bank_id;
      this.bankForm = {
        customer_id: bank.customer_id || null,
        bank_name: bank.bank_name,
        account_number: bank.account_number || '',
        account_holder: bank.account_holder || '',
        opening_balance: bank.opening_balance || 0
      };
    } else {
      this.isEditingBank = false;
      this.editingBankId = null;
      this.bankForm = {
        customer_id: this.bankForm.customer_id || null,
        bank_name: '',
        account_number: '',
        account_holder: '',
        opening_balance: 0
      };
    }
  }

  closeBankForm() {
    this.showBankForm = false;
    this.isEditingBank = false;
    this.editingBankId = null;
  }

  async saveBank() {
    if (!this.bankForm.bank_name.trim()) {
      this.errorMessage = 'Bank name is required';
      this.cdr.detectChanges();
      return;
    }

    // A customer is required on the Distribution route and must NOT be set on
    // the Overview one — a house account with a customer_id would vanish from
    // this screen and reappear as that customer's account.
    if (!this.isHouse && !this.bankForm.customer_id) {
      this.errorMessage = 'Please select a customer';
      this.cdr.detectChanges();
      return;
    }
    const customerId = this.isHouse ? null : this.bankForm.customer_id;

    this.isSubmitting = true;
    this.errorMessage = '';

    try {
      if (this.isEditingBank && this.editingBankId) {
        const updateResult = await this.db.updateBankAccount(this.editingBankId, {
          bank_name: this.bankForm.bank_name,
          account_number: this.bankForm.account_number,
          account_holder: this.bankForm.account_holder
        });
        if (updateResult && updateResult.success === false) {
          this.errorMessage = friendlySqlError(updateResult.error, 'Failed to save bank account.');
          this.cdr.detectChanges();
          return;
        }
      } else {
        const addResult = await this.db.addBankAccount({
          farm_id: this.currentFarm.farm_id,
          customer_id: customerId,
          bank_name: this.bankForm.bank_name,
          account_number: this.bankForm.account_number,
          account_holder: this.bankForm.account_holder,
          opening_balance: this.bankForm.opening_balance || 0
        });

        if (addResult && addResult.success === false) {
          this.errorMessage = friendlySqlError(addResult.error, 'Failed to save bank account.');
          this.cdr.detectChanges();
          return;
        }
        // addBankAccount already links the customer; this is the older explicit
        // call kept for the Distribution route and skipped when there is nobody
        // to link to.
        if (customerId && addResult && addResult.lastId) {
          await this.db.linkCustomerToBank(customerId, addResult.lastId);
        }
      }

      this.closeBankForm();
      await this.loadBanks();

    } catch (error: any) {
      this.errorMessage = 'Failed to save bank: ' + error.message;
      console.error('Error saving bank:', error);
    } finally {
      this.isSubmitting = false;
      this.cdr.detectChanges();
    }
  }

  // ── GENERATE TRANSACTION NUMBER ──────────────────────────

  async generateTransactionNumber(bankId: number, type: 'deposit' | 'withdrawal'): Promise<string> {
    const prefix = type === 'deposit' ? 'DEP' : 'WD';
    const result = await this.db.get(
      `SELECT transaction_number FROM bank_ledger 
       WHERE bank_id = ? AND transaction_number LIKE ? 
       ORDER BY ledger_id DESC LIMIT 1`,
      [bankId, prefix + '-%']
    );
    let lastNumber = 0;
    if (result.success && result.data && result.data.length > 0) {
      const last = result.data[0].transaction_number;
      const parts = last.split('-');
      if (parts.length === 2) {
        lastNumber = parseInt(parts[1], 10) || 0;
      }
    }
    const nextNumber = lastNumber + 1;
    return `${prefix}-${String(nextNumber).padStart(4, '0')}`;
  }

  // ── Transactions ──────────────────────────────────────────

  openTransactionForm(type: 'deposit' | 'withdrawal') {
    this.transactionType = type;
    this.showTransactionForm = true;
    this.transactionAmount = 0;
    this.transactionDate = toLocalDateString();
    this.transactionNote = '';
    this.errorMessage = '';
  }

  closeTransactionForm() {
    this.showTransactionForm = false;
    this.transactionAmount = 0;
    this.transactionNote = '';
  }

  async submitTransaction() {
    if (!this.transactionAmount || this.transactionAmount <= 0) {
      this.errorMessage = 'Please enter a valid amount';
      this.cdr.detectChanges();
      return;
    }

    this.isSubmitting = true;
    this.errorMessage = '';

    try {
      const isDeposit = this.transactionType === 'deposit';
      
      // 🔥 Generate transaction number
      const transactionNumber = await this.generateTransactionNumber(
        this.selectedBank.bank_id,
        this.transactionType
      );

      // addBankLedgerEntry reports a failed write in `.success` — it does not
      // throw — so the catch below never sees one. Discarding this result closed
      // the form on a deposit or withdrawal that never reached the database.
      const result = await this.db.addBankLedgerEntry({
        bank_id: this.selectedBank.bank_id,
        transaction_date: this.transactionDate,
        description: this.transactionNote || (isDeposit ? 'Deposit' : 'Withdrawal'),
        debit: isDeposit ? this.transactionAmount : 0,
        credit: isDeposit ? 0 : this.transactionAmount,
        reference_type: this.transactionType,
        transaction_number: transactionNumber  // 🔥 Pass the generated number
      });

      if (!result?.success) {
        this.errorMessage =
          'Failed to record transaction: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was recorded.';
        return;
      }

      this.closeTransactionForm();
      await this.loadBankDetail(this.selectedBank.bank_id);
    } catch (error: any) {
      this.errorMessage = 'Failed to record transaction: ' + error.message;
      console.error('Error recording transaction:', error);
    } finally {
      this.isSubmitting = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ─────────────────────────────────────────────────

  confirmDelete(id: number, type: 'bank' | 'entry') {
    this.deletingId = id;
    this.deleteType = type;
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

  /**
   * A ledger row may only be deleted from here if this screen is what wrote it.
   * Entries mirroring something else — an asset installment paid by bank —
   * belong to that record: removing one here would leave the payment claiming
   * money left the account while the balance said it never did. Those are
   * reversed by deleting the payment itself, on the Assets screen.
   */
  canDeleteEntry(entry: any): boolean {
    const ref = (entry?.reference_type || '').toString();
    return ref === '' || ref === 'deposit' || ref === 'withdrawal' || ref === 'opening';
  }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;

    try {
      if (this.deleteType === 'bank') {
        const result = await this.db.deleteBankAccount(this.deletingId);
        this.showDeleteDialog = false;
        if (result && result.success === false) {
          this.errorMessage = friendlySqlError(result.error, 'Failed to delete bank account.');
          this.deletingId = null;
          this.cdr.detectChanges();
          return;
        }
        this.deletingId = null;
        await this.loadBanks();
      } else {
        // The delete and the balance rebuild are one batch: a balance left
        // behind by a row that is gone is the drift this whole screen exists
        // to report.
        const bankId = this.selectedBank.bank_id;
        const result = await this.db.runBatch([
          { sql: 'DELETE FROM bank_ledger WHERE ledger_id = ?', params: [this.deletingId] },
          {
            sql: `UPDATE bank_accounts SET current_balance =
                    (SELECT COALESCE(SUM(debit - credit), 0) FROM bank_ledger WHERE bank_id = ?)
                  WHERE bank_id = ?`,
            params: [bankId, bankId]
          }
        ]);
        this.showDeleteDialog = false;
        this.deletingId = null;
        if (result && result.success === false) {
          this.errorMessage = friendlySqlError(result.error, 'Failed to delete transaction.');
          this.cdr.detectChanges();
          return;
        }
        await this.loadBankDetail(bankId);
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to delete: ' + error.message;
      console.error('Error deleting:', error);
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  // ── PROFESSIONAL PDF REPORT ──────────────────────────────

  async printReport() {
    if (!this.selectedBank) return;
    
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
    doc.text(this.isHouse ? 'BANK ACCOUNT STATEMENT' : 'BANK LEDGER REPORT', pw / 2, y, { align: 'center' });
    y += 8;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...G);
    doc.text(`Report Date: ${today}`, margin, y);
    doc.text(`Farm ID: ${this.currentFarm?.farm_id || ''}`, pw - margin, y, { align: 'right' });
    y += 10;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── BANK INFO ──────────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text('Bank Details', margin, y);
    y += 6;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...B);
    doc.text(`Bank: ${this.selectedBank.bank_name}`, margin, y);
    // A house account has no customer; printing "Customer: N/A" on the owner's
    // own statement reads as missing data rather than as it not applying.
    if (!this.isHouse) {
      doc.text(`Customer: ${this.selectedBank.customer_name || 'N/A'}`, margin + 70, y);
    }
    y += 5;
    doc.text(`Account #: ${this.selectedBank.account_number || 'N/A'}`, margin, y);
    doc.text(`Account Holder: ${this.selectedBank.account_holder || 'N/A'}`, margin + 70, y);
    y += 5;
    doc.text(`Current Balance: Rs. ${this.getBankBalance().toLocaleString()}`, margin, y);
    y += 10;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── TABLE ──────────────────────────────────────────────
    const tableData = this.ledgerEntries.map((entry: any) => [
      entry.transaction_date || '',
      entry.transaction_number || '—',
      entry.description || '—',
      entry.debit > 0 ? 'Rs. ' + entry.debit.toLocaleString() : '—',
      entry.credit > 0 ? 'Rs. ' + entry.credit.toLocaleString() : '—',
      'Rs. ' + (entry.balance || 0).toLocaleString()
    ]);
    
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Transaction #', 'Description', 'Deposit', 'Withdrawal', 'Balance']],
      body: tableData.length > 0 ? tableData : [['No transactions found', '', '', '', '', '']],
      theme: 'striped',
      headStyles: { 
        fontStyle: 'bold', 
        fontSize: 8, 
        fillColor: [13, 71, 161], 
        textColor: [255, 255, 255],
        halign: 'center'
      },
      bodyStyles: { 
        fontSize: 8, 
        textColor: [0, 0, 0],
        halign: 'center'
      },
      alternateRowStyles: {
        fillColor: [245, 245, 245]
      },
      margin: { left: margin, right: margin },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 30 },
        2: { cellWidth: 40 },
        3: { cellWidth: 28, halign: 'right' },
        4: { cellWidth: 30, halign: 'right' },
        5: { cellWidth: 35, halign: 'right' }
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
    const bankTableRight = getTableRightEdge(doc);

    // ── SUMMARY ─────────────────────────────────────────────
    if (finalY < ph - 40) {
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, finalY, pw - margin, finalY);
      y = finalY + 8;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...B);
      doc.text('SUMMARY', margin, y);
      y += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Total Deposits: Rs. ${this.getTotalDeposits().toLocaleString()}`, bankTableRight, y, { align: 'right' });
      y += 5;
      doc.text(`Total Withdrawals: Rs. ${this.getTotalWithdrawals().toLocaleString()}`, bankTableRight, y, { align: 'right' });
      y += 5;
      doc.text(`Current Balance: Rs. ${this.getBankBalance().toLocaleString()}`, bankTableRight, y, { align: 'right' });
      y += 10;
    }
    
    // ── FOOTER ──────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(...G);
    const footer = 'Generated by: www.devinfantary.com  |  Contact: 0302 6938217';
    doc.text(footer, pw / 2, ph - 4, { align: 'center' });
    
    await this.printPdf(doc, `Bank_Ledger_${this.selectedBank.bank_name}_${today}.pdf`);
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
