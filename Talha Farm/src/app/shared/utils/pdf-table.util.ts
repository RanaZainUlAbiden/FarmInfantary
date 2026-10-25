/**
 * jspdf-autotable (v5) only applies `columnStyles` — including `halign` — to the
 * 'body' section; head and foot cells silently fall back to headStyles/footStyles'
 * default (left) alignment. That is what makes a right-aligned money column's
 * header (and any manually-added foot/totals row) sit left of values that are
 * themselves correctly right-aligned, reading as if the whole column drifted.
 *
 * Pass this as `didParseCell` on any autoTable call that sets per-column `halign`
 * in `columnStyles`, to mirror that alignment onto the head and foot sections too.
 */
export function alignHeadFootWithColumnStyles(data: any): void {
  if (data.section === 'body') return;
  const columnStyles = data.table?.styles?.columnStyles || {};
  const colStyles = columnStyles[data.column.dataKey] ?? columnStyles[data.column.index];
  if (colStyles?.halign) {
    data.cell.styles.halign = colStyles.halign;
  }
}

/**
 * The x-coordinate a table's right edge actually rendered at — its left margin
 * plus the summed *final* width of every column, read back from
 * `doc.lastAutoTable` after the table is drawn rather than re-adding the
 * `cellWidth`s a caller passed in. Column widths can stretch to fill available
 * space (an 'auto' column, or omitted columnStyles), so re-summing the inputs
 * would drift from where the table actually landed. Use this to right-align a
 * summary line drawn below a table so it tracks the table's own columns
 * instead of a hardcoded x position.
 */
export function getTableRightEdge(doc: any): number {
  const table = doc.lastAutoTable;
  const left = table?.settings?.margin?.left ?? 14;
  const width = (table?.columns || []).reduce((sum: number, c: any) => sum + (c.width || 0), 0);
  return left + width;
}
