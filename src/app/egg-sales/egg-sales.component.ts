import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService, DbBatchOp, AutoSettleTarget, AutoSettlePreview } from '../shared/services/database.service';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankSourceFields, bankNameOf, bankOptionLabel } from '../shared/utils/bank-source.util';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { Subscription } from 'rxjs';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { printPdfReport, PrintReportColumn } from '../shared/utils/print-report.util';
import { jsPDF } from 'jspdf';
import { printPdfBase64 } from '../shared/utils/browser-print.util';
@Component({
  selector: 'app-egg-sales',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './egg-sales.component.html',
  styleUrl: './egg-sales.component.scss'
})
export class EggSalesComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];
  sales: any[] = [];
  // The farm's OWN accounts. Never getBankAccounts() unscoped - that also
  // returns customers' accounts, and a sale banked into a customer's account
  // would record it as that customer's deposit.
  houseBanks: any[] = [];
  // AUTO-SETTLE. Ticked by default: a banked sale clearing the own-farm debt
  // the batch's farm already carries is what the client wants every time, and
  // the bar only appears when there is a debt to clear. See the block below.
  autoSettle = true;
  autoSettleTargets = new Map<number, AutoSettleTarget>();
  /**
   * Who an egg sale can be made to: the SAME `customers` list distribution
   * sells to, with the owner's own farms excluded. Own-farm rows are app-owned
   * and reachable only through the Own Farm customer type on Sales Orders; one
   * offered here would let a layer batch sell eggs to a farm as though it were
   * an outside buyer, with none of the internal-transfer cost or elimination.
   *
   * Picking one is OPTIONAL — a walk-in sale has no customer, which is what
   * every row written before this column existed is.
   */
  customers: any[] = [];
  // All layer farms for this account — drives the unit_id filter below.
  units: any[] = [];
  // The farm currently selected in the sidebar.
  currentUnit: any = null;
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';
  defaultRatePerEgg: number | null = null;
  defaultRatePerCarton: number | null = null;
  defaultEggsPerCarton: number | null = null;
  // Screen-level sale mode — every new pending row inherits this. Locked
  // (see hasPendingRows) once a sale is in progress so one sale can't mix modes.
  screenMode: 'per_egg' | 'per_carton' = 'per_egg';

  // Available (sellable) eggs per batch = collected (total - broken) minus already sold.
  availableByBatch: { [batchId: number]: number } = {};
  collectedByBatch: { [batchId: number]: number } = {};
  // 🔥 NEW: per-grade tracking, so a sale of "small" eggs can't oversell
  // against total stock when only some of that stock is actually small.
  availableByGrade: { [batchId: number]: { small: number; medium: number; large: number; xl: number } } = {};
  private editOriginalQty = 0;
  private editOriginalBatch: any = null;
  private editOriginalDate: string = '';
