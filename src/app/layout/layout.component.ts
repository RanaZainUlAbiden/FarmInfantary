import {
  Component, OnInit, OnDestroy,
  HostListener, ViewEncapsulation, ChangeDetectorRef, inject
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, ActivatedRoute } from '@angular/router';
import { AuthService } from '../shared/services/auth.service';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService, DataScope } from '../shared/services/data-change.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { DatabaseService } from '../shared/services/database.service';
import { LicenseService } from '../shared/services/license.service';
import { Subscription } from 'rxjs';
import { PendingStateService } from '../shared/services/pending-state.service';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
  encapsulation: ViewEncapsulation.None
})
export class LayoutComponent implements OnInit, OnDestroy {
  // Injected as fields rather than constructor parameters because the signal
  // fields below read them in their own initializers, and with target ES2022
  // (native class fields) those run BEFORE constructor parameter properties
  // are assigned. inject() is valid in a field initializer; `this.x` from a
  // parameter property is not yet.
  private authService = inject(AuthService);
  private flockService = inject(FlockService);
  private farmUnitService = inject(FarmUnitService);
  private dataChange = inject(DataChangeService);
  private db = inject(DatabaseService);
  private router = inject(Router);
  private activatedRoute = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);
  private pendingState = inject(PendingStateService);
  public licenseService = inject(LicenseService); // public for template access

  currentFarm: any = null;

  // ── Shared selection state is READ, never stored ───────────
  //
  // These are views onto FlockService/FarmUnitService, not copies. The layout
  // mounts once per login at /app and is never destroyed, so a local copy here
  // has no moment at which it is naturally rebuilt: it went stale the instant
  // any other screen wrote to flocks/batches/farm_units, and only a
  // business-tab round trip put it right. Binding straight to the services
  // means there is no field left to forget to reassign — which is the shape
  // every past fix in this area took.
  //
  // Nothing in this component may write to these. Selection changes go through
  // flockService/farmUnitService, and the signals follow.
  readonly flocks = toSignal(this.flockService.flocks$, { initialValue: [] as any[] });
  readonly batches = toSignal(this.flockService.batches$, { initialValue: [] as any[] });
  readonly currentFlock = toSignal(this.flockService.currentFlock$, { initialValue: null as any });
  readonly units = toSignal(this.farmUnitService.units$, { initialValue: [] as any[] });
  readonly currentUnit = toSignal(this.farmUnitService.currentUnit$, { initialValue: null as any });

  showFlockDropdown = false;
  showUnitDropdown = false;
  sidebarCollapsed = false;
  activeRoute = 'flock-health';
  activeBusinessTab: string = 'broiler';
  private savedBusinessType: string = 'broiler';
  private lastRouteByTab: { [key: string]: string } = {};
  licenseStatus: string = '';
  showLicenseWarning: boolean = false;
  isLicenseActivated: boolean = false;
  licenseExpired: boolean = false;
  licenseExpiredMessage: string = '';
  private licenseCheckInterval: any = null;

  private subs = new Subscription();
  private destroyed=false;
  isExporting=false;
  exportMessage='';

  broilerMenu: any[] = [
    { label: 'Flock Health',  icon: '🐔', route: 'flock-health'    },
    { label: 'Expenses',      icon: '💰', route: 'expenses'         },
    { label: 'Ledger',        icon: '📒', route: 'ledger'           },
    { label: 'Medicine',      icon: '💊', route: 'medicine' },
    { label: 'Feed',          icon: '🌾', route: 'feed' },
    { label: 'Chicks',        icon: '🐤', route: 'chicks' },
    { label: 'Labour',        icon: '👷🏻‍♀️', route: 'labour' },
    { label: 'Vaccination',   icon: '💉', route: 'vaccination' },
    { label: 'Sale',          icon: '🛒', route: 'sale'             },
    { label: 'Income',        icon: '📈', route: 'income'           },
    { label: 'Report',        icon: '📄', route: 'report'           },
    { label: 'Farm Report',   icon: '🏡', route: 'farm-report'      },
    { label: 'Flocks',        icon: '🐣', route: 'flock-management' },
    // NO 'Add Flock' shortcut here, deliberately. It was added alongside the
    // layer 'Add Batch' one and the client asked for it off the broiler menu:
    // the Flocks screen's own '+ Add Flock' button is the one add path.
    { label: 'Farms',         icon: '🏠', route: 'farm-units'       }
  ];

  layerMenu: any[] = [
    { label: 'Batches',         icon: '🥚', route: 'batch-management' },
    { label: 'Add Batch',       icon: '➕', route: 'batch-management', queryParams: { add: 1 } },
    { label: 'Egg Collection',  icon: '📋', route: 'egg-collection'   },
    { label: 'Egg Sales',       icon: '💵', route: 'egg-sales'        },
    { label: 'Hen Sales',       icon: '🐓', route: 'hen-sales'        },
    { label: 'Medicine',        icon: '💊', route: 'medicine' },
    { label: 'Feed',            icon: '🌾', route: 'feed' },
    { label: 'Vaccination',     icon: '💉', route: 'vaccination' },
    { label: 'Labour',          icon: '👷🏻‍♀️', route: 'labour' },
    { label: 'Flock Health',    icon: '🩺', route: 'layer-flock-health' },
    { label: 'Expenses',        icon: '🧾', route: 'layer-expenses'    },
    { label: 'Ledger',          icon: '📗', route: 'layer-ledger'     },
    { label: 'Income',          icon: '📈', route: 'income'           },
    { label: 'Report',          icon: '📑', route: 'layer-report'     },
    { label: 'Farm Report',     icon: '🏡', route: 'farm-report'      },
    { label: 'Farms',           icon: '🏠', route: 'farm-units'       }
  ];

  distributionMenu: any[] = [
    { label: 'Inventory',     icon: '📦', route: 'inventory'            },
    { label: 'Purchase',      icon: '📥', route: 'purchase-orders'      },
    { label: 'Purchase Returns', icon: '↪', route: 'purchase-returns'   },
    { label: 'Sales Orders',  icon: '📤', route: 'sales-orders'         },
    { label: 'Returns',       icon: '↩', route: 'sales-returns'         },
    { label: 'Customers',     icon: '👥', route: 'customer-management'  },
    { label: 'Suppliers',     icon: '🏭', route: 'supplier-management'  },
    { label: 'Labour',        icon: '🪪', route: 'labour-management' },
    { label: 'Account Ledger',icon: '📊', route: 'account-ledger'       },
    // The entity view of the supplier side, alongside the Account Ledger
    // dashboard it is also reachable from. Supplier Ledger (the row-by-row
    // statement) stays where it is, inside that dashboard.
    { label: 'Supplier Accounts', icon: '🏭', route: 'supplier-accounts' },
    { label: 'Expense Ledger', icon: '💳', route: 'expense-ledger'      },
    { label: 'Report',        icon: '🗂️', route: 'distribution-report'  },
    { label: 'Receive Voucher', icon: '🧾', route: 'receive-voucher'      },
    { label: 'Payment Voucher', icon: '🧮', route: 'payment-voucher'      },
    { label: 'Internal Settlement', icon: '🔁', route: 'internal-settlement' }
  ];

  allMenu: any[] = [
    { label: 'Expenses',      icon: '💰', route: 'expenses'         },
    { label: 'Income',        icon: '📈', route: 'income'           },
    { label: 'Report',        icon: '📄', route: 'report'           },
    { label: 'Flocks',        icon: '🐣', route: 'flock-management' }
  ];

  overviewMenu: any[] = [
    { label: 'Dashboard',         icon: '🧭', route: 'overview'            },
    { label: 'Assets',            icon: '🏗️', route: 'assets'              },
    { label: 'Personal Expenses', icon: '👛', route: 'personal-expenses'   },
    { label: 'Loans',             icon: '🤝', route: 'loans'               },
    // A notebook, not a money screen — it sits here because this is where the
    // owner's own records live, not because it feeds anything on the dashboard.
    { label: 'Debt Payment',      icon: '📝', route: 'debt-payment'        },
    { label: 'Bank',              icon: '🏦', route: 'overview-bank-ledger' }
  ];

  get menuItems() {
    if (this.savedBusinessType === 'all') {
      switch (this.activeBusinessTab) {
        case 'layer': return this.layerMenu;
        case 'distribution': return this.distributionMenu;
        case 'overview': return this.overviewMenu;
        default: return this.broilerMenu;
      }
    }
    switch (this.savedBusinessType) {
      case 'layer': return this.layerMenu;
      case 'distribution': return this.distributionMenu;
      default: return this.broilerMenu;
    }
  }

  get showBusinessTabs(): boolean {
    return this.savedBusinessType === 'all';
  }

  get isLayerMode(): boolean {
    if (this.savedBusinessType === 'layer') return true;
    if (this.savedBusinessType === 'all' && this.activeBusinessTab === 'layer') return true;
    return false;
  }

  get isDistributionMode(): boolean {
    if (this.savedBusinessType === 'distribution') return true;
    if (this.savedBusinessType === 'all' && this.activeBusinessTab === 'distribution') return true;
    return false;
  }

  // Overview only ever exists as a tab within an 'all' account — there is no
  // standalone 'overview' business_type — so unlike isLayerMode/isDistributionMode
  // it doesn't need a top-level savedBusinessType branch.
  get isOverviewMode(): boolean {
    return this.savedBusinessType === 'all' && this.activeBusinessTab === 'overview';
  }

  get dropdownItems(): any[] {
    return this.isLayerMode ? this.batches() : this.flocks();
  }

  async switchBusinessTab(tab: string) {
    this.activeBusinessTab = tab;
    localStorage.setItem('activeBusinessTab', tab);

    // Load the new module's units/current-unit BEFORE navigating. The child
    // route component reads farmUnitService's current value the instant it
    // mounts (a BehaviorSubject replays synchronously on subscribe) — if we
    // navigate first, it can mount and subscribe while this is still an
    // in-flight DB call, capturing the OLD module's unit. Awaiting here
    // means the shared state is already correct by the time anything reads it.
    await this.refreshModuleData();
    if (!this.isDistributionMode && !this.isOverviewMode) {
      this.farmUnitService.notifyModuleChanged(this.isLayerMode ? 'layer' : 'broiler');
    }

    // Resume whichever screen was last open in this tab, instead of
    // always jumping back to the first menu item.
    const remembered = this.lastRouteByTab[tab];
    const menuForTab = tab === 'layer' ? this.layerMenu : tab === 'distribution' ? this.distributionMenu : tab === 'overview' ? this.overviewMenu : this.broilerMenu;
    const isValidForTab = remembered && menuForTab.some(m => m.route === remembered);
    const targetRoute = isValidForTab ? remembered : (menuForTab[0]?.route || 'flock-health');

    this.activeRoute = targetRoute;
    this.router.navigate(['/app', targetRoute]);
    this.cdr.detectChanges();
  }

  // Lets the Farms page change the logged-in account's business type without
  // forcing a re-login: mirrors what ngOnInit derives from localStorage, then
  // makes sure the active route still exists in the (possibly new) menu.
  private async onBusinessTypeChanged(newType: string) {
    this.currentFarm = this.authService.getCurrentFarm();
    this.savedBusinessType = newType;
    if (newType === 'all') {
      this.activeBusinessTab = localStorage.getItem('activeBusinessTab') || 'broiler';
    } else {
      this.activeBusinessTab = newType;
    }

    // Same ordering fix as switchBusinessTab(): resolve the new module's
    // units/current-unit before anything (a route change, a child mount)
    // can read the shared state.
    await this.refreshModuleData();
    if (!this.isDistributionMode && !this.isOverviewMode) {
      this.farmUnitService.notifyModuleChanged(this.isLayerMode ? 'layer' : 'broiler');
    }

    const validRoutes = this.menuItems.map((m: any) => m.route);
    if (!validRoutes.includes(this.activeRoute)) {
      const target = this.menuItems[0]?.route || 'flock-health';
      this.activeRoute = target;
      this.router.navigate(['/app', target]);
    }

    this.cdr.detectChanges();
  }

  async ngOnInit() {
    // 🔥 Check license first
    this.checkLicense();

    this.currentFarm = this.authService.getCurrentFarm();
    if (!this.currentFarm) {
      this.router.navigate(['/login']);
      return;
    }

    this.savedBusinessType = this.currentFarm.business_type || 'broiler';
    const requestedRoute = this.activatedRoute.snapshot.firstChild?.url[0]?.path || '';
    const routeOwner = ({ 'distribution-batch': 'inventory', 'customer-ledger': 'account-ledger',
      'supplier-ledger': 'account-ledger', 'bank-ledger': 'account-ledger' } as Record<string, string>)[requestedRoute] || requestedRoute;

    if (this.savedBusinessType === 'all') {
      this.activeBusinessTab = localStorage.getItem('activeBusinessTab') || 'broiler';
      const menus: Record<string, any[]> = { broiler: this.broilerMenu, layer: this.layerMenu,
        distribution: this.distributionMenu, overview: this.overviewMenu };
      if (!menus[this.activeBusinessTab]?.some(m => m.route === routeOwner)) {
        this.activeBusinessTab = Object.keys(menus).find(tab => menus[tab].some(m => m.route === routeOwner)) || 'broiler';
      }
    } else {
      this.activeBusinessTab = this.savedBusinessType;
    }

    try {
      const storedRoutes = localStorage.getItem('lastRouteByTab');
      this.lastRouteByTab = storedRoutes ? JSON.parse(storedRoutes) : {};
    } catch {
      this.lastRouteByTab = {};
    }

    // The ONE data-change subscription. Any screen that writes to
    // farm_units/flocks/batches announces its scope and lands here; there is
    // no second path and no per-entity Subject to forget to wire up.
    this.subs.add(
      this.dataChange.changed$.subscribe(scope => { this.onDataChanged(scope); })
    );

    this.subs.add(
      this.authService.businessTypeChanged$.subscribe(newType => {
        this.onBusinessTypeChanged(newType);
      })
    );

    // The child route '' under /app always redirects to 'flock-health' —
    // login navigates to bare '/app', and that redirect resolves before this
    // component even mounts. So without this, the sidebar highlight (set
    // above, from localStorage) and the screen actually shown (always
    // flock-health) disagree whenever the restored tab isn't broiler. Await
    // refreshModuleData() first — same ordering fix as switchBusinessTab():
    // the screen we're about to navigate to must not mount and read
    // farmUnitService/flockService state before it's set for this tab.
    await this.refreshModuleData();
    if (!this.isDistributionMode && !this.isOverviewMode) {
      this.farmUnitService.notifyModuleChanged(this.isLayerMode ? 'layer' : 'broiler');
    }

    const remembered = this.lastRouteByTab[this.activeBusinessTab];
    const isValidForTab = remembered && this.menuItems.some((m: any) => m.route === remembered);
    const validRequested = requestedRoute && this.menuItems.some(m => m.route === routeOwner);
    const targetRoute = validRequested ? routeOwner : isValidForTab ? remembered : (this.menuItems[0]?.route || 'flock-health');

    const currentUrl = this.router.url.split('/').pop();
    this.activeRoute = targetRoute;
    if (!validRequested && currentUrl !== targetRoute) {
      this.router.navigate(['/app', targetRoute]);
    }

    // Check license status periodically (every minute)
    this.licenseCheckInterval = setInterval(() => {
      this.checkLicense();
    }, 60000);

    this.loadAutoBackupPath();
  }

  ngOnDestroy() {
    this.destroyed=true;
    this.subs.unsubscribe();
    if (this.licenseCheckInterval) {
      clearInterval(this.licenseCheckInterval);
    }
  }

  /**
   * Route one announcement to the right refresh.
   *
   * A flocks/batches announcement only matters for the module on screen; the
   * other module's list is re-read when its tab is next opened, so there is
   * nothing to keep in sync in the background.
   */
  private async onDataChanged(scope: DataScope) {
    if (scope === 'units') {
      // Units feed the flock/batch query, so this reloads both.
      await this.refreshModuleData();
      return;
    }
    if (this.isDistributionMode || this.isOverviewMode) return;
    if (scope === 'flocks' && !this.isLayerMode) {
      await this.loadFlocks();
    } else if (scope === 'batches' && this.isLayerMode) {
      await this.loadBatches();
    }
  }


  /**
   * 🔥 Check if license is valid
   *
   * This runs on a 60s timer, so it must NEVER navigate on its own: a redirect
   * fired mid-session destroys whatever form the user is filling in and loses
   * their work without warning. On expiry we raise a banner instead and let the
   * user finish and save. They leave for /activation only by clicking through
   * it, or on the next app launch (the app already boots to /activation, which
   * forwards to /login when the licence is valid).
   */
  private async checkLicense(): Promise<void> {
    const status = await this.licenseService.getStatus();
    if(this.destroyed)return;

    this.isLicenseActivated = status.activated;
    this.licenseExpired = !status.activated && status.trialExpired;

    if (this.licenseExpired) {
      this.licenseExpiredMessage = 'Account access could not be checked. Check your connection or sign in again.';
    }

    if (status.activated) {
      // An activated licence is permanent — no countdown, no expiry warning.
      this.licenseStatus = 'Account active';
      this.showLicenseWarning = false;
    } else {
      this.licenseStatus = await this.licenseService.getTrialStatusMessage();
      this.showLicenseWarning = this.licenseExpired || (status.daysRemaining <= 1 && status.daysRemaining > 0);
    }

    this.cdr.detectChanges();
  }


  /**
   * Navigate to activation page
   */
  /**
   * Dead end by design. The template still carries two "Activate Now" buttons
   * from the desktop licence banner, but /activation no longer exists (D11)
   * and the entitlement stub always reports activated, so the banners never
   * render and this is never reached.
   *
   * Kept as a no-op rather than deleted so the template stays valid without
   * being edited; Phase 5 removes the banner markup along with the stub.
   */
  navigateToActivation(): void {
    /* no activation screen on the web */
  }


  async refreshModuleData() {
    await this.loadUnitsForActiveModule();
    await this.loadActiveBusinessData();
  }

  async loadUnitsForActiveModule() {
    // Distribution and Overview are farm-wide — they have no unit selector and
    // the template hides it, so there is nothing to load. The service's
    // selection is deliberately left alone rather than cleared: it is what the
    // broiler/layer tabs come back to.
    if (this.isDistributionMode || this.isOverviewMode) return;

    const moduleType = this.isLayerMode ? 'layer' : 'broiler';
    await this.farmUnitService.refreshUnits(this.currentFarm.farm_id, moduleType);
    this.cdr.detectChanges();
  }

  selectUnit(unit: any) {
    this.farmUnitService.setCurrentUnit(unit);
    this.showUnitDropdown = false;
    this.loadActiveBusinessData();
  }

  toggleUnitDropdown(event: Event) {
    event.stopPropagation();
    this.showUnitDropdown = !this.showUnitDropdown;
    this.cdr.detectChanges();
  }

  /**
   * Which unit scopes the flock/batch list.
   *
   * No units yet for this account/module — behave exactly as before the farm
   * selector existed rather than filtering to an empty list. This is the
   * fresh-account case: the very first flock is created before any unit
   * selection has settled.
   */
  private activeUnitId(): number | undefined {
    return this.units().length > 0 ? this.currentUnit()?.unit_id : undefined;
  }

  async loadFlocks() {
    await this.flockService.refreshFlocks(this.currentFarm.farm_id, this.activeUnitId());
    this.cdr.detectChanges();
  }

  async loadBatches() {
    await this.flockService.refreshBatches(this.currentFarm.farm_id, this.activeUnitId());
    this.cdr.detectChanges();
  }

  async loadActiveBusinessData() {
    this.showFlockDropdown = false;

    // Distribution/Overview have no flock or batch. The badge and the
    // "create your first" banner are already mode-guarded in the template, so
    // the selection is left as-is for the broiler/layer tabs to return to.
    if (this.isDistributionMode || this.isOverviewMode) {
      this.cdr.detectChanges();
      return;
    }

    if (this.isLayerMode) {
      await this.loadBatches();
    } else {
      await this.loadFlocks();
    }
  }

  selectBatch(batch: any) {
    this.flockService.setCurrentBatch(batch);
    this.showFlockDropdown = false;
    this.cdr.detectChanges();
  }

  toggleFlockDropdown(event: Event) {
    event.stopPropagation();
    this.showFlockDropdown = !this.showFlockDropdown;
    this.cdr.detectChanges();
  }

  @HostListener('document:click')
  closeDropdown() {
    this.showFlockDropdown = false;
    this.showUnitDropdown = false;
    this.cdr.detectChanges();
  }

  selectFlock(flock: any) {
    this.flockService.setCurrentFlock(flock);
    this.showFlockDropdown = false;
    this.cdr.detectChanges();
  }

  goToFlockManagement() {
    this.showFlockDropdown = false;
    if (this.isLayerMode) {
      this.navigate('batch-management');
    } else {
      this.navigate('flock-management');
    }
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.cdr.detectChanges();
  }

  navigate(route: string, queryParams?: any) {
    this.activeRoute = route;
    if (route === 'inventory') {
      this.activeBusinessTab = 'distribution';
    }

    // Remember which screen was open within the current module, so
    // switching business tabs away and back restores it instead of
    // always landing on the first menu item.
    const tabKey = this.savedBusinessType === 'all' ? this.activeBusinessTab : this.savedBusinessType;
    this.lastRouteByTab[tabKey] = route;
    localStorage.setItem('lastRouteByTab', JSON.stringify(this.lastRouteByTab));

    if (queryParams) {
      // A repeat click on an "Add …" shortcut must reopen the form. Angular
      // ignores a navigation to the URL it is already on, so the params carry
      // a nonce: the URL really changes, the screen's queryParams
      // subscription fires again, and the add row comes back.
      this.router.navigate(['/app', route], { queryParams: { ...queryParams, t: Date.now() } });
    } else {
      this.router.navigate(['/app', route]);
    }
    this.cdr.detectChanges();
  }

  async logout() {
    await this.authService.logout();
  }

  autoBackupPath: string | null = null;

  async loadAutoBackupPath() {
    this.autoBackupPath = await this.db.getAutoBackupPath();
    this.cdr.detectChanges();
  }



  async backupDatabase() {
    if(this.isExporting)return;this.isExporting=true;this.exportMessage='Preparing your farm export…';this.cdr.detectChanges();
    const result = await this.db.backupDatabase();
    this.isExporting=false;this.exportMessage=result.success?'Downloaded '+result.filename:(result.error||'Export failed. Try again.');if(!this.destroyed)this.cdr.detectChanges();
  }

  async restoreDatabase() {
    await this.db.restoreDatabase();
    // App relaunches automatically on success
  }

  async resetAutoBackupLocation() {
    const confirmed = confirm(
      this.autoBackupPath
        ? `Current auto-backup location:\n${this.autoBackupPath}\n\nClear it? You'll be asked to choose a new location next time you close the app.`
        : 'No auto-backup location is set yet. You\'ll be asked to choose one next time you close the app.'
    );
    if (!confirmed) return;
    await this.db.resetAutoBackupPath();
    this.autoBackupPath = null;
    this.cdr.detectChanges();
  }

}
