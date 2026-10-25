import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { paymentSourceLabel } from '../shared/utils/bank-source.util';

@Component({
  selector: 'app-account-ledger',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './account-ledger.component.html',
  styleUrl: './account-ledger.component.scss'
})
export class AccountLedgerComponent implements OnInit {
  currentFarm: any = null;
  isLoading = true;
  errorMessage = '';
  
  customerStats = { total: 0, outstanding: 0 };
  supplierStats = { total: 0, outstanding: 0, purchased: 0, paid: 0 };
  bankStats = { total: 0, balance: 0 };

  recentCustomers: any[] = [];
  recentSuppliers: any[] = [];
  /** Which account supplier payments were made from — the client's question. */
  supplierPaymentAccounts: any[] = [];

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadDashboard();
  }

  async loadDashboard() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      // ── Load Customer Stats ──────────────────────────────
      // Own-farm customers are INCLUDED here deliberately. This is the
      // distribution business's accounts dashboard, and one of the owner's own
      // farms that has been supplied stock and not settled owes it money in
      // exactly the way an outside customer does — leaving them out would
      // understate what the business is owed. The screens that let you SELL to a
      // customer, edit one, or attach a bank account to one all filter them out.
      const customers = await this.db.getAllCustomersWithBalance(this.currentFarm.farm_id);
      if (customers.success && customers.data) {
        this.recentCustomers = customers.data.slice(0, 5);
        this.customerStats.total = customers.data.length;
        this.customerStats.outstanding = customers.data.reduce((sum: number, c: any) => sum + (c.outstanding_balance || 0), 0);
      }

      // ── Load Supplier Stats ──────────────────────────────
      // 🔥 FIX: Use getAllSuppliersWithBalance to get real outstanding balances
      //
      // `outstanding_balance` is `SUM(credit - debit)` over `supplier_ledger`,
      // derived on every read — there is no `suppliers.outstanding_balance` and
      // there must never be one. `total_purchased` / `total_paid` come off the
      // same rows in the same query, so the card cannot disagree with the
      // Supplier Ledger screen behind it.
      const suppliers = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      if (suppliers.success && suppliers.data) {
        this.recentSuppliers = suppliers.data.slice(0, 5);
        this.supplierStats.total = suppliers.data.length;
        // 🔥 FIX: Sum the outstanding_balance from each supplier
        this.supplierStats.outstanding = suppliers.data.reduce((sum: number, s: any) => sum + (s.outstanding_balance || 0), 0);
        this.supplierStats.purchased = suppliers.data.reduce((sum: number, s: any) => sum + (Number(s.total_purchased) || 0), 0);
        this.supplierStats.paid = suppliers.data.reduce((sum: number, s: any) => sum + (Number(s.total_paid) || 0), 0);
      }

      // "Account ledger supplier ka option bhi ke kis bank ki hai payment
      // kitni" — what was paid to suppliers, split by the account it came out
      // of. Cash lands in its own row; a return is not in here at all, because
      // it is stock sent back rather than money paid.
      const supplierAccounts = await this.db.getSupplierPaymentsByAccount(this.currentFarm.farm_id);
      if (supplierAccounts.success && supplierAccounts.data) {
        this.supplierPaymentAccounts = supplierAccounts.data;
      }

      // ── Load Bank Stats ──────────────────────────────────
      // Customer accounts only. This card opens `bank-ledger`, which lists
      // exactly those, so counting the owner's own house accounts here would
      // put a total on the card that the screen behind it cannot account for.
      // The house accounts are summarised on their own screen, Overview > Bank.
      const banks = await this.db.getBankAccounts(this.currentFarm.farm_id, 'customer');
      if (banks.success && banks.data) {
        this.bankStats.total = banks.data.length;
        this.bankStats.balance = banks.data.reduce((sum: number, b: any) => sum + (b.current_balance || 0), 0);
      }

      console.log('✅ Account Ledger Stats:', {
        customers: this.customerStats,
        suppliers: this.supplierStats,
        banks: this.bankStats
      });

    } catch (error: any) {
      this.errorMessage = 'Failed to load dashboard: ' + error.message;
      console.error('Dashboard error:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  /** 'Cash' or 'Bank · <account>' — never a cash/credit test. */
  accountLabel(row: any): string {
    return paymentSourceLabel(row);
  }

  navigateTo(route: string) {
    this.router.navigate(['/app', route]);
  }

  viewCustomerLedger(customerId: number) {
    this.router.navigate(['/app/customer-ledger', customerId]);
  }

  viewSupplierLedger(supplierId: number) {
    this.router.navigate(['/app/supplier-ledger', supplierId]);
  }

  /** Straight into one supplier's account view, the entity-based screen. */
  viewSupplierAccount(supplierId: number) {
    this.router.navigate(['/app/supplier-accounts', supplierId]);
  }
}