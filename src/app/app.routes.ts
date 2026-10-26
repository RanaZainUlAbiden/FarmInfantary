import { Routes } from '@angular/router';
import { sessionGuard, signedInGuard, adminGuard, teamGuard } from './shared/guards/session.guard';
import { FlockHealthResolver } from './shared/resolvers/flock-health.resolver';
import { LedgerResolver } from './shared/resolvers/ledger.resolver';
import { ExpensesResolver } from './shared/resolvers/expenses.resolver';
import { MedicineResolver } from './shared/resolvers/medicine.resolver';
import { FeedResolver } from './shared/resolvers/feed.resolver';
import { ChicksResolver } from './shared/resolvers/chicks.resolver';
import { LabourResolver } from './shared/resolvers/labour.resolver';
import { SaleResolver } from './shared/resolvers/sale.resolver';
import { IncomeResolver } from './shared/resolvers/income.resolver';
import { BalanceResolver } from './shared/resolvers/balance.resolver';

export const routes: Routes = [
  // The desktop opened on an ACTIVATION screen — a machine-bound licence key
  // had to be entered before anything else. That has no meaning on the web
  // (docs/DECISIONS.md D11), so the app opens on login instead and the
  // activation route is gone.
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full'
  },
  {
    path: 'splash',
    loadComponent: () =>
      import('./splash/splash.component')
        .then(m => m.SplashComponent)
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./auth/login/login.component')
        .then(m => m.LoginComponent)
  },
  {
    path: 'app',
    canActivate: [sessionGuard],
    canActivateChild: [sessionGuard],
    loadComponent: () =>
      import('./layout/layout.component')
        .then(m => m.LayoutComponent),
    children: [
      {path:'brokers',loadComponent:()=>import('./brokers/brokers.component').then(m=>m.BrokersComponent)},
      {
        path: '',
        redirectTo: 'flock-health',
        pathMatch: 'full'
      },
      {
        path: 'flock-health',
        loadComponent: () =>
          import('./flock-health/flock-health.component')
            .then(m => m.FlockHealthComponent),
        resolve: { data: FlockHealthResolver }
      },
      {
        path: 'expenses',
        loadComponent: () =>
          import('./expenses/expenses.component')
            .then(m => m.ExpensesComponent),
        resolve: { data: ExpensesResolver }
      },
      {
        path: 'ledger',
        loadComponent: () =>
          import('./ledger/ledger.component')
            .then(m => m.LedgerComponent),
        resolve: { data: LedgerResolver }
      },
      {
        path: 'medicine',
        loadComponent: () =>
          import('./medicine/medicine.component')
            .then(m => m.MedicineComponent),
        resolve: { data: MedicineResolver }
      },
       {
        path: 'labour',
        loadComponent: () =>
          import('./labour/labour.component').then(m => m.LabourComponent),
        resolve: { data: LabourResolver }
      },
      {
        path: 'feed',
        loadComponent: () =>
          import('./feed/feed.component')
            .then(m => m.FeedComponent),
        resolve: { data: FeedResolver }
      },
      // Chicks — the same shape as feed and medicine: a purchased input with
      // a supplier, recorded here or sent over from Distribution. Registered
      // once; the screen reads the active flock/batch like its siblings.
      {
        path: 'chicks',
        loadComponent: () =>
          import('./chicks/chicks.component')
            .then(m => m.ChicksComponent),
        resolve: { data: ChicksResolver }
      },
      {
        path: 'vaccination',
        loadComponent: () =>
          import('./vaccination/vaccination.component')
            .then(m => m.VaccinationComponent)
      },
      {
        path: 'sale',
        loadComponent: () =>
          import('./sale/sale.component')
            .then(m => m.SaleComponent),
        resolve: { data: SaleResolver }
      },
      {
        path: 'income',
        loadComponent: () =>
          import('./income/income.component')
            .then(m => m.IncomeComponent),
        resolve: { data: IncomeResolver }
      },
      {
        path: 'balance',
        loadComponent: () =>
          import('./balance/balance.component')
            .then(m => m.BalanceComponent),
        resolve: { data: BalanceResolver }
      },
      // No resolver — the Report screen loads its own data in ngOnInit. Its
      // resolver's queries had drifted out of step with the screen's own
      // (no module_type guard), so which totals you got depended on how you
      // arrived. See ReportComponent.loadData().
      {
        path: 'report',
        loadComponent: () =>
          import('./report/report.component')
            .then(m => m.ReportComponent)
      },
      // Farm Report — one route, reached from BOTH the broiler and the layer
      // menu. The screen reads the active business tab to decide which module
      // it is reporting on, so it must NOT be registered twice.
      {
        path: 'farm-report',
        loadComponent: () =>
          import('./farm-report/farm-report.component')
            .then(m => m.FarmReportComponent)
      },
      {
        path: 'flock-management',
        loadComponent: () =>
          import('./flock-management/flock-management.component')
            .then(m => m.FlockManagementComponent)
      },
      {
        path: 'batch-management',
        loadComponent: () =>
          import('./batch-management/batch-management.component')
            .then(m => m.BatchManagementComponent)
      },
      {
        path: 'egg-collection',
        loadComponent: () =>
          import('./egg-collection/egg-collection.component')
            .then(m => m.EggCollectionComponent)
      },
      {
        path: 'egg-sales',
        loadComponent: () =>
          import('./egg-sales/egg-sales.component')
            .then(m => m.EggSalesComponent)
      },
      {
        path: 'hen-sales',
        loadComponent: () =>
          import('./hen-sales/hen-sales.component').then(m => m.HenSalesComponent)
      },
      {
        path: 'layer-expenses',
        loadComponent: () =>
          import('./layer-expenses/layer-expenses.component')
            .then(m => m.LayerExpensesComponent)
      },
      // Layer Flock Health — replaces the old layer-mortality screen, which recorded
      // mortality alone. Registered once, here in the layer block; `vaccination` a
      // few lines up is already registered in the broiler block above and must not
      // be duplicated the way it currently is.
      {
        path: 'layer-flock-health',
        loadComponent: () =>
          import('./layer-flock-health/layer-flock-health.component')
            .then(m => m.LayerFlockHealthComponent)
      },
      // The layer module's own ledger book, keyed on batch_id. Registered once,
      // here in the layer block; `ledger` in the broiler block above is the
      // flock-keyed screen and stays separate — see the layer_ledgers comment in
      // electron/database.js.
      {
        path: 'layer-ledger',
        loadComponent: () =>
          import('./layer-ledger/layer-ledger.component')
            .then(m => m.LayerLedgerComponent)
      },
      {
        path: 'layer-report',
        loadComponent: () =>
          import('./layer-report/layer-report.component')
            .then(m => m.LayerReportComponent)
      },
      {
        path: 'farm-units',
        loadComponent: () =>
          import('./farm-units/farm-units.component')
            .then(m => m.FarmUnitsComponent)
      },
      // ── Overview Module Routes (account-wide) ────────────
      {
        path: 'overview',
        loadComponent: () =>
          import('./overview/overview.component')
            .then(m => m.OverviewComponent)
      },
      {
        path: 'assets',
        loadComponent: () =>
          import('./assets/assets.component')
            .then(m => m.AssetsComponent)
      },
      // Debt Payment — a NOTEBOOK, connected to nothing. See the class comment
      // in debt-payment.component.ts: no money path, no report, no cascade. No
      // resolver either; it loads in its own ngOnInit like its neighbours.
      {
        path: 'debt-payment',
        loadComponent: () =>
          import('./debt-payment/debt-payment.component')
            .then(m => m.DebtPaymentComponent)
      },
      // Loans and advances — money lent out and money being held for someone
      // else. Account-scoped like assets and personal expenses, and in no
      // delete cascade: closing a flock must not forget a debt. No resolver;
      // it loads in its own ngOnInit, the shape this codebase prefers for any
      // screen whose totals matter.
      {
        path: 'loans',
        loadComponent: () =>
          import('./loans/loans.component')
            .then(m => m.LoansComponent)
      },
      {
        path: 'personal-expenses',
        loadComponent: () =>
          import('./personal-expenses/personal-expenses.component')
            .then(m => m.PersonalExpensesComponent)
      },
      // ── Distribution Module Routes ──────────────────────
      {
        path: 'inventory',
        loadComponent: () => import('./inventory/inventory.component').then(m => m.InventoryComponent)
      },
      {
  path: 'distribution-batch',
  loadComponent: () => import('./distribution-batch/distribution-batch.component').then(m => m.DistributionBatchComponent)
},
      {
        path: 'distribution-batch/:productId',
        loadComponent: () => import('./distribution-batch/distribution-batch.component').then(m => m.DistributionBatchComponent)
      },
      {
        path: 'purchase-orders',
        loadComponent: () => import('./purchase-orders/purchase-orders.component').then(m => m.PurchaseOrdersComponent)
      },
      {
        path: 'sales-orders',
        loadComponent: () => import('./sales-orders/sales-orders.component').then(m => m.SalesOrdersComponent)
      },
      {
        path: 'sales-returns',
        loadComponent: () => import('./sales-returns/sales-returns.component').then(m => m.SalesReturnsComponent)
      },
      {
        path: 'purchase-returns',
        loadComponent: () => import('./purchase-returns/purchase-returns.component').then(m => m.PurchaseReturnsComponent)
      },
      {
        path: 'customer-management',
        loadComponent: () => import('./customer-management/customer-management.component').then(m => m.CustomerManagementComponent)
      },
      {
        path: 'supplier-management',
        loadComponent: () => import('./supplier-management/supplier-management.component').then(m => m.SupplierManagementComponent)
      },
      {
        path: 'labour-management',
        loadComponent: () =>
          import('./labour-management/labour-management.component').then(m => m.LabourManagementComponent)
      },
      {
        path: 'distribution-report',
        loadComponent: () => import('./distribution-report/distribution-report.component').then(m => m.DistributionReportComponent)
      },
      // ── Account Ledger Routes ────────────────────────────
      {
        path: 'account-ledger',
        loadComponent: () => import('./account-ledger/account-ledger.component').then(m => m.AccountLedgerComponent)
      },
      {
        path: 'customer-ledger',
        loadComponent: () => import('./account-ledger/customer-ledger/customer-ledger.component').then(m => m.CustomerLedgerComponent)
      },
      {
        path: 'customer-ledger/:id',
        loadComponent: () => import('./account-ledger/customer-ledger/customer-ledger.component').then(m => m.CustomerLedgerComponent)
      },
      {
        path: 'supplier-ledger',
        loadComponent: () => import('./account-ledger/supplier-ledger/supplier-ledger.component').then(m => m.SupplierLedgerComponent)
      },
      {
        path: 'supplier-ledger/:id',
        loadComponent: () => import('./account-ledger/supplier-ledger/supplier-ledger.component').then(m => m.SupplierLedgerComponent)
      },
      // SUPPLIER ACCOUNTS — the entity view, a SIBLING of the two routes above
      // and not a replacement: Supplier Ledger is the row-by-row statement,
      // this is the party. No resolver on either path; the screen loads its own
      // data in ngOnInit, which is the shape this codebase prefers for any
      // screen whose totals matter.
      {
        path: 'supplier-accounts',
        loadComponent: () => import('./account-ledger/supplier-accounts/supplier-accounts.component').then(m => m.SupplierAccountsComponent)
      },
      {
        path: 'supplier-accounts/:id',
        loadComponent: () => import('./account-ledger/supplier-accounts/supplier-accounts.component').then(m => m.SupplierAccountsComponent)
      },
      // The two bank routes are ONE component, told apart by `bankScope`.
      // bank_accounts and bank_ledger are single farm_id-scoped tables, so
      // these are two windows onto the same rows — not a second bank system.
      // `customer` shows the accounts belonging to customers; `house` shows the
      // owner's own accounts, the ones with no customer_id. See the BANK LEDGER
      // METHODS block in database.service.ts.
      {
        path: 'bank-ledger',
        data: { bankScope: 'customer' },
        loadComponent: () => import('./account-ledger/bank-ledger/bank-ledger.component').then(m => m.BankLedgerComponent)
      },
      {
        path: 'overview-bank-ledger',
        data: { bankScope: 'house' },
        loadComponent: () => import('./account-ledger/bank-ledger/bank-ledger.component').then(m => m.BankLedgerComponent)
      },
      // 🔥 NEW: Expense Ledger
      {
        path: 'expense-ledger',
        loadComponent: () => import('./account-ledger/expense-ledger/expense-ledger.component').then(m => m.ExpenseLedgerComponent)
      },
      // ── Vouchers ─────────────────────────────────────────
      // Shortcuts onto the settlement paths the Customer and Supplier Ledger
      // screens already own. No resolver: each loads in its own ngOnInit, so
      // navigation is the invalidation, and there is no second query that could
      // drift from the screen's own.
      {
        path: 'receive-voucher',
        loadComponent: () => import('./receive-voucher/receive-voucher.component').then(m => m.ReceiveVoucherComponent)
      },
      {
        path: 'payment-voucher',
        loadComponent: () => import('./payment-voucher/payment-voucher.component').then(m => m.PaymentVoucherComponent)
      },
      // ── Internal Settlement ──────────────────────────────
      // The owner's own farm clearing what it owes distribution. Settles
      // through the same `customerSettlementOps()` the two screens above do;
      // no resolver, for the same reason they have none.
      {
        path: 'internal-settlement',
        loadComponent: () => import('./internal-settlement/internal-settlement.component').then(m => m.InternalSettlementComponent)
      }
    ]
  },
  // ── Fallback Routes (Outside App) ──────────────────────
  {path:'admin',canActivate:[adminGuard],loadComponent:()=>import('./admin/admin.component').then(m=>m.AdminComponent)},
  {path:'team',canActivate:[teamGuard],loadComponent:()=>import('./admin/admin.component').then(m=>m.AdminComponent)},
  {
    path: 'access',
    canActivate: [signedInGuard],
    loadComponent: () => import('./auth/access/access.component').then(m => m.AccessComponent)
  },
  {
    path: 'distribution-batch/:productId',
    redirectTo: 'app/distribution-batch/:productId'
  },
  {
    path: '**', redirectTo: 'login'
  }
];
