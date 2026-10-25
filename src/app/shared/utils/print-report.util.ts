import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles } from './pdf-table.util';
import { printPdfBase64 } from './browser-print.util';

export interface PrintReportColumn {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

export interface PrintReportOptions {
  farmName: string;
  farmId?: number | string | null;
  title: string;
  /** Rendered next to the farm name, e.g. "01-01-2026 to 31-01-2026" or "All entries". */
  rangeLabel: string;
  /** A plain string, or an object to colour a gain/loss-style line green/red
   *  (matching the .gain/.loss and .positive/.negative classes on screen). */
  summaryLines?: (string | { text: string; color?: 'positive' | 'negative' })[];
  columns: PrintReportColumn[];
  rows: (string | number)[][];
  totalsRow?: (string | number)[];
  filename: string;
}

/**
 * Shared A4 report layout — farm/title header, range + summary block, a
 * striped table, and the standard footer — reused by every screen that
 * prints "the records currently shown" (Personal Expenses, Assets, ...)
 * rather than each reimplementing jsPDF/autoTable boilerplate.
 */
export async function printPdfReport(opts: PrintReportOptions): Promise<void> {
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const B: [number, number, number] = [0, 0, 0];
  const G: [number, number, number] = [120, 120, 120];
  const GREEN: [number, number, number] = [26, 92, 56];
  const RED: [number, number, number] = [198, 40, 40];
  const margin = 14;
  const pageWidth = pw - margin * 2;
  let y = 20;

  // ── HEADER ──────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...B);
  doc.text((opts.farmName || 'Farm').toUpperCase(), pw / 2, y, { align: 'center' });
  y += 8;

  doc.setFontSize(14);
  doc.text(opts.title, pw / 2, y, { align: 'center' });
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...G);
  doc.text(`Range: ${opts.rangeLabel}`, margin, y);
  if (opts.farmId !== undefined && opts.farmId !== null) {
    doc.text(`Farm ID: ${opts.farmId}`, pw - margin, y, { align: 'right' });
  }
  y += 10;

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pw - margin, y);
  y += 8;

  // ── SUMMARY ──────────────────────────────────────────────
  if (opts.summaryLines && opts.summaryLines.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text('SUMMARY', margin, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const line of opts.summaryLines) {
      if (typeof line === 'string') {
        doc.setTextColor(...B);
        doc.text(line, margin + 5, y);
      } else {
        doc.setTextColor(...(line.color === 'positive' ? GREEN : line.color === 'negative' ? RED : B));
        doc.text(line.text, margin + 5, y);
      }
      y += 5;
    }
    doc.setTextColor(...B);
    y += 4;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
  }

  // ── TABLE ──────────────────────────────────────────────
  const body = opts.rows.length > 0
    ? opts.rows
    : [opts.columns.map((_, i) => (i === 0 ? 'No records found' : ''))];

  const columnStyles: any = {};
  opts.columns.forEach((c, i) => {
    columnStyles[i] = { cellWidth: c.width, halign: c.align || 'left' };
  });

  autoTable(doc, {
    startY: y,
    head: [opts.columns.map(c => c.header)],
    body,
    foot: opts.totalsRow ? [opts.totalsRow] : undefined,
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
    footStyles: {
      fontStyle: 'bold',
      fontSize: 8,
      fillColor: [240, 240, 240],
      textColor: [0, 0, 0]
    },
    alternateRowStyles: {
      fillColor: [245, 245, 245]
    },
    margin: { left: margin, right: margin },
    columnStyles,
    tableWidth: pageWidth,
    styles: {
      overflow: 'linebreak',
      cellPadding: 3
    },
    // jspdf-autotable only applies columnStyles to the body section — head/foot cells
    // otherwise fall back to headStyles/footStyles' default halign, so a right-aligned
    // amount column's header and totals row drift left of its own values.
    didParseCell: alignHeadFootWithColumnStyles,
    didDrawPage: () => {
      const pageNumber = (doc as any).internal.getCurrentPageInfo().pageNumber;
      const totalPages = (doc as any).internal.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(...G);
      doc.text(`Page ${pageNumber} of ${totalPages}`, pw / 2, ph - 8, { align: 'center' });
    }
  });

  // ── FOOTER ──────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(...G);
  doc.text('Generated by: www.devinfantary.com  |  Contact: 0302 6938217', pw / 2, ph - 4, { align: 'center' });

  try {
    const dataUri = doc.output('datauristring');
    const base64 = dataUri.split(',')[1];
    const result = await printPdfBase64(base64);
    if (!result || !result.success) {
      console.error('Print failed, falling back to save:', result?.error);
      doc.save(opts.filename);
    }
  } catch (e) {
    console.error('Print error, falling back to save:', e);
    doc.save(opts.filename);
  }
}