private editOriginalGrade: string = '';
  currentPage = 1;
  pageSize = 20;

  selectedBatchFilter: string = 'all';
  private subs = new Subscription();

  get filteredSales() {
    if (this.selectedBatchFilter === 'all') return this.sales;
    return this.sales.filter(s => String(s.batch_id) === String(this.selectedBatchFilter));
  }

  get paginatedSales() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredSales.slice(start, start + this.pageSize);
  }

  get hasPendingRows(): boolean { return this.pendingRows.length > 0; }

  // ── Stock Summary (respects batch filter) ────────────────────
  get summaryCollected(): number {
    if (this.selectedBatchFilter === 'all') {
      return Object.values(this.collectedByBatch).reduce((s: number, v: number) => s + v, 0);
    }
    return this.collectedByBatch[+this.selectedBatchFilter] || 0;
  }

  get summarySold(): number {
    const src = this.selectedBatchFilter === 'all'
      ? this.sales
      : this.sales.filter(s => String(s.batch_id) === String(this.selectedBatchFilter));
    return src.reduce((s, sale) => s + (sale.quantity || 0), 0);
  }

  get summaryInStock(): number { return this.summaryCollected - this.summarySold; }

  get summaryBatchLabel(): string {
    if (this.selectedBatchFilter === 'all') return 'All Batches';
    return this.getBatchName(+this.selectedBatchFilter);
  }

  getAvailableEggs(batchId: number): number {
    return Math.max(0, this.availableByBatch[batchId] ?? 0);
  }

  // 🔥 NEW: available stock for a specific grade. "mixed" sales aren't tied
  // to one grade, so they fall back to the overall batch total.
  getAvailableForGrade(batchId: number, grade: string): number {
    if (!grade || grade === 'mixed') return this.getAvailableEggs(batchId);
    const g = this.availableByGrade[batchId];
    if (!g) return 0;
    return Math.max(0, (g as any)[grade] ?? 0);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'a') { event.preventDefault(); this.addPendingRow(); }
    if (event.ctrlKey && event.key === 's') { event.preventDefault(); if (this.hasPendingRows) this.saveAllRows(); }
  }

  constructor(private db: DatabaseService, private authService: AuthService, private cdr: ChangeDetectorRef, private pendingState: PendingStateService, private flockService: FlockService, private farmUnitService: FarmUnitService, private dataChange: DataChangeService) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // Load units first — the currentUnit$ subscription below fires
    // synchronously (BehaviorSubject) and its filtering depends on
    // this.units already being populated.
    await this.loadUnits();
    await this.loadData();
    const cached = this.pendingState.getState('EggSalesComponent');
    if (cached?.farmId === this.currentFarm?.farm_id) {
      this.pendingRows = cached.pendingRows || [];
      this.defaultRatePerEgg = cached.defaultRatePerEgg ?? null;
      this.defaultRatePerCarton = cached.defaultRatePerCarton ?? null;
      this.defaultEggsPerCarton = cached.defaultEggsPerCarton ?? null;
      // Restored rows already committed to a mode — the screen must match
      // them, not reset to the default, or the lock below would be wrong.
      if (this.pendingRows.length) {
        this.screenMode = this.pendingRows[0].sale_mode === 'per_carton' ? 'per_carton' : 'per_egg';
      }
    }
    this.applyActiveBatch(this.flockService.getCurrentFlock());
    this.subs.add(
      this.flockService.currentFlock$.subscribe(flock => this.applyActiveBatch(flock))
    );

    this.subs.add(
      this.farmUnitService.currentUnit$.subscribe(unit => {
        this.currentUnit = unit;
        this.loadData();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.loadUnits();
        this.loadData();
      })
    );
  }

  async loadUnits() {
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, 'layer');
    this.units = result.success ? result.data : [];
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    this.pendingState.saveState('EggSalesComponent', { farmId: this.currentFarm?.farm_id, pendingRows: this.pendingRows, defaultRatePerEgg: this.defaultRatePerEgg, defaultRatePerCarton: this.defaultRatePerCarton, defaultEggsPerCarton: this.defaultEggsPerCarton });
  }

  private applyActiveBatch(flock: any) {
    if (!flock?.batch_id) return;
    const batchId = String(flock.batch_id);
    if (this.selectedBatchFilter === batchId) return;
    this.selectedBatchFilter = batchId;
    this.currentPage = 1;
    this.cdr.detectChanges();
  }

  async loadData() {
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty list.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;

    const bSql = unitId
      ? `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' AND unit_id = ? ORDER BY batch_id DESC`
      : `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' ORDER BY batch_id DESC`;
    const bParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const bRes = await this.db.get(bSql, bParams);
    this.batches = bRes.success ? bRes.data : [];

    // LEFT JOIN, not INNER: only an unpaid sale to a named customer has a
    // bill, and the great majority have none. The three bill columns are what
    // the Payment cell shows so the receivable is visible on the sale that
    // raised it — and so the user can see it has been settled.
    const billJoin = `LEFT JOIN bills bl ON bl.source = 'egg_sale' AND bl.source_id = es.egg_sale_id`;
    const billCols = `bl.bill_number AS bill_number, bl.total_amount AS bill_total, bl.amount_paid AS bill_paid`;
    const sSql = unitId
      ? `SELECT es.*, b.batch_name, ${billCols} FROM egg_sales es JOIN batches b ON es.batch_id = b.batch_id ${billJoin} WHERE b.farm_id = ? AND b.unit_id = ? ORDER BY es.date DESC`
      : `SELECT es.*, b.batch_name, ${billCols} FROM egg_sales es JOIN batches b ON es.batch_id = b.batch_id ${billJoin} WHERE b.farm_id = ? ORDER BY es.date DESC`;
    const sParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const sRes = await this.db.get(sSql, sParams);
    this.sales = sRes.success ? sRes.data : [];

    // Re-read every load: the account list is farm-wide rather than per batch,
    // so an account added on the Bank screen has to appear here without a
    // reload. House accounts only - a sale banked into a CUSTOMER's account
    // would be recorded as that customer's deposit.
    const bankRes = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
    this.houseBanks = bankRes.success ? (bankRes.data || []) : [];

    // What each listed batch's farm owes distribution, for the auto-settle bar.
    // After the batches and the accounts, because it reads off both.
    await this.loadAutoSettleTargets();

    // Re-read every load for the same reason the accounts are: the customer
    // list is farm-wide, not per batch, so one added under Customer Management
    // has to appear here without a reload. Own-farm rows excluded — see the
    // field's own note.
    const custRes = await this.db.get(
      `SELECT customer_id, customer_name FROM customers
       WHERE farm_id = ? AND COALESCE(customer_type,'external') <> 'own_farm'
       ORDER BY customer_name ASC`,
      [this.currentFarm.farm_id]
    );
    this.customers = custRes.success ? (custRes.data || []) : [];

    // Recompute available eggs per active batch: collected sellable eggs minus sold.
    this.availableByBatch = {};
    this.availableByGrade = {};
    for (const b of this.batches) {
      const colRes = await this.db.get(
        `SELECT COALESCE(SUM(total_eggs - broken_eggs), 0) AS collected FROM egg_collection WHERE batch_id = ?`,
        [b.batch_id]
      );
      const soldRes = await this.db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS sold FROM egg_sales WHERE batch_id = ?`,
        [b.batch_id]
      );
      const collected = colRes.success ? Number(colRes.data[0]?.collected || 0) : 0;
      const sold = soldRes.success ? Number(soldRes.data[0]?.sold || 0) : 0;
      this.collectedByBatch[b.batch_id] = collected;
      this.availableByBatch[b.batch_id] = collected - sold;

      // 🔥 NEW: per-grade collected totals, from the actual grade columns
      // recorded at collection time — this is the piece that was never
      // being checked before.
      const gradeColRes = await this.db.get(
        `SELECT COALESCE(SUM(small_grade),0) AS small, COALESCE(SUM(medium_grade),0) AS medium,
                COALESCE(SUM(large_grade),0) AS large, COALESCE(SUM(xl_grade),0) AS xl
         FROM egg_collection WHERE batch_id = ?`,
        [b.batch_id]
      );
      // 🔥 NEW: per-grade sold totals — "mixed" sales are excluded here since
      // they don't commit to a specific grade.
      const gradeSoldRes = await this.db.get(
        `SELECT grade, COALESCE(SUM(quantity),0) AS qty FROM egg_sales
         WHERE batch_id = ? AND grade IN ('small','medium','large','xl')
         GROUP BY grade`,
        [b.batch_id]
      );

      const gc = gradeColRes.success && gradeColRes.data[0] ? gradeColRes.data[0] : { small: 0, medium: 0, large: 0, xl: 0 };
      const soldMap: any = { small: 0, medium: 0, large: 0, xl: 0 };
      if (gradeSoldRes.success && gradeSoldRes.data) {
        for (const row of gradeSoldRes.data) {
          if (soldMap[row.grade] !== undefined) soldMap[row.grade] = Number(row.qty) || 0;
        }
      }

      this.availableByGrade[b.batch_id] = {
        small: Number(gc.small || 0) - soldMap.small,
        medium: Number(gc.medium || 0) - soldMap.medium,
        large: Number(gc.large || 0) - soldMap.large,
        xl: Number(gc.xl || 0) - soldMap.xl
      };
    }
    this.cdr.detectChanges();
  }

  getBatchName(id: number) { return this.batches.find(b => b.batch_id === id)?.batch_name || '—'; }

  makeNewRow() {
    return {
      batch_id: this.selectedBatchFilter !== 'all' ? Number(this.selectedBatchFilter) : (this.batches[0]?.batch_id || null),
      date: toLocalDateString(),
      customer_id: null,
      customer_name: '',
      grade: 'mixed',
      sale_mode: this.screenMode,
      quantity: null,
      carton_count: null,
      eggs_per_carton: this.defaultEggsPerCarton || 360,
      rate_per_egg: this.getDefaultRateForMode(this.screenMode),
      amount: null,
      payment_type: 'cash',
      bank_id: null
    };
  }

  // Per-egg and per-carton defaults are different numbers, so a mode switch
  // must swap to the new mode's default rather than leaving the old mode's
  // number sitting under the wrong unit.
  getDefaultRateForMode(mode: string): number | null {
    return mode === 'per_carton' ? this.defaultRatePerCarton : this.defaultRatePerEgg;
  }

  // Switching is refused outright while a sale is in progress — never
  // warn-and-convert, never discard the pending rows. The inactive tab is
  // also [disabled] in the template; this guard covers any other caller.
  setScreenMode(mode: 'per_egg' | 'per_carton') {
    if (this.hasPendingRows || this.screenMode === mode) return;
    this.screenMode = mode;
  }

  applyDefaultRateToAll() {
    this.pendingRows.forEach(row => {
      const def = this.getDefaultRateForMode(row.sale_mode);
      if (def !== null) row.rate_per_egg = def;
    });
  }

  addPendingRow() { if (!this.isSaving) { this.editingId = null; this.pendingRows.push(this.makeNewRow()); } }
  addRowAfter(i: number) { this.pendingRows.splice(i + 1, 0, this.makeNewRow()); }
  removePendingRow(i: number) { this.pendingRows.splice(i, 1); }

  // The real egg quantity, regardless of pricing mode — this is what stock,
  // production figures and every other consumer read. A per_carton row
  // derives it from carton_count * eggs_per_carton rather than taking a
  // directly-entered number, so a 2-carton sale always reduces stock by
  // 2 * eggs_per_carton, never by 2.
  computeQuantity(row: any): number {
    if (row.sale_mode === 'per_carton') return Number(row.carton_count || 0) * Number(row.eggs_per_carton || 360);
    return Number(row.quantity || 0);
  }

  // total is always quantity*rate for per_egg, or carton_count*rate for
  // per_carton — `rate_per_egg` holds a per-carton rate in that mode, same
  // as hen_sales reuses rate_per_hen to hold a per-kg rate. `amount`
  // overrides both when the user types a figure directly.
  private computeSaleTotal(row: any): number {
    if (row.amount !== null && row.amount !== undefined && row.amount !== '') return Number(row.amount);
    if (row.sale_mode === 'per_carton') return Number(row.carton_count || 0) * Number(row.rate_per_egg || 0);
    return Number(row.quantity || 0) * Number(row.rate_per_egg || 0);
  }

  bankNameOf(bankId: number | null): string { return bankNameOf(this.houseBanks, bankId); }

  // ── AUTO-SETTLE THE FARM'S OWN-FARM DEBT ───────────────────
  //
  // Distribution bills the batch's farm for the feed it sent (an own-farm
  // bill), and that farm carries the debt until it is settled. When the sale is
  // banked, the money is already in one of the owner's own accounts — so the
  // debt can be cleared then and there, which is what the Internal Settlement
  // screen does by hand. `buildAutoSettleOps()` is the shared implementation;
  // this screen supplies the batch's own-farm customer, the account and the
  // amount. Identical to the broiler and the other layer sale screen.
  //
  // CASH SALES NEVER AUTO-SETTLE. The mechanism keys the settlement to a named
  // account at both ends, and a cash sale has none.
  //
  // PER ROW, not per screen: this screen is UNIT-scoped rather than
  // batch-scoped, so two pending rows can sit on two batches in two farm units
  // and owe two different own-farm customers. Each row settles its own.

  /** The own-farm customer and debt behind each batch this screen lists. */
  private async loadAutoSettleTargets() {
    this.autoSettleTargets = new Map<number, AutoSettleTarget>();
    if (!this.currentFarm?.farm_id || this.batches.length === 0) return;
    const res = await this.db.getOwnFarmDebtByOwner(
      this.currentFarm.farm_id, 'batch', this.batches.map((b: any) => Number(b.batch_id)));
    if (!res.success) return;
    for (const target of (res.data || [])) this.autoSettleTargets.set(target.owner_id, target);
  }

  /**
   * What this row would settle against, or null. Null for a cash or credit row,
   * for a batch whose farm has no own-farm customer, and for one that owes
   * nothing — which is what hides the checkbox in each of those cases.
   */
  autoSettleTargetFor(row: any): AutoSettleTarget | null {
    if (!bankSourceFields(row).bank_id) return null;
    const target = this.autoSettleTargets.get(Number(row?.batch_id));
    return target && target.outstanding > 0 ? target : null;
  }

  /** How the chosen account reads in the bar: bank name plus the account title. */
  private bankOptionLabelFor(bankId: number | null): string {
    return bankOptionLabel(this.houseBanks.find(b => Number(b.bank_id) === Number(bankId)))
      || this.bankNameOf(bankId);
  }

  /**
   * What the bar offers, recomputed live, or null when there is nothing to
   * offer. THE SAME WALK THE SAVE DOES — each bank-sourced row takes
   * min(its total, what its farm still owes) and the remainder carries to the
   * next row — so what is previewed is what will be written. Independent of
   * `autoSettle` itself, so unticking the box leaves the bar on screen.
   */
  get autoSettlePreview(): AutoSettlePreview | null {
    const remaining = new Map<number, number>();
    const accounts = new Set<number>();
    const farms = new Set<string>();
    let amount = 0, debt = 0;

    for (const row of this.pendingRows) {
      const target = this.autoSettleTargetFor(row);
      if (!target) continue;
      if (!remaining.has(target.customer_id)) {
        remaining.set(target.customer_id, target.outstanding);
        debt += target.outstanding;
      }
      const left = remaining.get(target.customer_id)!;
      const take = Math.min(left, this.computeSaleTotal(row));
      if (!(take > 0)) continue;
      remaining.set(target.customer_id, left - take);
      amount += take;
      accounts.add(Number(bankSourceFields(row).bank_id));
      farms.add(target.customer_name);
    }

    if (!(amount > 0)) return null;
    return {
      amount, debt,
      account: accounts.size === 1
        ? this.bankOptionLabelFor(Array.from(accounts)[0])
        : 'the chosen accounts',
      farms: farms.size === 1 ? Array.from(farms)[0] : 'your farms'
    };
  }


  /**
   * A picked customer's name is copied onto the row's own `customer_name`.
   *
   * That column is not redundant: it is free text, it is what every existing
   * row has, and it is what the printed receipt, the statement line and the
   * layer report already read. Copying the name means those keep working
   * untouched, and a customer renamed or deleted afterwards does not blank the
   * record of who the eggs went to — the same reason the bank helpers prefer a
   * joined `bank_name` over looking the account up by id.
   *
   * Clearing the dropdown leaves whatever name is in the box: the sale becomes
   * a walk-in again, and the typed name is the only thing that then records
   * the buyer.
   */
  /**
   * The receivable this row raises, or null when it raises none.
   *
   * THE RULE, and it is the only one the data supports: a layer sale has no
   * part-payment field, so it is either settled at the till or it is not.
   * 'cash' and 'bank' are settled — a bank sale has a real deposit posted
   * against it — and 'credit' is not. A sale with no named customer raises
   * nothing whatever its payment type, because there is nobody to carry the
   * debt; the typed name is a label, not an account.
   */
  /**
   * How a saved sale's receivable reads in the list, or '' when it has none.
   * Reads the three `bill_*` columns the list query LEFT JOINs in.
   */
  receivableNote(sale: any): string {
    if (!sale?.bill_number) return '';
    const owed = Math.max(Number(sale.bill_total || 0) - Number(sale.bill_paid || 0), 0);
    if (owed <= 0) return `${sale.bill_number} · settled`;
    return `${sale.bill_number} · Rs. ${owed.toLocaleString()} owed`;
  }

  private layerReceivableFor(row: any): any {
    const customerId = Number(row?.customer_id) || null;
    if (!customerId) return null;
    if (row.payment_type !== 'credit') return null;
    const amount = this.computeSaleTotal(row);
    if (!(amount > 0)) return null;
    return {
      source: 'egg_sale',
      farm_id: this.currentFarm.farm_id,
      customer_id: customerId,
      customer_name: row.customer_name || '',
      date: row.date,
      amount
    };
  }

  onCustomerPick(row: any) {
    const id = Number(row?.customer_id) || null;
    row.customer_id = id;
    if (!id) return;
    const picked = this.customers.find(c => Number(c.customer_id) === id);
    if (picked) row.customer_name = picked.customer_name || '';
  }

  /** How a banked egg sale is labelled on the bank statement. */
  private depositLabel(row: any): string {
    const who = String(row?.customer_name ?? '').trim();
    const qty = this.computeQuantity(row);
    const head = `Egg sale — ${qty} eggs`;
    return who ? `${head} (${who})` : head;
  }

  private validateSaleRow(row: any): string | null {
    if (!row.batch_id || !row.date) return 'Each row needs a batch and date.';
    const rate = row.rate_per_egg;
    if (rate === null || rate === undefined || rate === '' || Number(rate) < 0) {
      return 'Rate is required and cannot be negative.';
    }
    if (row.sale_mode === 'per_carton') {
      if (!(Number(row.carton_count) > 0)) return 'Carton count must be greater than 0.';
      if (!(Number(row.eggs_per_carton) > 0)) return 'Eggs per carton must be greater than 0.';
    } else if (!(Number(row.quantity) > 0)) {
      return 'Quantity must be greater than 0.';
    }
    // Banked with no account chosen is refused rather than saved as cash: a
    // sale that says the money reached a bank account has to name which one,
    // or nothing reverses it and no balance moves. Both the multi-row save and
    // saveEdit already run this validator, so one line covers both.
    return bankSourceError(row, this.houseBanks);
  }

  async saveAllRows() {
    if (!this.pendingRows.length || this.isSavingAll) return;
    this.errorMessage = '';

    // Validate every row before saving any (presence, negatives, stock).
    // 🔥 FIX: check against grade-specific stock, not just the batch total —
    // otherwise selling more "small" eggs than were ever collected as small
    // was silently allowed as long as the batch's overall total covered it.
    const remaining: { [key: string]: number } = {};
    for (const row of this.pendingRows) {
      const err = this.validateSaleRow(row);
      if (err) { this.errorMessage = err; this.cdr.detectChanges(); return; }
      const qty = this.computeQuantity(row);
      const key = `${row.batch_id}_${row.grade}`;
      const avail = remaining[key] ?? this.getAvailableForGrade(row.batch_id, row.grade);
      if (qty > avail) {
        const gradeLabel = row.grade === 'mixed' ? '' : ` (${row.grade})`;
        this.errorMessage = `Only ${avail} egg(s)${gradeLabel} available for ${this.getBatchName(row.batch_id)}.`;
        this.cdr.detectChanges(); return;
      }
      remaining[key] = avail - qty;
    }

    this.isSavingAll = true;
    try {
      // A banked row's deposit is interleaved directly after its own insert and
      // keyed to it with `{ $lastId: -1 }`, so the sale and the money arriving
      // in the account are one movement. Balances are rebuilt once at the end,
      // per account: several sales banked into the same account would otherwise
      // each cache a figure the next statement invalidates.
      // NO ACCOUNT MAY BE TAKEN BELOW ZERO. An egg sale is money IN, so this
      // can only refuse if the table's declared direction in BANK_SOURCES
      // changes — called on the same terms as every other insert path rather
      // than skipped on that reasoning.
      const balanceGuard = await this.db.checkBankSourceInserts(
        'egg_sales',
        this.pendingRows.map(r => ({ ...bankSourceFields(r), amount: this.computeSaleTotal(r) }))
      );
      if (!balanceGuard.success) {
        // The `finally` below clears isSavingAll and runs change detection.
        this.errorMessage = balanceGuard.error || 'Not enough balance in that account.';
        return;
      }

      // The unpaid own-farm bills as this batch will leave them, threaded from
      // one row to the next: every read happens before any statement runs, so
      // a second row banked into the same farm's debt would otherwise allocate
      // against the first row's stale `amount_paid`.
      const settleBills = new Map<number, any[]>();
      const ops: DbBatchOp[] = [];
      for (const row of this.pendingRows) {
        const bank = bankSourceFields(row);
        // Where this sale's own INSERT lands in the batch. The receivable's
        // `source_id` and the bank deposit both have to name it, and the
        // deposit sits between them, so the index is taken rather than assumed.
        const saleOp = ops.length;
        ops.push({
          sql: `INSERT INTO egg_sales (batch_id, date, customer_id, customer_name, grade, quantity, rate_per_egg, total_amount, payment_type, payment_source, bank_id, sale_mode, carton_count, eggs_per_carton) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            row.batch_id, row.date, Number(row.customer_id) || null, row.customer_name, row.grade,
            this.computeQuantity(row), row.rate_per_egg, this.computeSaleTotal(row), row.payment_type,
            bank.payment_source, bank.bank_id,
            row.sale_mode || 'per_egg',
            row.sale_mode === 'per_carton' ? row.carton_count : null,
            row.eggs_per_carton || 360
          ]
        });
        ops.push(...this.db.bankSourceInsertOps('egg_sales', {
          ...bank,
          date: row.date,
          description: this.depositLabel(row),
          amount: this.computeSaleTotal(row),
          referenceId: { $lastId: saleOp }
        }));
        // An unpaid sale to a named customer raises a real bill, which is what
        // the customer carries until they settle it — on the Customer Ledger
        // screen or through a Receive Voucher, both unchanged. A cash or bank
        // sale is already paid and a walk-in has nobody to owe, so
        // layerReceivableFor() returns null and this adds nothing.
        const receivable = this.layerReceivableFor(row);
        if (receivable) {
          ops.push(...this.db.layerReceivableOps({ ...receivable, saleOp }, ops.length));
        }
        // A BANKED sale clears what this batch's farm owes distribution, in
        // THIS batch, as a same-account internal settlement — so the account
        // moves by the sale only and the debt goes with it. Unticked, or a
        // cash or credit row, or no debt: nothing is added and the batch is
        // what it always was. Mutually exclusive with the receivable above,
        // which only a CREDIT row raises.
        const target = this.autoSettle ? this.autoSettleTargetFor(row) : null;
        if (target) {
          const auto = await this.db.buildAutoSettleOps({
            farm_id: this.currentFarm.farm_id,
            from_bank_id: bank.bank_id!,
            customer_id: target.customer_id,
            max_amount: this.computeSaleTotal(row),
            date: row.date,
            reference: 'Auto-settled from Egg Sale #',
            bank_label: this.bankOptionLabelFor(bank.bank_id),
            source: 'egg_sale',
            source_id: { $lastId: saleOp },
            base_index: ops.length,
            bills: settleBills.get(target.customer_id)
          });
          this.assertOk(auto, 'Settling the own-farm bills failed');
          settleBills.set(target.customer_id, auto.bills);
          ops.push(...auto.ops);
        }
      }
      ops.push(...this.db.bankRebuildOps(this.pendingRows.map(r => bankSourceFields(r).bank_id)));
      // The sales and their `income` mirrors are ONE movement: the mirror is a
      // rebuilt-from-scratch daily total, so a mirror written without its sales
      // (or sales left without their mirror) leaves the two disagreeing with no
      // way to tell which is right. The batch alone covered only the inserts —
      // the mirror landed outside it. The mirror has to read back the day's SUM
      // after the sales land, so this needs `db.transaction()`, inside which the
      // `runBatch` below becomes a SAVEPOINT and the two compose.
      await this.db.transaction(async () => {
        this.assertOk(await this.db.runBatch(ops), 'Saving the egg sales failed');

        const uniqueSyncs = new Map<string, { batchId: number, date: string }>();
        for (const row of this.pendingRows) {
          uniqueSyncs.set(`${row.batch_id}_${row.date}`, { batchId: Number(row.batch_id), date: row.date });
        }
        for (const sync of uniqueSyncs.values()) {
          await this.syncIncomeForEggSale(sync.date, sync.batchId);
        }
      });
      this.pendingRows = [];
      await this.loadData();
    } catch (e: any) {
      this.errorMessage = e?.message || 'Saving the egg sales failed. Nothing was saved.';
    } finally { this.isSavingAll = false; this.cdr.detectChanges(); }
  }

  // ── Transaction helpers ──────────────────────────────────────
  // db.run()/db.get()/db.runBatch() report failures as `{ success: false }`
  // instead of throwing, so an unchecked call inside a transaction would fail
  // silently and still be committed along with everything else. Every write on
  // the sale + income-mirror paths goes through these.

  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'unknown error')}`);
    }
    return result;
  }

  private async mustRun(sql: string, params: any[] = []): Promise<any> {
    return this.assertOk(await this.db.run(sql, params), 'Database write failed');
  }

  cancelAllRows() { this.pendingRows = []; }

  startEdit(s: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = s.egg_sale_id;
    this.editOriginalQty = Number(s.quantity) || 0;
    this.editOriginalBatch = s.batch_id;
    this.editOriginalDate = s.date;
    this.editOriginalGrade = s.grade;
    this.editForm = {
      batch_id: s.batch_id, date: s.date,
      customer_id: s.customer_id ?? null, customer_name: s.customer_name, grade: s.grade,
      sale_mode: s.sale_mode || 'per_egg',
      quantity: s.quantity,
      carton_count: s.carton_count,
      eggs_per_carton: s.eggs_per_carton || 360,
      rate_per_egg: s.rate_per_egg, amount: s.total_amount, payment_type: s.payment_type,
      // A legacy row says payment_type = 'bank' with no account, because none
      // was ever recorded. The dropdown opens unset and the save is refused
      // until one is chosen - see bankSourceError().
      bank_id: s.bank_id ?? null
    };
  }

  cancelEdit() { if (!this.isSaving) { this.editingId = null; this.editForm = {}; } }

  async saveEdit(id: number) {
    if (this.isSaving) return;
    this.errorMessage = '';
    const err = this.validateSaleRow(this.editForm);
    if (err) { this.errorMessage = err; this.cdr.detectChanges(); return; }
    const qty = this.computeQuantity(this.editForm);

    // The eggs already booked to this sale are available again while editing it,
    // but only for the batch AND grade they were originally booked against.
    const currentAvail = this.getAvailableForGrade(this.editForm.batch_id, this.editForm.grade);
    const sameBatchAndGrade = String(this.editForm.batch_id) === String(this.editOriginalBatch)
      && this.editForm.grade === this.editOriginalGrade;
    const allowed = currentAvail + (sameBatchAndGrade ? this.editOriginalQty : 0);

    if (qty > allowed) {
      const gradeLabel = this.editForm.grade === 'mixed' ? '' : ` (${this.editForm.grade})`;
      this.errorMessage = `Only ${allowed} egg(s)${gradeLabel} available for ${this.getBatchName(this.editForm.batch_id)}.`;
      this.cdr.detectChanges(); return;
    }
    // THE PRECONDITION. Once the customer has paid against this sale's bill,
    // that payment is a `customer_ledger` credit tagged to it — and if it came
    // through a Receive Voucher, money moved through a bank account too.
    // Rewriting the sale underneath it would move or remove the debt while the
    // payment stood, so it is refused and the user is told what to do first.
    // Same shape as `deleteCustomerLedgerEntry()` refusing a voucher-tagged row.
    const existingBill = await this.db.layerSaleBill('egg_sale', id);
    if (!existingBill.success) {
      this.errorMessage = 'Could not read this sale\'s customer bill: ' +
        friendlySqlError(existingBill.error, 'unknown error');
      this.cdr.detectChanges(); return;
    }
    if (existingBill.bill && Number(existingBill.bill.amount_paid) > 0) {
      this.errorMessage = `This sale is billed to a customer (${existingBill.bill.bill_number}) ` +
        'who has already paid against it. Reverse that payment on the Customer Ledger first.';
      this.cdr.detectChanges(); return;
    }

    this.isSaving = true; this.editingId = null;
    try {
      // Moving a sale to another day or batch rebuilds TWO mirrors — the day it
      // left and the day it landed on. Split across separate writes, a failure
      // between them double-counts the sale (both mirrors hold it) or loses it
      // from both, so the update and both rebuilds commit together or not at all.
      // The deposit is reversed and re-posted rather than patched, which is one
      // shape for all five transitions - changed amount (the net movement is
      // the difference), changed date, cash to bank, bank to cash, and
      // bank A to bank B - with both accounts rebuilt at the end.
      const bank = bankSourceFields(this.editForm);
      await this.db.transaction(async () => {
        const update: DbBatchOp = {
          sql: `UPDATE egg_sales SET batch_id=?, date=?, customer_id=?, customer_name=?, grade=?, quantity=?, rate_per_egg=?, total_amount=?, payment_type=?, payment_source=?, bank_id=?, sale_mode=?, carton_count=?, eggs_per_carton=? WHERE egg_sale_id=?`,
          params: [this.editForm.batch_id, this.editForm.date, Number(this.editForm.customer_id) || null, this.editForm.customer_name, this.editForm.grade,
           qty, this.editForm.rate_per_egg, this.computeSaleTotal(this.editForm), this.editForm.payment_type,
           bank.payment_source, bank.bank_id,
           this.editForm.sale_mode || 'per_egg',
           this.editForm.sale_mode === 'per_carton' ? this.editForm.carton_count : null,
           this.editForm.eggs_per_carton || 360,
           id]
        };
        this.assertOk(
          await this.db.saveBankSourceEdit('egg_sales', id, update, {
            ...bank,
            date: this.editForm.date,
            description: this.depositLabel(this.editForm),
            amount: this.computeSaleTotal(this.editForm)
          }),
          'Saving the egg sale failed');

        // The receivable is REVERSED AND RE-RAISED rather than patched — one
        // shape for every transition (amount, date, customer, credit->cash,
        // cash->credit, walk-in->customer and back), instead of a branch per
        // case. The reversal is a no-op when there was no bill, and the raise
        // is a no-op when there is no longer one.
        const billOps: DbBatchOp[] = this.db.layerReceivableReversalOps(existingBill.bill);
        const nextReceivable = this.layerReceivableFor(this.editForm);
        if (nextReceivable) {
          // billOps.length, not 0: the reversal's statements come first, and
          // the ledger debit names its bill by ABSOLUTE index in the batch.
          billOps.push(...this.db.layerReceivableOps(
            { ...nextReceivable, sale_id: id }, billOps.length));
        }
        if (billOps.length) {
          this.assertOk(await this.db.runBatch(billOps),
            'Updating the customer bill for this sale failed');
        }

        await this.syncIncomeForEggSale(this.editForm.date, this.editForm.batch_id);
        if (this.editForm.date !== this.editOriginalDate || String(this.editForm.batch_id) !== String(this.editOriginalBatch)) {
          await this.syncIncomeForEggSale(this.editOriginalDate, this.editOriginalBatch);
        }
      });
      this.editForm = {};
    } catch (e: any) {
      this.errorMessage = e?.message || 'Saving the egg sale failed. Nothing was changed.';
      // Nothing was committed, so reopen the row with what the user typed
      // rather than dropping their edit on the floor.
      this.editingId = id;
    }

    await this.loadData();
    this.isSaving = false; this.cdr.detectChanges();
  }

  confirmDelete(id: number) { if (!this.isSaving) { this.deletingId = id; this.showDeleteDialog = true; } }

  async onDeleteConfirmed() {
    if (this.isSaving || !this.deletingId) return;
    this.isSaving = true; this.showDeleteDialog = false;
    this.errorMessage = '';

    const id = this.deletingId;
    const sale = this.sales.find((s: any) => s.egg_sale_id === id);

    // Read the sale's customer bill BEFORE anything is deleted: once the row
    // is gone there is nothing left to say whose balance to rebuild. And
    // refuse while the customer has paid against it — see the same
    // precondition on saveEdit().
    const existingBill = await this.db.layerSaleBill('egg_sale', id);
    if (!existingBill.success) {
      this.errorMessage = 'Could not read this sale\'s customer bill: ' +
        friendlySqlError(existingBill.error, 'unknown error');
      this.deletingId = null; this.isSaving = false; this.cdr.detectChanges(); return;
    }
    if (existingBill.bill && Number(existingBill.bill.amount_paid) > 0) {
      this.errorMessage = `This sale is billed to a customer (${existingBill.bill.bill_number}) ` +
        'who has already paid against it. Reverse that payment on the Customer Ledger first.';
      this.deletingId = null; this.isSaving = false; this.cdr.detectChanges(); return;
    }

    try {
      // Deleting the sale without rebuilding the mirror leaves the day's income
      // still claiming the deleted amount, so the two go together.
      await this.db.transaction(async () => {
        // If it was banked, the deposit goes with it and the account is rebuilt
        // in the same batch. The money never arrived.
        // Whatever own-farm debt this sale auto-settled comes back first, while
        // the bills it credited are still all there to be read. Its runBatch
        // becomes a SAVEPOINT inside this transaction, so the two compose.
        this.assertOk(
          await this.db.deleteAutoSettlementFor('egg_sale', id),
          'Reversing the auto-settlement failed');
        this.assertOk(
          await this.db.deleteBankSourced('egg_sales', id, [
            { sql: 'DELETE FROM egg_sales WHERE egg_sale_id = ?', params: [id] },
            // The receivable goes with the sale: the debt no longer exists, so
            // the bill, its ledger line and the customer's balance must stop
            // saying it does. [] when the sale raised none.
            ...this.db.layerReceivableReversalOps(existingBill.bill)
          ]),
          'Deleting the egg sale failed');
        if (sale) await this.syncIncomeForEggSale(sale.date, sale.batch_id);
      });
    } catch (e: any) {
      this.errorMessage = e?.message || 'Deleting the egg sale failed. Nothing was changed.';
    }

    this.deletingId = null; this.isSaving = false;
    await this.loadData();
  }

  onDeleteCancelled() { this.showDeleteDialog = false; this.deletingId = null; }

  /**
   * Rebuild the `income` mirror for one (batch, day) from the egg sales that
   * are actually there. Call it ONLY from inside a `db.transaction()` alongside
   * the write that changed those sales: it reads the day's SUM back, so it must
   * see that write's uncommitted rows, and it must roll back with them.
   *
   * A failed read used to be indistinguishable from "no sales left that day",
   * which silently DELETED the mirror and wrote the day's revenue off the books.
   * Every call is checked now, and a failure aborts the whole transaction.
   */
  async syncIncomeForEggSale(date: string, batchId: number) {
    const sr = this.assertOk(
      await this.db.get(`SELECT SUM(total_amount) as total_amount, SUM(quantity) as total_qty FROM egg_sales WHERE date=? AND batch_id=?`, [date, batchId]),
      'Could not total the egg sales for this day'
    );
    const totalAmount = sr.data[0] ? Number(sr.data[0].total_amount || 0) : 0;
    const totalQty = sr.data[0] ? Number(sr.data[0].total_qty || 0) : 0;

    const exist = this.assertOk(
      await this.db.get(`SELECT income_id FROM income WHERE flock_id=? AND date=? AND source='egg_sale' AND module_type='layer'`, [batchId, date]),
      'Could not read the income mirror for this day'
    );

    if (totalAmount <= 0) {
      if (exist.data.length > 0) {
        await this.mustRun(`DELETE FROM income WHERE income_id=?`, [exist.data[0].income_id]);
      }
    } else {
      const desc = `Egg Sale — ${totalQty} eggs`;
      if (exist.data.length > 0) {
        await this.mustRun(`UPDATE income SET amount=?, description=? WHERE income_id=?`, [totalAmount, desc, exist.data[0].income_id]);
      } else {
        await this.mustRun(`INSERT INTO income (flock_id, date, description, amount, source, module_type) VALUES (?, ?, ?, ?, ?, ?)`,
          [batchId, date, desc, totalAmount, 'egg_sale', 'layer']);
      }
    }
  }

  // ── Printing ──────────────────────────────────────────────
  private readonly printColumns: PrintReportColumn[] = [
    { header: 'Date', width: 18 },
    { header: 'Batch', width: 22 },
    { header: 'Customer', width: 22 },
    { header: 'Grade', width: 14 },
    { header: 'Mode', width: 14 },
    { header: 'Qty', width: 12, align: 'right' },
    { header: 'Cartons', width: 20, align: 'right' },
    { header: 'Rate', width: 22, align: 'right' },
    { header: 'Amount', width: 26, align: 'right' },
    { header: 'Payment', width: 20 }
  ];

  private eggSaleRow(row: any): (string | number)[] {
    const isPerCarton = row.sale_mode === 'per_carton';
    const qty = this.computeQuantity(row);
    const total = (row.total_amount !== null && row.total_amount !== undefined) ? Number(row.total_amount) : this.computeSaleTotal(row);
    return [
      row.date || '',
      row.batch_name || this.getBatchName(row.batch_id),
      row.customer_name || '—',
      row.grade ? (row.grade.charAt(0).toUpperCase() + row.grade.slice(1)) : 'Mixed',
      isPerCarton ? 'Per Carton' : 'Per Egg',
      String(qty),
      isPerCarton ? `${Number(row.carton_count || 0).toLocaleString()} × ${row.eggs_per_carton || 360}` : '—',
      `Rs. ${Number(row.rate_per_egg || 0).toLocaleString()} /${isPerCarton ? 'carton' : 'egg'}`,
      `Rs. ${total.toLocaleString()}`,
      (row.payment_type || 'cash').toUpperCase()
    ];
  }

  private loadImageAsBase64(url: string): Promise<string> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => { const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d')!.drawImage(img, 0, 0); resolve(canvas.toDataURL('image/jpeg')); }; img.onerror = () => reject(new Error('Logo load failed')); img.src = url; }); }

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

  // Prints one sale — a saved row (has egg_sale_id, total_amount) or a still-unsaved
  // pending row (total is computed the same way saveAllRows would compute it).
  // Mirrors sale.component.ts's printDriverReceipt: a 3-part voucher (Customer /
  // Accounts / Farm copy) on one page, so egg sales get the same paper trail
  // broiler sales already has.
  async printSaleRow(row: any) {
    const isPerCarton = row.sale_mode === 'per_carton';
    const total = (row.total_amount !== null && row.total_amount !== undefined) ? Number(row.total_amount) : this.computeSaleTotal(row);
    const qty = this.computeQuantity(row);
    const rateUnit = isPerCarton ? 'carton' : 'egg';
    const gradeLabel = row.grade ? (row.grade.charAt(0).toUpperCase() + row.grade.slice(1)) : 'Mixed';
    const batchName = row.batch_name || this.getBatchName(row.batch_id);
    const paymentType = row.payment_type || 'cash';
    const date = row.date || toLocalDateString();

    const doc = new jsPDF();
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];
    const LG: [number, number, number] = [200, 200, 200];
    const farmDisplayName = (this.currentFarm?.farm_name || 'Farm').toUpperCase();

    let logoData: string | null = null;
    let logoW = 0, logoH = 0;
    try {
      logoData = await this.loadImageAsBase64('report-boiler.jpeg');
      const ip = doc.getImageProperties(logoData);
      logoH = 16;
      logoW = (ip.width * logoH) / ip.height;
    } catch { }

    const marginX = 12;
    const usableHeight = ph - 16;
    const sectionHeight = usableHeight / 3;
    const copyLabels = ['CUSTOMER COPY', 'ACCOUNTS COPY', 'FARM COPY'];

    const drawVoucher = (top: number, label: string) => {
      let y = top + 8;

      if (logoData) {
        doc.addImage(logoData, 'JPEG', marginX, top + 3, logoW, logoH);
      }
      const textX = marginX + (logoData ? logoW + 6 : 0);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...B);
      doc.text(farmDisplayName, textX, top + 9);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...G);
      doc.text('EGG SALE RECEIPT', textX, top + 13);

      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...B);
      doc.text(label, pw - marginX, top + 8, { align: 'right' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...G);
      doc.text('Date: ' + date, pw - marginX, top + 13, { align: 'right' });

      y = top + 24;
      doc.setDrawColor(...B); doc.setLineWidth(0.3);
      doc.line(marginX, y, pw - marginX, y);
      y += 6;

      const leftCol: [string, string][] = [
        ['Batch', batchName],
        ['Customer', row.customer_name || '—'],
        ['Grade', gradeLabel],
        ['Sale Mode', isPerCarton ? 'Per Carton' : 'Per Egg'],
      ];
      const rightCol: [string, string][] = [
        ['Quantity', String(qty) + ' eggs'],
        ['Cartons', isPerCarton ? `${Number(row.carton_count || 0).toLocaleString()} × ${row.eggs_per_carton || 360}` : '—'],
        ['Rate', `Rs. ${Number(row.rate_per_egg || 0).toLocaleString()} /${rateUnit}`],
      ];

      doc.setFontSize(9);
      let ly = y, ry = y;
      for (const [lbl, val] of leftCol) {
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...G);
        doc.text(lbl + ':', marginX, ly);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...B);
        doc.text(String(val), marginX + 32, ly);
        ly += 5.5;
      }
      const rightX = pw / 2 + 4;
      for (const [lbl, val] of rightCol) {
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...G);
        doc.text(lbl + ':', rightX, ry);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...B);
        doc.text(String(val), rightX + 28, ry);
        ry += 5.5;
      }

      y = Math.max(ly, ry) + 2;

      doc.setDrawColor(...LG); doc.setLineWidth(0.2);
      doc.line(marginX, y, pw - marginX, y);
      y += 6;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...B);
      doc.text('Total: Rs. ' + total.toLocaleString(), marginX, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...G);
      doc.text('Payment: ' + paymentType.toUpperCase(), pw - marginX, y, { align: 'right' });

      const sigY = top + sectionHeight - 8;
      doc.setDrawColor(...B); doc.setLineWidth(0.2);
      doc.setFontSize(7.5); doc.setTextColor(...G);
      doc.text('_______________________', marginX, sigY);
      doc.text('Customer Signature', marginX, sigY + 4);
      doc.text('_______________________', pw - marginX - 45, sigY);
      doc.text('Authorized Signature', pw - marginX - 45, sigY + 4);
    };

    for (let i = 0; i < 3; i++) {
      const top = i * sectionHeight;
      drawVoucher(top, copyLabels[i]);
      if (i < 2) {
        doc.setDrawColor(...LG);
        doc.setLineWidth(0.3);
        (doc as any).setLineDashPattern([2, 1.5], 0);
        doc.line(marginX - 4, top + sectionHeight, pw - marginX + 4, top + sectionHeight);
        (doc as any).setLineDashPattern([], 0);
        doc.setFontSize(6.5); doc.setTextColor(...G);
        doc.text('✂ cut here', pw / 2, top + sectionHeight - 1, { align: 'center' });
      }
    }

    doc.setFontSize(6.5); doc.setTextColor(...G);
    doc.text(footer, pw / 2, ph - 3, { align: 'center' });

    this.printPdf(doc, `Egg-Sale-${row.egg_sale_id || 'New'}-${date}.pdf`);
  }

  // Prints the currently filtered list (respects the batch filter dropdown).
  async printAllSales() {
    const rows = this.filteredSales.map(s => this.eggSaleRow(s));
    const totalQty = this.filteredSales.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const totalAmount = this.filteredSales.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);

    await printPdfReport({
      farmName: this.currentFarm?.farm_name || 'Farm',
      farmId: this.currentFarm?.farm_id,
      title: 'EGG SALES REPORT',
      rangeLabel: this.summaryBatchLabel,
      summaryLines: [
        `Total Sales: ${this.filteredSales.length}`,
        `Total Quantity: ${totalQty.toLocaleString()} eggs`,
        `Total Amount: Rs. ${totalAmount.toLocaleString()}`
      ],
      columns: this.printColumns,
      rows,
      totalsRow: ['', '', '', '', 'Total', String(totalQty), '', '', `Rs. ${totalAmount.toLocaleString()}`, ''],
      filename: `Egg-Sales-${this.summaryBatchLabel.replace(/\s+/g, '_')}-${toLocalDateString()}.pdf`
    });
  }
}
