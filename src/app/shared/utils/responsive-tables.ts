/**
 * Phone-friendly tables without touching 46 screens.
 *
 * Wide tables are unreadable on a phone: columns are cut off or need sideways
 * scrolling. On narrow screens the global stylesheet (styles.scss, `.fi-cards`)
 * shows each row as a small card with "Label  value" lines. CSS cannot read the
 * header text, so this copies each <th> text onto the matching <td> as
 * `data-label`. It only adds attributes and a class; it never moves or removes
 * elements, so Angular's bindings and event handlers are unaffected.
 */
const LABEL = 'data-label';

function columnLabels(table: HTMLTableElement): string[] {
  const headRow = table.tHead?.rows[0];
  if (!headRow) return [];
  const labels: string[] = [];
  for (const th of Array.from(headRow.cells)) {
    const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.max(1, th.colSpan); i++) labels.push(text);
  }
  return labels;
}

export function enhanceTable(table: HTMLTableElement): void {
  const labels = columnLabels(table);
  if (labels.length === 0) return;
  let usable = false;
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        const span = Math.max(1, cell.colSpan);
        // A cell that spans columns (a "Total" line, an empty-state message)
        // has no single column heading, so it stays unlabeled.
        const label = span === 1 ? labels[col] ?? '' : '';
        if (label) {
          if (cell.getAttribute(LABEL) !== label) cell.setAttribute(LABEL, label);
          usable = true;
        } else if (cell.hasAttribute(LABEL)) {
          cell.removeAttribute(LABEL);
        }
        col += span;
      }
    }
  }
  if (usable) table.classList.add('fi-cards');
}

export function enhanceTables(root: ParentNode): void {
  root.querySelectorAll('table').forEach(t => enhanceTable(t as HTMLTableElement));
}

/** Keep tables labeled as screens load, filter, add rows and re-render. */
export function observeTables(root: HTMLElement): () => void {
  let queued = false;
  const run = () => { queued = false; enhanceTables(root); };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  schedule();
  return () => observer.disconnect();
}
