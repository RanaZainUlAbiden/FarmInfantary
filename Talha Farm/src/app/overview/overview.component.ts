import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../shared/services/auth.service';
import { DatabaseService } from '../shared/services/database.service';
import { OverviewService, OverviewSummary, OverviewDateRange } from '../shared/services/overview.service';
import { CashPositionService, CashPosition } from '../shared/services/cash-position.service';
import { toLocalDateString } from '../shared/utils/date.util';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles } from '../shared/utils/pdf-table.util';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss'
})
export class OverviewComponent implements OnInit {
  currentFarm: any = null;
  summary: OverviewSummary | null = null;

  /**
   * Cash in hand and total bank balance, as at today — NOT part of
   * `OverviewSummary`, because every figure in that object is period-scoped
   * and these two deliberately are not. One definition, shared with both
   * report screens; see `CashPositionService`.
   */
  cashPosition: CashPosition | null = null;

  /**
   * What is owed to the owner on loans he made, and what he owes on money left
   * with him. Balances as at today, like the two cash figures above and for the
   * same reason — a receivable is what is owed NOW, not a flow over a period —
   * so the date filter never touches them.
   *
   * Read through `getLoanTotals()`, which derives both off the same expression
   * the Loans screen's list uses, so a card and that screen cannot disagree.
   * NEITHER figure enters revenue, expenses or profit: a loan is not income on
   * one side or an expense on the other.
   */
  loanTotals: { receivable: number; payable: number } = { receivable: 0, payable: 0 };

  isLoading = true;
  isGenerating = false;

  dateFrom: string = '';
  dateTo: string = '';

  constructor(
    private authService: AuthService,
    private overviewService: OverviewService,
    private cashPositionService: CashPositionService,
    private db: DatabaseService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();

    // Default range: current month to date.
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    this.dateFrom = toLocalDateString(firstOfMonth);
    this.dateTo = toLocalDateString(today);

    this.loadData();
  }

  async loadData() {
    this.isLoading = true;
    const farmId = this.currentFarm?.farm_id;
    const range: OverviewDateRange = { from: this.dateFrom || null, to: this.dateTo || null };
    // `range` is deliberately NOT passed to the cash position: both of its
    // figures are balances as at today, so a date filter must not move them.
    const [summary, cashPosition, loanTotals] = await Promise.all([
      farmId ? this.overviewService.getSummary(farmId, range) : Promise.resolve(null),
      farmId ? this.cashPositionService.getCashPosition(farmId) : Promise.resolve(null),
      farmId ? this.db.getLoanTotals(farmId) : Promise.resolve({ receivable: 0, payable: 0 })
    ]);
    this.summary = summary;
    this.cashPosition = cashPosition;
    this.loanTotals = { receivable: loanTotals.receivable, payable: loanTotals.payable };
    this.isLoading = false;
    this.cdr.detectChanges();
  }

  applyDateFilter() {
    this.loadData();
  }

  // Display-only: Net Profit = Opening Balance + Profit (same combination
  // already used for the headline Total, s.profitWithOpeningBalance).
  hasOpeningBalance(f: { unitId: number | null; moduleType: string }): boolean {
    return f.unitId !== null || f.moduleType === 'distribution';
  }

  netProfit(f: { profit: number; openingBalance: number }): number {
    return f.profit + f.openingBalance;
  }

  clearDateFilter() {
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    this.dateFrom = toLocalDateString(firstOfMonth);
    this.dateTo = toLocalDateString(today);
    this.loadData();
  }

