/**
 * The PDF libraries (jsPDF and its table plugin) are large and only needed when
 * someone prints or exports. Importing them at the top of 19 screens made each of
 * those screens download them just to open. This loads them on first use instead,
 * once, and keeps them for the rest of the session.
 *
 *   const { jsPDF, autoTable } = await loadPdfLibs();
 *
 * Use `import type { jsPDF } from 'jspdf'` where only the type is needed.
 */
type PdfLibs = {
  jsPDF: typeof import('jspdf').jsPDF;
  autoTable: typeof import('jspdf-autotable').default;
};

let libs: Promise<PdfLibs> | null = null;

export function loadPdfLibs(): Promise<PdfLibs> {
  libs ??= Promise.all([import('jspdf'), import('jspdf-autotable')])
    .then(([pdf, table]) => ({ jsPDF: pdf.jsPDF, autoTable: table.default }))
    // A failed download (offline) must not be remembered: the next try can succeed.
    .catch(error => { libs = null; throw error; });
  return libs;
}
