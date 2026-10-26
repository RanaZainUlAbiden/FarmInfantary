import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { Subscription } from 'rxjs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles } from '../shared/utils/pdf-table.util';
import { labourPaymentLabel } from '../shared/utils/bank-source.util';

import { printPdfBase64 } from '../shared/utils/browser-print.util';
@Component({
  selector: 'app-layer-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './layer-report.component.html',
  styleUrl: './layer-report.component.scss'
})
export class LayerReportComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];
  eggCollections: any[] = [];
  eggSales: any[] = [];
  vaccinations: any[] = [];
  mortalities: any[] = [];
  expenses: any[] = [];
  medicineTraders: any[] = [];
  medicineEntries: any[] = [];
  feedTraders: any[] = [];
  feedEntries: any[] = [];
  /**
   * `chick_entries` with `module_type = 'layer'`. The Chicks screen sits on the
   * broiler menu, but the table is module-aware and Distribution can bill a
   * 'chicks' product to a LAYER batch, so the cost can land here. Reading it is
   * what keeps this report's net figure equal to Overview's and the Farm
   * Report's, which both count it.
   */
  chickTraders: any[] = [];
  chickEntries: any[] = [];
  income: any[] = [];
  labourPayments: any[] = [];
  henSales: any[] = [];
  /** The layer Ledger screen's book — `layer_ledgers` / `layer_ledger_entries`. */
  ledgers: any[] = [];
  ledgerEntries: any[] = [];
  isGenerating = false;
  // All layer farms for this account — drives the unit_id filter below.
  units: any[] = [];
  // The farm currently selected in the sidebar.
  currentUnit: any = null;
  private subs = new Subscription();

  sections = {
    eggCollection: true,
    eggSales: true,
    henSales: true,
    expenses: true,
    ledgers: true,
    medicine: true,
    feed: true,
    chicks: true,
    vaccinations: true,
    mortality: true,
    income: true,
    labour: true,
    summary: true
  };

  selectedBatchFilter: string = 'all';

  private prefKey(): string {
    const batchId = this.selectedBatchFilter !== 'all' ? this.selectedBatchFilter : (this.batches[0]?.batch_id || 'default');
    return 'layer_report_preferences_' + batchId;
  }

  private loadPreferences() {
    try {
      const stored = localStorage.getItem(this.prefKey());
      if (stored) this.sections = { ...this.sections, ...JSON.parse(stored) };
    } catch {}
  }

  savePreferences() {
    try { localStorage.setItem(this.prefKey(), JSON.stringify(this.sections)); } catch {}
  }

  get filteredEggCollections() {
    if (this.selectedBatchFilter === 'all') return this.eggCollections;
    return this.eggCollections.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredEggSales() {
    if (this.selectedBatchFilter === 'all') return this.eggSales;
    return this.eggSales.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredHenSales() {
    if (this.selectedBatchFilter === 'all') return this.henSales;
    return this.henSales.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredVaccinations() {
    if (this.selectedBatchFilter === 'all') return this.vaccinations;
    return this.vaccinations.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredMortalities() {
    if (this.selectedBatchFilter === 'all') return this.mortalities;
    return this.mortalities.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredExpenses() {
    if (this.selectedBatchFilter === 'all') return this.expenses;
    return this.expenses.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
  }
  get filteredMedicineEntries() {
    if (this.selectedBatchFilter === 'all') return this.medicineEntries;
    return this.medicineEntries.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
  }
  get filteredFeedEntries() {
    if (this.selectedBatchFilter === 'all') return this.feedEntries;
    return this.feedEntries.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
  }
  get filteredChickEntries() {
    if (this.selectedBatchFilter === 'all') return this.chickEntries;
    return this.chickEntries.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
  }
  get filteredLabourPayments() {
    if (this.selectedBatchFilter === 'all') return this.labourPayments;
    return this.labourPayments.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
  }
  get filteredLedgers() {
    if (this.selectedBatchFilter === 'all') return this.ledgers;
    return this.ledgers.filter(l => String(l.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredLedgerEntries() {
    if (this.selectedBatchFilter === 'all') return this.ledgerEntries;
    return this.ledgerEntries.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }
  get filteredIncome() {
    const base = this.selectedBatchFilter === 'all'
      ? this.income
      : this.income.filter(e => String(e.flock_id) === String(this.selectedBatchFilter));
    // Exclude BOTH sale mirrors. `egg-sales.component.ts` and
    // `hen-sales.component.ts` each upsert a copy of their sale into `income`
    // tagged source = 'egg_sale' / 'hen_sale'; that revenue is already counted
    // directly via totalEggSales / totalHenSales, so counting the mirror too
    // doubles it. Same guard as `overview.service.ts` (`qLayerIncome`) and
    // `farm-report.service.ts` (`specIncome`) — the three must agree.
    return base.filter(e => e.source !== 'egg_sale' && e.source !== 'hen_sale');
  }

  get totalEggs() { return this.filteredEggCollections.reduce((s: number, e: any) => s + (e.total_eggs || 0), 0); }
  get totalEggSales() { return this.filteredEggSales.reduce((s: number, e: any) => s + (e.total_amount || 0), 0); }
  get totalHenSales() { return this.filteredHenSales.reduce((s: number, e: any) => s + (e.total_amount || 0), 0); }
  get totalMortality() { return this.filteredMortalities.reduce((s: number, e: any) => s + (e.count || 0), 0); }
  get totalExpenses() { return this.filteredExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0); }
  get totalMedicineAmount() { return this.filteredMedicineEntries.reduce((s: number, e: any) => s + (e.total_amount || 0), 0); }
  get totalFeedAmount() { return this.filteredFeedEntries.reduce((s: number, e: any) => s + (e.total_amount || 0), 0); }
  get totalChickAmount() { return this.filteredChickEntries.reduce((s: number, e: any) => s + (e.total_amount || 0), 0); }
  get totalIncome() { return this.filteredIncome.reduce((s: number, e: any) => s + (e.amount || 0), 0); }
  get totalVaccinationCost() { return this.filteredVaccinations.reduce((s: number, v: any) => s + (v.cost || 0), 0); }
  get totalLabour() { return this.filteredLabourPayments.reduce((s: number, p: any) => s + (p.amount || 0), 0); }
  /**
   * Every debit entered on the layer Ledger screen — the same cost line the
   * broiler Report shows (`report.component.ts`, `totalLedgerDebit`) and the same
   * figure `overview.service.ts` (`qLayerLedgerDebits`) and
   * `farm-report.service.ts` (`specLayerLedgerDebits`) count, so the three agree.
   *
   * Strictly disjoint from `totalExpenses`: an `expenses` row and a
   * `layer_ledger_entries` row are rows in different tables, and nothing mirrors
   * one into the other — the layer Expenses screen writes `expenses` and nothing
   * else. So the two books partition this module's costs, each row counted once.
   * There is no `source` guard to carry here because there is no mirror kind of
   * row to exclude; that guard belongs to `ledger_entries` and its history.
   *
   * Credits are excluded, as on the broiler side: a credit is money back, not a
   * cost, and subtracting it would understate what the batch spent.
   */
  get totalLedgerDebit() {
    return this.filteredLedgerEntries
      .filter((e: any) => e.type === 'debit')
      .reduce((s: number, e: any) => s + (e.amount || 0), 0);
  }
  get netProfitLoss() { return (this.totalEggSales + this.totalHenSales + this.totalIncome) - (this.totalFeedAmount + this.totalChickAmount + this.totalMedicineAmount + this.totalVaccinationCost + this.totalLabour + this.totalExpenses + this.totalLedgerDebit); }
  /**
   * Every layer revenue source this report accounts for — egg sales, hen sales,
   * and other income (`module_type='layer'`, sale mirrors excluded by
   * `filteredIncome`, so each sale is counted exactly once).
   */
  get layerTotalIncome() { return this.totalEggSales + this.totalHenSales + this.totalIncome; }

  getMedicineTraderEntries(traderId: number): any[] {
    return this.filteredMedicineEntries.filter(e => e.trader_id === traderId);
  }
  getMedicineTraderTotal(traderId: number): number {
    return this.getMedicineTraderEntries(traderId).reduce((s, e) => s + (e.total_amount || 0), 0);
  }
  getFeedTraderEntries(traderId: number): any[] {
    return this.filteredFeedEntries.filter(e => e.trader_id === traderId);
  }
  getFeedTraderTotal(traderId: number): number {
    return this.getFeedTraderEntries(traderId).reduce((s, e) => s + (e.total_amount || 0), 0);
  }
  getChickTraderEntries(traderId: number) {
    return this.filteredChickEntries.filter((e: any) => e.trader_id === traderId);
  }
  getChickTraderTotal(traderId: number) {
    return this.getChickTraderEntries(traderId).reduce((s: number, e: any) => s + (e.total_amount || 0), 0);
  }
  getLedgerEntries(ledgerId: number): any[] {
    return this.filteredLedgerEntries.filter((e: any) => e.ledger_id === ledgerId);
  }
  getLedgerTotal(ledgerId: number): number {
    return this.getLedgerEntries(ledgerId).reduce((s: number, e: any) => s + (e.amount || 0), 0);
  }

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private flockService: FlockService,
    private farmUnitService: FarmUnitService, private dataChange: DataChangeService
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // Load units first — the currentUnit$ subscription below fires
    // synchronously (BehaviorSubject) and its filtering depends on
    // this.units already being populated.
    await this.loadUnits();
    await this.loadData();
    this.applyActiveBatch(this.flockService.getCurrentFlock());
    this.loadPreferences();
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

  ngOnDestroy() { this.subs.unsubscribe(); }

  private applyActiveBatch(flock: any) {
    if (!flock?.batch_id) return;
    const batchId = String(flock.batch_id);
    if (this.selectedBatchFilter === batchId) return;
    this.selectedBatchFilter = batchId;
    this.loadPreferences();
    this.cdr.detectChanges();
  }

  async loadData() {
    if (!this.currentFarm) return;
    const farmId = this.currentFarm.farm_id;
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty report.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;
    const unitClause = unitId ? ' AND b.unit_id = ?' : '';
    const unitSubClause = unitId ? ' AND unit_id = ?' : '';
    const unitParam = unitId ? [unitId] : [];

    const [batches, eggColl, eggSale, henSale, vacc, mort, exp, medT, medE, feedT, feedE, chickT, chickE, inc, labourP, ledg, ledgE] = await Promise.all([
      this.db.get(`SELECT * FROM batches WHERE farm_id = ?${unitId ? ' AND unit_id = ?' : ''} ORDER BY batch_id DESC`, [farmId, ...unitParam]),
      this.db.get(`SELECT ec.*, b.batch_name FROM egg_collection ec JOIN batches b ON ec.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY ec.date DESC`, [farmId, ...unitParam]),
      this.db.get(`SELECT es.*, b.batch_name FROM egg_sales es JOIN batches b ON es.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY es.date DESC`, [farmId, ...unitParam]),
      this.db.get(`SELECT hs.*, b.batch_name FROM hen_sales hs JOIN batches b ON hs.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY hs.date DESC`, [farmId, ...unitParam]),
      this.db.get(`SELECT v.*, b.batch_name FROM vaccinations v JOIN batches b ON v.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY v.date DESC`, [farmId, ...unitParam]),
      // Mortality now comes off layer_health (the Flock Health screen), not the
      // superseded layer_mortality table. `count` and `reason` are aliased so the
      // PDF section below keeps the shape it already expects. Rows with no mortality
      // are excluded — a health row recording only feed is not a mortality entry.
      this.db.get(`SELECT lh.*, lh.mortality AS count, lh.notes AS reason, b.batch_name FROM layer_health lh JOIN batches b ON lh.batch_id = b.batch_id WHERE b.farm_id = ? AND COALESCE(lh.mortality, 0) > 0${unitClause} ORDER BY lh.date DESC`, [farmId, ...unitParam]),
      this.db.get(`SELECT e.*, b.batch_name FROM expenses e JOIN batches b ON e.flock_id = b.batch_id WHERE b.farm_id = ? AND e.module_type = ?${unitClause} ORDER BY e.date DESC`, [farmId, 'layer', ...unitParam]),
      this.db.get(`SELECT * FROM medicine_traders WHERE flock_id IN (SELECT batch_id FROM batches WHERE farm_id = ?${unitSubClause}) AND module_type = ?`, [farmId, ...unitParam, 'layer']),
      this.db.get(`SELECT me.*, mt.trader_name, b.batch_name FROM medicine_entries me JOIN medicine_traders mt ON me.trader_id = mt.trader_id JOIN batches b ON me.flock_id = b.batch_id WHERE b.farm_id = ? AND me.module_type = ?${unitClause} ORDER BY me.date DESC`, [farmId, 'layer', ...unitParam]),
      this.db.get(`SELECT * FROM feed_traders WHERE flock_id IN (SELECT batch_id FROM batches WHERE farm_id = ?${unitSubClause}) AND module_type = ?`, [farmId, ...unitParam, 'layer']),
      this.db.get(`SELECT fe.*, ft.trader_name, b.batch_name FROM feed_entries fe JOIN feed_traders ft ON fe.trader_id = ft.trader_id JOIN batches b ON fe.flock_id = b.batch_id WHERE b.farm_id = ? AND fe.module_type = ?${unitClause} ORDER BY fe.date DESC`, [farmId, 'layer', ...unitParam]),
      this.db.get(`SELECT * FROM chick_traders WHERE flock_id IN (SELECT batch_id FROM batches WHERE farm_id = ?${unitSubClause}) AND module_type = ?`, [farmId, ...unitParam, 'layer']),
      this.db.get(`SELECT ce.*, ct.trader_name, b.batch_name FROM chick_entries ce JOIN chick_traders ct ON ce.trader_id = ct.trader_id JOIN batches b ON ce.flock_id = b.batch_id WHERE b.farm_id = ? AND ce.module_type = ?${unitClause} ORDER BY ce.date DESC`, [farmId, 'layer', ...unitParam]),
      this.db.get(`SELECT i.*, b.batch_name FROM income i JOIN batches b ON i.flock_id = b.batch_id WHERE b.farm_id = ? AND i.module_type = ?${unitClause} ORDER BY i.date DESC`, [farmId, 'layer', ...unitParam]),
      // LEFT JOIN on `labour`: a worker deleted off the roster keeps their
      // payments, and the layer report must still show that cost — the Overview
      // and Farm Report totals include it.
      this.db.get(`SELECT lp.*, COALESCE(l.labour_name, 'Deleted Worker') AS labour_name, b.batch_name FROM labour_payments lp LEFT JOIN labour l ON lp.labour_id = l.labour_id JOIN batches b ON lp.flock_id = b.batch_id WHERE b.farm_id = ? AND lp.module_type = ?${unitClause} ORDER BY lp.date DESC`, [farmId, 'layer', ...unitParam]),
      // The layer Ledger book. Its own batch-keyed tables, so no module_type
      // guard is possible or needed — a broiler flock's ledger rows live in
      // `ledgers`/`ledger_entries` and can never appear here, whatever the id.
      this.db.get(`SELECT l.*, b.batch_name FROM layer_ledgers l JOIN batches b ON l.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY l.ledger_name ASC`, [farmId, ...unitParam]),
      this.db.get(`SELECT le.*, l.ledger_name, b.batch_name FROM layer_ledger_entries le JOIN layer_ledgers l ON le.ledger_id = l.ledger_id JOIN batches b ON le.batch_id = b.batch_id WHERE b.farm_id = ?${unitClause} ORDER BY le.date DESC`, [farmId, ...unitParam])
    ]);

    this.batches = batches.success ? batches.data : [];
    this.eggCollections = eggColl.success ? eggColl.data : [];
    this.eggSales = eggSale.success ? eggSale.data : [];
    this.henSales = henSale.success ? henSale.data : [];
    this.vaccinations = vacc.success ? vacc.data : [];
    this.mortalities = mort.success ? mort.data : [];
    this.expenses = exp.success ? exp.data : [];
    this.medicineTraders = medT.success ? medT.data : [];
    this.medicineEntries = medE.success ? medE.data : [];
    this.feedTraders = feedT.success ? feedT.data : [];
    this.feedEntries = feedE.success ? feedE.data : [];
    this.chickTraders = chickT.success ? chickT.data : [];
    this.chickEntries = chickE.success ? chickE.data : [];
    this.income = inc.success ? inc.data : [];
    this.labourPayments = labourP.success ? labourP.data : [];
    this.ledgers = ledg.success ? ledg.data : [];
    this.ledgerEntries = ledgE.success ? ledgE.data : [];
    this.cdr.detectChanges();
  }

  async generatePDF() {
    this.isGenerating = true;
    this.savePreferences();

    try {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const farmName = this.currentFarm?.farm_name || 'Poultry Farm';
      const today = new Date().toLocaleDateString('en-PK');
      const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
      const formatDate = (d: any) => { if (!d) return '—'; const p = String(d).split('T')[0].split(' ')[0].split('-'); return (p.length === 3 && p[0].length === 4) ? `${p[2]}-${p[1]}-${p[0]}` : String(d); };
      const BLACK: [number,number,number] = [0,0,0];
      const GRAY: [number,number,number] = [120,120,120];
      const LGRAY: [number,number,number] = [200,200,200];

      // Background image
      let bgImgData: string | null = null;
      let bgW = 0; let bgH = 0;
      try {
        // Same watermark as the broiler Report (`report.component.ts`) — the
        // FarmInfantary logo, not the generic `/logo.png?v=20261026`.
        bgImgData = await this.loadImageAsBase64('/logo.png?v=20261026');
        const bgProps = doc.getImageProperties(bgImgData);
        bgW = 140;
        bgH = (bgProps.height * bgW) / bgProps.width;
      } catch {}

      const drawBackground = () => {
        if (bgImgData) {
          doc.saveGraphicsState();
          doc.setGState(new (doc as any).GState({ opacity: 0.08 }));
          doc.addImage(bgImgData, 'PNG', (pageWidth - bgW) / 2, (pageHeight - bgH) / 2, bgW, bgH);
          doc.restoreGraphicsState();
        }
      };

      // BW table helper
      const bwTable = (startY: number, head: string[][], body: any[][], foot?: any[][], amountCol?: number, extraColumnStyles?: any) => {
        const colStyles: any = { ...extraColumnStyles };
        if (amountCol !== undefined) colStyles[amountCol] = { halign: 'right' };
        autoTable(doc, {
          startY,
          head,
          body,
          foot: foot || undefined,
          theme: 'plain',
          headStyles: { fontStyle: 'bold', fontSize: 9, textColor: BLACK, fillColor: false as any, lineWidth: { bottom: 0.3 }, lineColor: BLACK },
          bodyStyles: { fontSize: 9, textColor: BLACK, fillColor: false as any, lineWidth: { bottom: 0.15 }, lineColor: LGRAY },
          footStyles: { fontStyle: 'bold', fontSize: 9, textColor: BLACK, fillColor: false as any, lineWidth: { top: 0.3 }, lineColor: BLACK },
          alternateRowStyles: { fillColor: false as any },
          columnStyles: colStyles,
          margin: { left: 14, right: 14 },
          // jspdf-autotable only applies columnStyles to the body section — head/foot
          // cells otherwise fall back to headStyles/footStyles' default (left) halign,
          // so a right-aligned amount column's header and totals row drift left of its values.
          didParseCell: alignHeadFootWithColumnStyles
        });
        return (doc as any).lastAutoTable.finalY;
      };

      // `isFirstSection` forced a page break before the first section, on the
      // reasoning that page 1 is the cover. That is right while the SUMMARY is
      // on — it fills page 1 — and wrong when it is off, because page 1 was
      // then left holding nothing but the logo and the watermark while the one
      // selected section started on page 2. Selecting a single section gave a
      // two-page PDF with a branding-only first page. Present since v1.0.0.
      //
      // It is cleared below once the cover is drawn, IF the cover is all that
      // is on page 1 — at which point the existing `(pageHeight - y) < 80`
      // rule takes over and lays the section out on page 1 like any other
      // section that fits. Nothing about the header, the logo or the watermark
      // changes.
      let isFirstSection = true;
      let y = 0;

      const addPage = (title: string) => {
        if (isFirstSection || (pageHeight - y) < 80) {
          doc.addPage();
          drawBackground();
          doc.setDrawColor(...LGRAY);
          doc.setLineWidth(0.3);
          doc.line(14, 12, pageWidth - 14, 12);
          doc.setFontSize(8);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...GRAY);
          doc.text('FarmInfantary', 14, 9);
          doc.text(today, pageWidth - 14, 9, { align: 'right' });
          y = 22;
        } else {
          y += 12;
        }
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...BLACK);
        doc.text(title.toUpperCase(), 14, y);
        doc.setDrawColor(...BLACK);
        doc.setLineWidth(0.4);
        doc.line(14, y + 3, pageWidth - 14, y + 3);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...BLACK);
        y += 8;
        isFirstSection = false;
      };

      // Cover page
      let coverY = 20;
      drawBackground();

      try {
        const imgData = await this.loadImageAsBase64('/logo.png?v=20261026');
        const imgProps = doc.getImageProperties(imgData);
        const logoHeight = 35;
        const logoWidth = (imgProps.width * logoHeight) / imgProps.height;
        const textX = 14 + logoWidth + 10;
        doc.addImage(imgData, 'PNG', 14, coverY, logoWidth, logoHeight);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...BLACK);
        doc.text('FarmInfantary', textX, coverY + 8);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
        doc.text('', textX, coverY + 14);
        doc.text('', textX, coverY + 19);
        doc.text('', textX, coverY + 24);
        doc.setFontSize(10);
        doc.text('Generated: ' + today, textX, coverY + 30);
        coverY += logoHeight + 8;
      } catch {}

      doc.setDrawColor(...BLACK); doc.setLineWidth(0.5); doc.line(14, coverY, pageWidth - 14, coverY); coverY += 8;

      // Summary
      if (this.sections.summary) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BLACK);
        doc.text('SUMMARY', 14, coverY); coverY += 6;
        const batchLabel = this.selectedBatchFilter === 'all'
          ? String(this.batches.length)
          : (this.batches.find(b => String(b.batch_id) === String(this.selectedBatchFilter))?.batch_name || '1');
        const summary: [string, string][] = [
          [this.selectedBatchFilter === 'all' ? 'Total Batches' : 'Batch', batchLabel],
          ['Total Eggs Collected', this.totalEggs.toLocaleString()],
          ['Total Egg Sales', 'Rs. ' + this.totalEggSales.toLocaleString()],
          ['Total Hen Sales', 'Rs. ' + this.totalHenSales.toLocaleString()],
          ['Other Income', 'Rs. ' + this.totalIncome.toLocaleString()],
          ['Total Income', 'Rs. ' + this.layerTotalIncome.toLocaleString()],
          // ONE expense line, the `expenses` table alone — named as the broiler
          // Report names it (`report.component.ts`). Medicine, feed, vaccination
          // and labour each get their own line below, so a combined total here
          // was the same costs listed twice on one page.
          ['Other Expenses', 'Rs. ' + this.totalExpenses.toLocaleString()],
          // A separate book from Expenses, on top of it — never inside it. Same
          // line, same meaning, as the broiler Report's.
          ['Ledger Debit', 'Rs. ' + this.totalLedgerDebit.toLocaleString()],
          ['Medicine Cost', 'Rs. ' + this.totalMedicineAmount.toLocaleString()],
          ['Total Feed Cost', 'Rs. ' + this.totalFeedAmount.toLocaleString()],
          ['Chick Cost', 'Rs. ' + this.totalChickAmount.toLocaleString()],
          ['Vaccination Cost', 'Rs. ' + this.totalVaccinationCost.toLocaleString()],
          ['Labour Cost', 'Rs. ' + this.totalLabour.toLocaleString()],
          ['Total Mortality', this.totalMortality.toLocaleString()],
          [this.netProfitLoss >= 0 ? 'Net Profit' : 'Net Loss', 'Rs. ' + Math.abs(this.netProfitLoss).toLocaleString()]
        ];
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
        for (const [l, v] of summary) { doc.setTextColor(...GRAY); doc.text(l + ':', 14, coverY); doc.setTextColor(...BLACK); doc.text(v, 90, coverY); coverY += 6; }
      }

      // With the summary on, page 1 is full enough that a table squeezed under
      // it would read badly, so the break before the first section stays — and
      // every multi-section report keeps the layout it has always had. With the
      // summary off, page 1 holds only the cover, so the section cursor is
      // handed the cover's own end position and addPage() lays the first
      // section out on page 1 through the same room check as any other.
      if (!this.sections.summary) {
        y = coverY;
        isFirstSection = false;
      }

      // Egg Collection
      if (this.sections.eggCollection && this.filteredEggCollections.length > 0) {
        addPage('Egg Collection');
        y = bwTable(y, [['Date', 'Batch', 'Total', 'Broken', 'Small', 'Medium', 'Large', 'XL']],
          this.filteredEggCollections.map(e => [formatDate(e.date), e.batch_name, String(e.total_eggs), String(e.broken_eggs), String(e.small_grade), String(e.medium_grade), String(e.large_grade), String(e.xl_grade)]));
      }

      // Egg Sales
      if (this.sections.eggSales && this.filteredEggSales.length > 0) {
        addPage('Egg Sales');
        const eggBody = this.filteredEggSales.map(s => {
          const isPerCarton = s.sale_mode === 'per_carton';
          return [
            formatDate(s.date), s.batch_name, s.customer_name || '—', s.grade,
            isPerCarton ? 'Per Carton' : 'Per Egg',
            String(s.quantity),
            isPerCarton ? `${(s.carton_count || 0).toLocaleString()} × ${s.eggs_per_carton || 360}` : '—',
            'Rs. ' + (s.rate_per_egg || 0).toLocaleString() + (isPerCarton ? '/carton' : '/egg'),
            'Rs. ' + (s.total_amount || 0).toLocaleString()
          ];
        });
        y = bwTable(y, [['Date', 'Batch', 'Customer', 'Grade', 'Mode', 'Qty', 'Cartons', 'Rate', 'Amount']], eggBody,
          [['', '', '', '', '', '', '', 'Total', 'Rs. ' + this.totalEggSales.toLocaleString()]], 8, { 7: { halign: 'right' } });
      }

      // Hen Sales
      if (this.sections.henSales && this.filteredHenSales.length > 0) {
        addPage('Hen Sales');
        const henBody = this.filteredHenSales.map(s => {
          const isPerKg = s.pricing_mode === 'per_kg';
          return [
            formatDate(s.date), s.batch_name, s.customer_name || '—',
            isPerKg ? 'Per Kg' : 'Per Hen',
            String(s.quantity),
            isPerKg ? `${(s.total_weight || 0).toLocaleString()} kg` : '—',
            'Rs. ' + (s.rate_per_hen || 0).toLocaleString() + (isPerKg ? '/kg' : '/hen'),
            'Rs. ' + (s.total_amount || 0).toLocaleString()
          ];
        });
        y = bwTable(y, [['Date', 'Batch', 'Customer', 'Mode', 'Qty', 'Weight', 'Rate', 'Amount']], henBody,
          [['', '', '', '', '', '', 'Total', 'Rs. ' + this.totalHenSales.toLocaleString()]], 7, { 6: { halign: 'right' } });
      }

      // Expenses
      if (this.sections.expenses && this.filteredExpenses.length > 0) {
        addPage('Other Expenses');
        y = bwTable(y, [['Date', 'Batch', 'Description', 'Amount (Rs.)']],
          this.filteredExpenses.map(e => [formatDate(e.date), e.batch_name || 'N/A', e.description || 'N/A', (e.amount || 0).toLocaleString()]),
          [['', '', 'Total', this.totalExpenses.toLocaleString()]], 3);
      }

      // Ledgers — one page per ledger, same shape as the broiler Report's.
      if (this.sections.ledgers) {
        for (const ledger of this.filteredLedgers) {
          const entries = this.getLedgerEntries(ledger.ledger_id);
          if (entries.length === 0) continue;
          addPage(`Ledger: ${ledger.ledger_name}`);
          y = bwTable(y, [['Date', 'Batch', 'Description', 'Type', 'Amount (Rs.)']],
            entries.map((e: any) => [formatDate(e.date), e.batch_name || 'N/A', e.description || '—', e.type === 'credit' ? 'Credit' : 'Debit', (e.amount || 0).toLocaleString()]),
            [['', '', '', 'Total', this.getLedgerTotal(ledger.ledger_id).toLocaleString()]], 4);
        }
      }

      // Medicine
      if (this.sections.medicine && this.medicineTraders.length > 0) {
        for (const trader of this.medicineTraders) {
          const entries = this.getMedicineTraderEntries(trader.trader_id);
          if (entries.length === 0) continue;
          addPage(`Medicine: ${trader.trader_name}`);
          y = bwTable(y, [['Date', 'Batch', 'Medicine', 'Qty', 'Price/Unit (Rs.)', 'Total (Rs.)']],
            entries.map(e => [formatDate(e.date), e.batch_name || 'N/A', e.medicine_name || 'N/A', e.quantity, (e.price_per_unit || 0).toLocaleString(), (e.total_amount || 0).toLocaleString()]),
            [['', '', '', '', 'Total', this.getMedicineTraderTotal(trader.trader_id).toLocaleString()]], 5, { 4: { halign: 'right' } });
        }
      }

      // Feed
      if (this.sections.feed && this.feedTraders.length > 0) {
        for (const trader of this.feedTraders) {
          const entries = this.getFeedTraderEntries(trader.trader_id);
          if (entries.length === 0) continue;
          addPage(`Feed: ${trader.trader_name}`);
          y = bwTable(y, [['Date', 'Feed', 'Qty', 'Price/Unit (Rs.)', 'Total (Rs.)']],
            entries.map(e => [formatDate(e.date), e.feed_name || '—', e.quantity, (e.price_per_unit || 0).toLocaleString(), (e.total_amount || 0).toLocaleString()]),
            [['', '', '', 'Total', this.getFeedTraderTotal(trader.trader_id).toLocaleString()]], 4, { 3: { halign: 'right' } });
        }
      }

      // Chicks. On the layer side these can only have arrived from
      // Distribution — the Chicks screen sits on the broiler menu — so the
      // section is simply empty on a batch that was never billed for any.
      if (this.sections.chicks && this.chickTraders.length > 0) {
        for (const trader of this.chickTraders) {
          const entries = this.getChickTraderEntries(trader.trader_id);
          if (entries.length === 0) continue;
          addPage(trader.trader_name === 'Internal Distribution' ? 'Chick Purchases' : `Chicks: ${trader.trader_name}`);
          y = bwTable(y, [['Date', 'Chick Type', 'Qty', 'Price/Chick (Rs.)', 'Total (Rs.)']],
            entries.map(e => [formatDate(e.date), e.chick_name || '—', e.quantity, (e.price_per_unit || 0).toLocaleString(), (e.total_amount || 0).toLocaleString()]),
            [['', '', '', 'Total', this.getChickTraderTotal(trader.trader_id).toLocaleString()]], 4, { 3: { halign: 'right' } });
        }
      }

      // Vaccinations
      if (this.sections.vaccinations && this.filteredVaccinations.length > 0) {
        addPage('Vaccinations');
        y = bwTable(y, [['Date', 'Batch', 'Vaccine', 'Dose', 'Notes', 'Cost (Rs.)', 'Done']],
          this.filteredVaccinations.map(v => [formatDate(v.date), v.batch_name, v.vaccine_name || '—', v.dose || '—', v.notes || '—', (v.cost || 0).toLocaleString(), v.done ? 'Yes' : 'No']),
          [['', '', '', '', '', this.totalVaccinationCost.toLocaleString(), '']], 5);
      }

      // Mortality
      if (this.sections.mortality && this.filteredMortalities.length > 0) {
        addPage('Mortality');
        y = bwTable(y, [['Date', 'Batch', 'Count', 'Reason']],
          this.filteredMortalities.map(m => [formatDate(m.date), m.batch_name, String(m.count), m.reason || '—']),
          [['', 'Total', String(this.totalMortality), '']], 2);
      }

      // Labour
      if (this.sections.labour && this.filteredLabourPayments.length > 0) {
        addPage('Labour Payments');
        y = bwTable(y, [['Date', 'Batch', 'Labour', 'Description', 'Payment Type', 'Amount (Rs.)']],
          // Labour payments can now be paid by bank, so the label is taken from
          // the value rather than from a two-way guess that showed
          // everything-not-cash as "Credit".
          this.filteredLabourPayments.map(p => [formatDate(p.date), p.batch_name || 'N/A', p.labour_name || '—', p.description || '—', labourPaymentLabel(p), (p.amount || 0).toLocaleString()]),
          [['', '', '', '', 'Total', this.totalLabour.toLocaleString()]], 5);
      }

      // Income
      if (this.sections.income && this.filteredIncome.length > 0) {
        addPage('Income');
        y = bwTable(y, [['Date', 'Batch', 'Description', 'Source', 'Amount (Rs.)']],
          // Sale mirrors are filtered out of `filteredIncome`, so every row here is manual.
          this.filteredIncome.map(i => [formatDate(i.date), i.batch_name || 'N/A', i.description || 'N/A', 'Manual', (i.amount || 0).toLocaleString()]),
          [['', '', '', 'Total', this.totalIncome.toLocaleString()]], 4);
      }

      // Footer
      const totalPages = (doc.internal as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5);
        doc.setTextColor(...GRAY);
        doc.text(footer, pageWidth / 2, pageHeight - 9, { align: 'center' });
        doc.text('Page ' + i + ' of ' + totalPages, pageWidth / 2, pageHeight - 4, { align: 'center' });
      }

      await this.printPdf(doc, farmName + '-Layer-Report.pdf');
    } finally { this.isGenerating = false; this.cdr.detectChanges(); }
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

  private loadImageAsBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')!.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}
