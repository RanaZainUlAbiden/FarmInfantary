import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../shared/services/auth.service';
import { DatabaseService } from '../shared/services/database.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import {
  FarmReportService,
  FarmReportSummary,
  FarmReportModule as FarmReportModuleType
} from '../shared/services/farm-report.service';
import { CashPositionService, CashPosition, FarmCashPosition } from '../shared/services/cash-position.service';
import { toLocalDateString } from '../shared/utils/date.util';
import { Subscription } from 'rxjs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles } from '../shared/utils/pdf-table.util';

/**
 * Farm Report — every flock/batch of the farm selected in the sidebar, over a
 * date range. Rendering only: all SQL and aggregation lives in
 * `farm-report.service.ts`.
 *
 * The screen is reachable from both the Broiler and the Layer menu on the
 * same route, so the module is read from the sidebar's active business tab
 * (the same `localStorage` keys `layout.component.ts` writes) rather than
 * from the URL.
 */
@Component({
  selector: 'app-farm-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './farm-report.component.html',
  styleUrl: './farm-report.component.scss'
})
export class FarmReportComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  moduleType: FarmReportModuleType = 'broiler';

  /** Farms (`farm_units`) belonging to this account for the active module. */
  units: any[] = [];
  /** The farm selected in the sidebar. */
  currentUnit: any = null;

  dateFrom = '';
  dateTo = '';

  report: FarmReportSummary | null = null;

  /**
   * Cash in hand and total bank balance AS OF THE END OF THE RANGE — the
   * report answers "as of this date you had Rs. X in cash and Rs. Y in bank",
   * so the figures stop where the report stops. `dateTo` is passed as the
   * cut-off and `dateFrom` deliberately is NOT: a balance is a stock at a
   * point, not a flow across a range (see `CashPositionService`).
   *
   * ACCOUNT-WIDE, not per-farm: there is one cash drawer and one set of bank
   * accounts behind every farm on the login, so these are not scoped to the
   * farm this report covers. Labelled as such wherever they are shown.
   *
   * ONE OBJECT FEEDS BOTH BLOCKS — the cards at the top and the footer at the
   * bottom, on screen and in the PDF — so the same page can never print two
   * different answers to "how much cash do I have".
   */
  cashPosition: CashPosition | null = null;
  /**
   * THIS FARM's own cash, which is what the report prints — the client asked
   * for the selected farm's figure rather than the whole account's.
   *
   * A different quantity from `cashPosition.cashInHand` and not a second
   * opinion on it: see `FarmCashPosition`. `cashPosition` is still loaded,
   * because the BANK total beside it is account-wide (a bank account belongs
   * to no farm) and because the footer's Total Money needs both halves.
   */
  farmCash: FarmCashPosition | null = null;
  isLoading = true;
  isGenerating = false;

  private subs = new Subscription();

  get isLayer(): boolean { return this.moduleType === 'layer'; }
  get flockWord(): string { return this.isLayer ? 'Batch' : 'Flock'; }
  get flockWordPlural(): string { return this.isLayer ? 'Batches' : 'Flocks'; }

  /** Farms exist but none is active — the user has to pick one in the sidebar. */
  get noFarmSelected(): boolean {
    return this.units.length > 0 && !this.currentUnit;
  }

  get unitName(): string {
    return this.currentUnit?.unit_name || 'All Farms';
  }

  constructor(
    private authService: AuthService,
    private db: DatabaseService,
    private farmUnitService: FarmUnitService, private dataChange: DataChangeService,
    private farmReport: FarmReportService,
    private cashPositionService: CashPositionService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();

    // Default range: the current year to date. Built from local date parts —
    // toISOString() would shift a PKT morning onto the previous day.
    const today = new Date();
    this.dateFrom = toLocalDateString(new Date(today.getFullYear(), 0, 1));
    this.dateTo = toLocalDateString(today);

    await this.resolveScope();
    await this.generate();

    // currentUnit$ replays synchronously on subscribe, so the guard below
    // stops the initial replay from running a second identical query.
    this.subs.add(
      this.farmUnitService.currentUnit$.subscribe(unit => {
        if (!unit || unit.module_type !== this.moduleType) return;
        if (unit.unit_id === this.currentUnit?.unit_id) return;
        this.currentUnit = unit;
        this.generate();
      })
    );

    this.subs.add(
      this.farmUnitService.moduleChanged$.subscribe(async () => {
        await this.resolveScope();
        await this.generate();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.resolveScope();
        await this.generate();
      })
    );
  }

  ngOnDestroy() { this.subs.unsubscribe(); }

  // ── Scope ─────────────────────────────────────────────────

  /**
   * The layout writes the active tab to localStorage before it navigates, so
   * that is the authoritative answer for which module this screen is showing.
   * The sidebar's active unit is only a fallback for the cases the tab can't
   * describe.
   */
  private detectModule(): FarmReportModuleType {
    const businessType = localStorage.getItem('businessType') || 'broiler';
    const tab = businessType === 'all'
      ? (localStorage.getItem('activeBusinessTab') || 'broiler')
      : businessType;
    if (tab === 'layer') return 'layer';
    if (tab === 'broiler') return 'broiler';
    return this.farmUnitService.getCurrentUnit()?.module_type === 'layer' ? 'layer' : 'broiler';
  }

  private async resolveScope() {
    this.moduleType = this.detectModule();

    if (!this.currentFarm?.farm_id) {
      this.units = [];
      this.currentUnit = null;
      return;
    }

    const res = await this.db.getFarmUnits(this.currentFarm.farm_id, this.moduleType);
    this.units = res?.success ? res.data : [];

    // Only the ID comes from the shared service — field values (like
    // opening_balance) are always looked up in the list we just fetched
    // ourselves, so an edit made on the Farms screen shows up here the
    // instant unitsChanged$ fires rather than depending on FarmUnitService's
    // own cached object having been refreshed first.
    const activeId = this.farmUnitService.getCurrentUnit()?.unit_id;
    const activeBelongsHere = activeId != null && this.units.find((u: any) => u.unit_id === activeId);

    this.currentUnit = activeBelongsHere || (this.units[0] || null);
  }

  // ── Generate ──────────────────────────────────────────────

  async generate() {
    this.isLoading = true;
    this.cdr.detectChanges();

    const farmId = this.currentFarm?.farm_id;
    if (!farmId || this.noFarmSelected) {
      this.report = null;
      this.cashPosition = null;
      this.farmCash = null;
      this.isLoading = false;
      this.cdr.detectChanges();
      return;
    }

    // No farms defined at all — cover every flock of this module rather than
    // reporting on nothing, matching how the rest of the app degrades for
    // accounts created before farm units existed.
    const unitId = this.units.length > 0 ? (this.currentUnit?.unit_id ?? null) : null;

    this.report = await this.farmReport.getReport(
      farmId,
      unitId,
      this.moduleType,
      this.unitName,
      { from: this.dateFrom || null, to: this.dateTo || null },
      this.currentUnit?.opening_balance ?? 0
    );

    // Two figures, stopped at the END of the range. `dateFrom` is not passed to
    // either — a range-FROM would turn a balance into a flow.
    //
    //   farmCash      THIS farm's own recorded cash movements, which is the
    //                 Cash figure the report prints.
    //   cashPosition  the whole account, loaded for its BANK total — a bank
    //                 account belongs to no farm, so that half cannot be
    //                 scoped and its label says so.
    [this.farmCash, this.cashPosition] = await Promise.all([
      this.cashPositionService.getFarmCashPosition(
        farmId, this.moduleType === 'layer' ? 'layer' : 'broiler', unitId, this.dateTo || null),
      this.cashPositionService.getCashPosition(farmId, this.dateTo || null)
    ]);

    this.isLoading = false;
    this.cdr.detectChanges();
  }

  resetDateFilter() {
    const today = new Date();
    this.dateFrom = toLocalDateString(new Date(today.getFullYear(), 0, 1));
    this.dateTo = toLocalDateString(today);
    this.generate();
  }

  // ── Display helpers ───────────────────────────────────────

  formatDate(d: any): string {
    if (!d) return '—';
    const p = String(d).split('T')[0].split(' ')[0].split('-');
    return (p.length === 3 && p[0].length === 4) ? `${p[2]}-${p[1]}-${p[0]}` : String(d);
  }

  get rangeLabel(): string {
    return `${this.formatDate(this.dateFrom)} to ${this.formatDate(this.dateTo)}`;
  }

  /**
   * "as of 31-03-2026" — read off the FIGURE's own cut-off, not off the form,
   * so a block can never be labelled with a date the numbers were not stopped
   * at (the user may have edited the input since Generate was pressed).
   */
  get asOfLabel(): string {
    return this.cashPosition?.asOf ? this.formatDate(this.cashPosition.asOf) : 'today';
  }

  /**
   * This farm's cash plus the account's bank balance.
   *
   * The two halves are scoped differently and the footer says so: there is no
   * per-farm bank balance to use instead, because a bank account belongs to the
   * owner rather than to a farm.
   */
  get totalMoney(): number {
    return (this.farmCash?.farmCashInHand || 0) + (this.cashPosition?.totalBankBalance || 0);
  }

  /** The farm's own cash figure, or 0 before the first Generate. */
  get farmCashInHand(): number {
    return this.farmCash?.farmCashInHand || 0;
  }

  // ── PDF Generation ────────────────────────────────────────
  //
  // Setup below is lifted from report.component.ts so the two documents are
  // indistinguishable: same logo block, same bwTable/drawFooter helpers, same
  // BLACK/GRAY/LGRAY constants, same DD-MM-YYYY formatDate, same footer text,
  // same page numbering and section headings. Do not restyle it in isolation.
  async generatePDF() {
    if (!this.report) return;
    this.isGenerating = true;

    try {
      const r          = this.report;
      const doc        = new jsPDF();
      const pageWidth  = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const unitName   = r.unitName || 'Farm';
      const farmName   = this.currentFarm?.farm_name   || 'Poultry Farm';
      const today      = new Date().toLocaleDateString('en-PK');
      const footer     = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
      const formatDate = (d: any) => {
        if (!d) return '—';
        const p = String(d).split('T')[0].split(' ')[0].split('-');
        return (p.length === 3 && p[0].length === 4) ? `${p[2]}-${p[1]}-${p[0]}` : String(d);
      };

      const BLACK: [number,number,number]       = [0,   0,   0  ];
      const GRAY:  [number,number,number]       = [120, 120, 120];
      const LGRAY: [number,number,number]       = [200, 200, 200];

      const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

      // The date the cash and bank figures are stated as of — taken off the
      // figures themselves, never off the form, so the label and the numbers
      // cannot describe different days.
      const asOf = this.asOfLabel;

      let y = 0;
      let isFirstSection = true;

      // ── BW table style ───────────────────────────────────
      const bwTable = (startY: number, head: string[][], body: any[][], foot?: any[][], amountCol?: number, extraColumnStyles: any = {}) => {
        const colStyles: any = { ...extraColumnStyles };
        if (amountCol !== undefined) {
          colStyles[amountCol] = { ...(colStyles[amountCol] || {}), halign: 'right' };
        }
        autoTable(doc, {
          startY,
          head,
          body,
          foot: foot || undefined,
          theme: 'plain',
          headStyles: {
            fontStyle: 'bold',
            fontSize: 9,
            textColor: BLACK,
            fillColor: false as any,
            lineWidth: { bottom: 0.3 },
            lineColor: BLACK
          },
          bodyStyles: {
            fontSize: 9,
            textColor: BLACK,
            fillColor: false as any,
            lineWidth: { bottom: 0.15 },
            lineColor: LGRAY
          },
          footStyles: {
            fontStyle: 'bold',
            fontSize: 9,
            textColor: BLACK,
            fillColor: false as any,
            lineWidth: { top: 0.3 },
            lineColor: BLACK
          },
          alternateRowStyles: { fillColor: false as any },
          columnStyles: colStyles,
          margin: { left: 14, right: 14 },
          // jspdf-autotable only applies columnStyles to the body section — head/foot
          // cells otherwise fall back to headStyles/footStyles' default (left) halign,
          // so a right-aligned amount column's header and totals row drift left of its values.
          didParseCell: alignHeadFootWithColumnStyles
        });
        y = (doc as any).lastAutoTable.finalY;
      };

      // ── Footer helper ─────────────────────────────────────
      const drawFooter = (pageNum: number, totalPagesRef: { val: number }) => {
        doc.setPage(pageNum);
        doc.setFontSize(7.5);
        doc.setTextColor(...GRAY);
        doc.setFont('helvetica', 'normal');
        doc.text(footer, pageWidth / 2, pageHeight - 9, { align: 'center' });
        doc.setDrawColor(...LGRAY);
        doc.setLineWidth(0.2);
        doc.line(14, pageHeight - 12, pageWidth - 14, pageHeight - 12);
        doc.setTextColor(...GRAY);
        doc.text(`Page ${pageNum} of ${totalPagesRef.val}`, pageWidth / 2, pageHeight - 4, { align: 'center' });
      };

      // ── Background helper ─────────────────────────────────
      let bgImgData: string | null = null;
      let bgW = 0; let bgH = 0;
      try {
        bgImgData = await this.loadImageAsBase64('reportimage.png');
        const bgProps = doc.getImageProperties(bgImgData);
        bgW = 140; // a little large
        bgH = (bgProps.height * bgW) / bgProps.width;
      } catch {}

      const drawBackground = () => {
        if (bgImgData) {
          doc.saveGraphicsState();
          doc.setGState(new (doc as any).GState({ opacity: 0.1 }));
          doc.addImage(bgImgData, 'PNG', (pageWidth - bgW) / 2, (pageHeight - bgH) / 2, bgW, bgH);
          doc.restoreGraphicsState();
        }
      };

      // Draw background on first page
      drawBackground();

      // ════════════════════════════════════════════════════════
      // COVER PAGE
      // ════════════════════════════════════════════════════════
      let coverY = 20;

      // Logo — left side, text on right
      try {
        const imgData = await this.loadImageAsBase64('report-boiler.jpeg');
        const imgProps = doc.getImageProperties(imgData);
        const logoHeight = 35;
        const logoWidth = (imgProps.width * logoHeight) / imgProps.height;
        const textX = 14 + logoWidth + 10;

        doc.addImage(imgData, 'JPEG', 14, coverY, logoWidth, logoHeight);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(17);
        doc.setTextColor(...BLACK);
        doc.text('TALHA PROTEIN FARMS', textX, coverY + 8);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...GRAY);
        doc.text('Chak No 392 JB, Chatala, Toba Tek Singh', textX, coverY + 14);
        doc.text('Muhammad Tariq: 0321-7546630', textX, coverY + 19);
        doc.text('Ghulam Abbas: 0322-7778826', textX, coverY + 24);

        doc.setFontSize(10);
        doc.text('Farm: ' + unitName + ' (' + (r.moduleType === 'layer' ? 'Layer' : 'Broiler') + ')', textX, coverY + 30);
        doc.text('Period: ' + formatDate(this.dateFrom) + ' to ' + formatDate(this.dateTo), textX, coverY + 35);
        doc.text('Generated: ' + today, textX, coverY + 40);

        coverY += logoHeight + 8;
      } catch {}

      // Line below logo section
      doc.setDrawColor(...BLACK);
      doc.setLineWidth(0.5);
      doc.line(14, coverY, pageWidth - 14, coverY);
      coverY += 8;

      // Summary block
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...BLACK);
      doc.text('SUMMARY', 14, coverY);
      coverY += 6;

      const summaryLines: [string, string][] = [
        // Carried forward from the client's previous system, not app-calculated —
        // shown first and kept out of every figure below it until the final total.
        ['Opening Balance (carried forward)', rs(r.openingBalance)],
        ['Total Revenue',    rs(r.revenue.total)],
        ['Feed Cost',        rs(r.expenses.feed)],
        ['Medicine Cost',    rs(r.expenses.medicine)],
        ['Chick Cost',       rs(r.expenses.chicks)],
        ['Vaccination Cost', rs(r.expenses.vaccination)],
        ['Labour Cost',      rs(r.expenses.labour)],
        ['General Expenses', rs(r.expenses.general)],
        ['Ledger Debit', rs(r.expenses.ledgerDebits)],
        ['Total Expenses',   rs(r.expenses.total)],
        [r.netProfit >= 0 ? 'Net Profit (this period)' : 'Net Loss (this period)', rs(Math.abs(r.netProfit))],
        [r.totalWithOpeningBalance >= 0 ? 'Total (Opening Balance + Net Profit)' : 'Total (Opening Balance + Net Loss)',
          rs(Math.abs(r.totalWithOpeningBalance))],
        [this.flockWordPlural + ' in Period', String(r.flocks.length)],
        ['Birds Placed',     r.mortality.birdsPlaced.toLocaleString()],
        ['Mortality',        `${r.mortality.mortality.toLocaleString()} (${r.mortality.mortalityRate.toFixed(1)}%)`],
        // Outside Net Profit above, on purpose — the cost of this stock is
        // already in Total Expenses; this is the unpaid balance on the same
        // bills, not a second cost.
        ...(r.owedToDistribution.billed > 0
          ? ([
              ['Supplied by Distribution', rs(r.owedToDistribution.billed)],
              ['Still Owed to Distribution (not in Net Profit)', rs(r.owedToDistribution.outstanding)]
            ] as [string, string][])
          : [])
      ];

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      for (const [label, value] of summaryLines) {
        doc.setTextColor(...GRAY);
        doc.text(label + ':', 14, coverY);
        doc.setTextColor(...BLACK);
        doc.text(value, 90, coverY);
        coverY += 6;
      }

      // How to read the period — the same wording shown on screen.
      coverY += 4;
      doc.setFontSize(8);
      doc.setTextColor(...GRAY);
      for (const note of [r.openingBalanceLabel, r.dateRuleLabel, r.transferLabel, r.mortality.note].filter(n => n)) {
        const lines = doc.splitTextToSize(note, pageWidth - 28);
        doc.text(lines, 14, coverY);
        coverY += lines.length * 3.6 + 3;
      }

      // ── CASH & BANK CARDS ───────────────────────────────────
      //
      // Drawn as CARDS rather than two more rows of the summary list above,
      // because they are not part of that list's arithmetic: everything there
      // is this farm and this period, and these two are the whole account as
      // of the closing date. Same shape as the Distribution Report's
      // letterhead cards, and the same figures the on-screen cards and the
      // closing MONEY POSITION block read — one service and one object, so
      // nothing on the page can disagree with anything else on it.
      if (this.cashPosition) {
        const cp = this.cashPosition;
        coverY += 3;
        const cardW = (pageWidth - 28 - 6) / 2;
        const cardH = 18;
        const cards: [string, number][] = [
          ['Cash from ' + unitName + ' (as of ' + asOf + ')', this.farmCashInHand],
          ['Total Bank Balance (as of ' + asOf + ')', cp.totalBankBalance]
        ];
        cards.forEach(([label, value], i) => {
          const x = 14 + i * (cardW + 6);
          doc.setDrawColor(...LGRAY);
          doc.setLineWidth(0.3);
          doc.roundedRect(x, coverY, cardW, cardH, 2, 2);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(...GRAY);
          doc.text(label, x + 4, coverY + 7);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(13);
          doc.setTextColor(...BLACK);
          doc.text(rs(value), x + 4, coverY + 14.5);
        });
        coverY += cardH + 4;

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...GRAY);
        const cashNote = doc.splitTextToSize(
          'Balances as of ' + asOf + ', not totals for the period above. The cash figure covers ' +
          unitName + ' alone: its own recorded cash sales and income less its own cash expenses ' +
          'and wages. The bank figure is the WHOLE account, because a bank account belongs to the ' +
          "owner rather than to one farm. Repeated at the end of this report.",
          pageWidth - 28);
        doc.text(cashNote, 14, coverY);
        coverY += cashNote.length * 3.6 + 3;
        doc.setFont('helvetica', 'normal');
      }

      // ════════════════════════════════════════════════════════
      // addPage helper
      // ════════════════════════════════════════════════════════
      const addPage = (title: string) => {
        if (isFirstSection || (pageHeight - y) < 80) {
          doc.addPage();
          drawBackground();
          // Thin top border line
          doc.setDrawColor(...LGRAY);
          doc.setLineWidth(0.3);
          doc.line(14, 12, pageWidth - 14, 12);

          // Header text
          doc.setFontSize(8);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...GRAY);
          doc.text('Talha Protein Farms', 14, 9);
          doc.text(unitName, pageWidth / 2, 9, { align: 'center' });
          doc.text(today, pageWidth - 14, 9, { align: 'right' });

          y = 22;
        } else {
          y += 12; // gap between sections on the same page
        }

        // Section title
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

      // ════════════════════════════════════════════════════════
      // REVENUE
      // ════════════════════════════════════════════════════════
      addPage('Revenue');
      bwTable(
        y,
        [['Source', 'Amount (Rs.)']],
        (r.moduleType === 'layer'
          ? [
              ['Egg Sales', rs(r.revenue.sales)],
              ['Hen Sales', rs(r.revenue.henSales)],
              ['Other Income', rs(r.revenue.income)]
            ]
          : [
              ['Bird Sales', rs(r.revenue.sales)],
              ['Other Income', rs(r.revenue.income)]
            ]),
        [['Total Revenue', rs(r.revenue.total)]],
        1,
        { 0: { cellWidth: 100 } }
      );

      // ════════════════════════════════════════════════════════
      // EXPENSES
      // ════════════════════════════════════════════════════════
      addPage('Expenses');
      bwTable(
        y,
        [['Cost Head', 'Amount (Rs.)']],
        [
          ['Feed',              rs(r.expenses.feed)],
          ['Medicine',          rs(r.expenses.medicine)],
          ['Chicks',            rs(r.expenses.chicks)],
          ['Vaccination',       rs(r.expenses.vaccination)],
          ['Labour',            rs(r.expenses.labour)],
          ['General Expenses',  rs(r.expenses.general)],
          ['Ledger Debit', rs(r.expenses.ledgerDebits)]
        ],
        [['Total Expenses', rs(r.expenses.total)]],
        1,
        { 0: { cellWidth: 100 } }
      );

      // ════════════════════════════════════════════════════════
      // PER-FLOCK / PER-BATCH BREAKDOWN
      // ════════════════════════════════════════════════════════
      if (r.flocks.length > 0) {
        const soldHead = r.moduleType === 'layer' ? 'Birds Sold' : 'Weight Sold (kg)';
        const soldOf = (f: { birdsSold: number | null; weightSoldKg: number | null }) =>
          Math.round((r.moduleType === 'layer' ? f.birdsSold : f.weightSoldKg) || 0).toLocaleString();

        addPage(`${this.flockWord} Performance`);
        bwTable(
          y,
          [[this.flockWord, 'Start Date', 'Birds Placed', soldHead, 'Revenue (Rs.)', 'Costs (Rs.)', 'Profit / Loss (Rs.)']],
          r.flocks.map(f => [
            f.name,
            formatDate(f.startDate),
            f.birdsPlaced.toLocaleString(),
            soldOf(f),
            rs(f.revenue),
            rs(f.expenses),
            rs(f.profit)
          ]),
          [[
            'Total', '',
            r.mortality.birdsPlaced.toLocaleString(),
            soldOf({ birdsSold: r.mortality.birdsSold, weightSoldKg: r.mortality.weightSoldKg }),
            rs(r.revenue.total),
            rs(r.expenses.total),
            rs(r.netProfit)
          ]],
          6,
          { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } }
        );
      }

      // ════════════════════════════════════════════════════════
      // MORTALITY
      // ════════════════════════════════════════════════════════
      addPage('Mortality Summary');
      const mortalityRows: any[][] = [
        ['Birds Placed', r.mortality.birdsPlaced.toLocaleString()],
        r.moduleType === 'layer'
          ? ['Birds Sold', (r.mortality.birdsSold || 0).toLocaleString()]
          : ['Weight Sold (kg)', `${Math.round(r.mortality.weightSoldKg || 0).toLocaleString()} kg`],
        ['Mortality', r.mortality.mortality.toLocaleString()],
        ['Mortality Rate', `${r.mortality.mortalityRate.toFixed(2)}%`]
      ];
      if (r.mortality.avgWeightPerBirdKg != null) {
        mortalityRows.push(['Avg. Weight / Bird (kg)', `${r.mortality.avgWeightPerBirdKg.toFixed(2)} kg`]);
      }
      bwTable(
        y,
        [],
        mortalityRows,
        undefined,
        1,
        {
          0: { fontStyle: 'bold', cellWidth: 100 },
          1: { halign: 'right' }
        }
      );

      // ════════════════════════════════════════════════════════
      // PROFIT / LOSS SUMMARY
      // ════════════════════════════════════════════════════════
      addPage('Profit / Loss Summary');
      bwTable(
        y,
        [],
        [
          ['Opening Balance (carried forward, not app-calculated)', rs(r.openingBalance)],
          ['Total Revenue',    rs(r.revenue.total)],
          ['Feed Cost',        rs(r.expenses.feed)],
          ['Medicine Cost',    rs(r.expenses.medicine)],
          ['Chick Cost',       rs(r.expenses.chicks)],
          ['Vaccination Cost', rs(r.expenses.vaccination)],
          ['Labour Cost',      rs(r.expenses.labour)],
          ['General Expenses', rs(r.expenses.general)],
          ['Ledger Debit', rs(r.expenses.ledgerDebits)],
          ['Total Expenses',   rs(r.expenses.total)],
          [
            r.netProfit >= 0 ? 'NET PROFIT (this period)' : 'NET LOSS (this period)',
            rs(Math.abs(r.netProfit))
          ],
          [
            r.totalWithOpeningBalance >= 0 ? 'TOTAL (Opening Balance + Net Profit)' : 'TOTAL (Opening Balance + Net Loss)',
            rs(Math.abs(r.totalWithOpeningBalance))
          ]
        ],
        undefined,
        1,
        {
          0: { fontStyle: 'bold', cellWidth: 100 },
          1: { halign: 'right', fontStyle: 'bold' }
        }
      );

      // ════════════════════════════════════════════════════════
      // MONEY POSITION — the closing block, after every section
      // ════════════════════════════════════════════════════════
      //
      // Last thing in the document on purpose: "as of this date you have
      // Rs. X in cash and Rs. Y in bank". NOT a section — it is drawn
      // unconditionally, because it summarises the whole account rather than
      // anything a section covers, and it reads the same `cashPosition`
      // object the cover cards and the screen do.
      //
      // `addPage` starts a new page only when the last section left under
      // 80mm, so this lands at the foot of the final page or at the top of a
      // fresh one — after everything either way.
      if (this.cashPosition) {
        const cp = this.cashPosition;
        addPage(`Money Position (as of ${asOf})`);
        bwTable(
          y,
          [],
          [
            [`Cash from ${unitName} (as of ${asOf})`, rs(this.farmCashInHand)],
            [`Total Bank Balance, whole account (as of ${asOf})`, rs(cp.totalBankBalance)]
          ],
          [['TOTAL MONEY', rs(this.totalMoney)]],
          1,
          {
            0: { fontStyle: 'bold', cellWidth: 100 },
            1: { halign: 'right', fontStyle: 'bold' }
          }
        );

        y += 4;
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...GRAY);
        const closingNote = doc.splitTextToSize(
          'Balances as of ' + asOf + ', not totals for the period above. The cash line covers ' +
          unitName + ' alone - its own recorded cash transactions, nothing the distribution ' +
          "business or the owner's own accounts did. The bank line is the whole account.",
          pageWidth - 28);
        doc.text(closingNote, 14, y);
        y += closingNote.length * 3.6;
        doc.setFont('helvetica', 'normal');
      }

      // ── Footer & page numbers on every page ───────────────
      const totalPages = (doc.internal as any).getNumberOfPages();
      const totalRef = { val: totalPages };
      for (let i = 1; i <= totalPages; i++) {
        drawFooter(i, totalRef);
      }

      await this.printPdf(doc, `${farmName}-${unitName}-Farm-Report.pdf`);

    } finally {
      this.isGenerating = false;
      this.cdr.detectChanges();
    }
  }

  private async printPdf(doc: jsPDF, filename: string) {
    try {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1];
      const result = await (window as any).electronAPI.printPdfBase64(base64);
      if (!result || !result.success) {
        console.error('Print failed, falling back to save:', result?.error);
        doc.save(filename);
      }
    } catch (e) {
      console.error('Print error, falling back to save:', e);
      doc.save(filename);
    }
  }

  // ── Load image as base64 ──────────────────────────────────
  private loadImageAsBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}