  // ── PDF Generation ──────────────────────────────────────────
  async generatePDF() {
    if (!this.summary) return;
    this.isGenerating = true;

    try {
      const s = this.summary;
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const farmName = this.currentFarm?.farm_name || 'Poultry Farm';
      const today = new Date().toLocaleDateString('en-PK');
      const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
      const rangeLabel = `${this.dateFrom || 'Start'} to ${this.dateTo || 'Today'}`;

      const BLACK: [number, number, number] = [0, 0, 0];
      const GRAY: [number, number, number] = [120, 120, 120];
      const LGRAY: [number, number, number] = [200, 200, 200];
      const GREEN: [number, number, number] = [26, 92, 56];
      const RED: [number, number, number] = [198, 40, 40];

      const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

      let y = 20;

      // ── Header ──
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(17);
      doc.setTextColor(...BLACK);
      doc.text('TALHA PROTEIN FARMS', 14, y);
      y += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...GRAY);
      doc.text('Chak No 392 JB, Chatala, Toba Tek Singh', 14, y);
      y += 8;

      doc.setFontSize(10);
      doc.setTextColor(...BLACK);
      doc.text(`Overview Report: ${farmName}`, 14, y);
      y += 5;
      doc.setFontSize(9);
      doc.setTextColor(...GRAY);
      doc.text(`Period: ${rangeLabel}  •  Generated: ${today}`, 14, y);
      y += 8;

      doc.setDrawColor(...BLACK);
      doc.setLineWidth(0.5);
      doc.line(14, y, pageWidth - 14, y);
      y += 8;

      // ── Assets & profit cards ──
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...BLACK);
      doc.text('ASSETS & PROFIT', 14, y);
      y += 3;
      doc.setDrawColor(...BLACK);
      doc.line(14, y, pageWidth - 14, y);
      y += 6;

      const cardsProfitLabel = s.profit >= 0 ? 'Overall Profit (all farms)' : 'Overall Loss (all farms)';
      const netPositionLabel = 'Net Position (Opening Balance + Result)';
      autoTable(doc, {
        startY: y,
        body: [
          ['Assets Owned (value)', rs(s.assets.activeValue)],
          ['Outstanding Installments', rs(s.assets.outstanding)],
          [
            { content: cardsProfitLabel, styles: { fontStyle: 'bold' } },
            { content: rs(s.profit), styles: { fontStyle: 'bold', textColor: s.profit >= 0 ? GREEN : RED } }
          ],
          [
            { content: netPositionLabel, styles: { fontStyle: 'bold' } },
            { content: rs(s.profitWithOpeningBalance), styles: { fontStyle: 'bold', textColor: s.profitWithOpeningBalance >= 0 ? GREEN : RED } }
          ]
        ],
        theme: 'plain',
        bodyStyles: { fontSize: 10, textColor: BLACK, lineWidth: { bottom: 0.15 }, lineColor: LGRAY },
        columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right' } },
        margin: { left: 14, right: 14 }
      });
      y = (doc as any).lastAutoTable.finalY + 10;

      // ── Cash & bank (as at today, NOT the selected period) ──
      //
      // In the header block, above the period-scoped sections: these are the
      // same two figures the on-screen cards show, read off the same service,
      // so the print and the screen cannot disagree.
      if (this.cashPosition) {
        if (y > pageHeight - 50) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...BLACK);
        doc.text('CASH & BANK (as at today)', 14, y);
        y += 3;
        doc.setDrawColor(...BLACK);
        doc.line(14, y, pageWidth - 14, y);
        y += 6;

        const cp = this.cashPosition;
        autoTable(doc, {
          startY: y,
          body: [
            [
              { content: 'Cash in Hand', styles: { fontStyle: 'bold' } },
              { content: rs(cp.cashInHand), styles: { fontStyle: 'bold', textColor: cp.cashInHand >= 0 ? GREEN : RED } }
            ],
            [
              { content: 'Total Bank Balance', styles: { fontStyle: 'bold' } },
              { content: rs(cp.totalBankBalance), styles: { fontStyle: 'bold', textColor: cp.totalBankBalance >= 0 ? GREEN : RED } }
            ]
          ],
          theme: 'plain',
          bodyStyles: { fontSize: 10, textColor: BLACK, lineWidth: { bottom: 0.15 }, lineColor: LGRAY },
          columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right' } },
          margin: { left: 14, right: 14 }
        });
        y = (doc as any).lastAutoTable.finalY + 5;

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...GRAY);
        const cashNote = doc.splitTextToSize(
          'Both as at today, not limited to the period above. Cash in Hand is derived from ' +
          'recorded cash transactions; Total Bank Balance covers your own accounts only.',
          pageWidth - 28);
        doc.text(cashNote, 14, y);
        y += cashNote.length * 3.6 + 6;
      }

      // ── Asset totals (point-in-time, as at dateTo) ──
      if (y > pageHeight - 60) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...BLACK);
      doc.text(`ASSET TOTALS (as at ${this.dateTo || 'today'})`, 14, y);
      y += 3;
      doc.setDrawColor(...BLACK);
      doc.line(14, y, pageWidth - 14, y);
      y += 6;

      const t = s.assets.totals;
      const assetTotalsRows: any[] = [
        ['Total Assets Owned', `${t.count.toLocaleString()} · ${rs(t.purchaseValue)}`],
        ['Total Paid So Far', rs(t.paid)],
        ['Total Sold For', rs(t.soldFor)],
        [
          { content: 'Profit / Loss on Sold Assets', styles: { fontStyle: 'bold' } },
          { content: rs(t.profitLoss), styles: { fontStyle: 'bold', textColor: t.profitLoss >= 0 ? GREEN : RED } }
        ]
      ];
      autoTable(doc, {
        startY: y,
        body: assetTotalsRows,
        theme: 'plain',
        bodyStyles: { fontSize: 10, textColor: BLACK, lineWidth: { bottom: 0.15 }, lineColor: LGRAY },
        columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right' } },
        margin: { left: 14, right: 14 }
      });
      y = (doc as any).lastAutoTable.finalY + (t.excludedFromProfitLoss > 0 ? 5 : 10);

      if (t.excludedFromProfitLoss > 0) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...GRAY);
        doc.text(
          `${t.excludedFromProfitLoss} sold asset(s) excluded from Profit/Loss above — no total price on file.`,
          14, y
        );
        y += 8;
      }

      // ── Per-farm breakdown ──
      if (s.perFarm.length > 0) {
        if (y > pageHeight - 60) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...BLACK);
        doc.text('PER-FARM BREAKDOWN', 14, y);
        y += 3;
        doc.line(14, y, pageWidth - 14, y);
        y += 6;

        autoTable(doc, {
          startY: y,
          head: [['Farm', 'Module', 'Revenue', 'Expenses', 'Profit', 'Opening Balance']],
          body: s.perFarm.map(f => [
            f.unitName,
            f.moduleType,
            rs(f.revenue),
            rs(f.expenses),
            rs(f.profit),
            (f.unitId !== null || f.moduleType === 'distribution') ? rs(f.openingBalance) : '—'
          ]),
          theme: 'plain',
          headStyles: { fontStyle: 'bold', fontSize: 9, textColor: BLACK, lineWidth: { bottom: 0.3 }, lineColor: BLACK },
          bodyStyles: { fontSize: 9, textColor: BLACK, lineWidth: { bottom: 0.15 }, lineColor: LGRAY },
          columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
          margin: { left: 14, right: 14 },
          didParseCell: alignHeadFootWithColumnStyles
        });
        y = (doc as any).lastAutoTable.finalY + 10;
      }

      // ── Warnings ──
      if (s.warnings.length > 0) {
        if (y > pageHeight - 40) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...RED);
        doc.text('WARNINGS', 14, y);
        y += 6;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...BLACK);
        for (const w of s.warnings) {
          const lines = doc.splitTextToSize('• ' + w, pageWidth - 28);
          doc.text(lines, 14, y);
          y += lines.length * 4 + 2;
        }
      }

      // ── Footer & page numbers ──
      const totalPages = (doc.internal as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5);
        doc.setTextColor(...GRAY);
        doc.setFont('helvetica', 'normal');
        doc.text(footer, pageWidth / 2, pageHeight - 9, { align: 'center' });
        doc.setDrawColor(...LGRAY);
        doc.setLineWidth(0.2);
        doc.line(14, pageHeight - 12, pageWidth - 14, pageHeight - 12);
        doc.text(`Page ${i} of ${totalPages}`, pageWidth / 2, pageHeight - 4, { align: 'center' });
      }

      await this.printPdf(doc, `${farmName}-Overview-${this.dateFrom}-to-${this.dateTo}.pdf`);
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
}
