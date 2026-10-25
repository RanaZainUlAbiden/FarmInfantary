/**
 * Printing in a browser, replacing the desktop's `printPdfBase64` IPC.
 *
 * The desktop handed a base64 PDF to the main process, which opened the native
 * OS print dialog. A browser cannot do that, but it does not need to: the PDF
 * is already generated client-side with jsPDF, so it can be shown in the
 * browser's own print preview.
 *
 * HOW IT WORKS, AND WHY THIS WAY
 * ------------------------------
 * The PDF is loaded into a hidden same-origin iframe and that frame is told to
 * print. The user gets their browser's print dialog with the document already
 * in it — one step, no download, closest to the desktop behaviour.
 *
 * Browsers differ on whether a PDF plugin will accept `print()` from script,
 * and some block it outright. So EVERY path falls back to saving the file,
 * exactly as the desktop code already did when the IPC call failed. That
 * fallback is not new: every call site was already written around
 * `if (!result.success) doc.save(filename)`.
 *
 * The object URL is revoked on a timer rather than immediately: revoking it
 * while the frame is still printing cancels the job in several browsers.
 */

const REVOKE_AFTER_MS = 60_000;

export interface PrintResult {
  success: boolean;
  error?: string;
}

/**
 * Opens the browser's print dialog for a PDF.
 *
 * Returns the same `{ success, error }` shape the IPC call did, so call sites
 * keep their existing fallback-to-save branch unchanged.
 */
export async function printPdfBlob(blob: Blob): Promise<PrintResult> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { success: false, error: 'Printing is only available in a browser.' };
  }

  return new Promise<PrintResult>((resolve) => {
    let settled = false;
    const done = (r: PrintResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.setAttribute('aria-hidden', 'true');

    const cleanup = () => {
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        frame.remove();
      }, REVOKE_AFTER_MS);
    };

    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) {
          cleanup();
          done({ success: false, error: 'The print frame could not be opened.' });
          return;
        }
        win.focus();
        win.print();
        cleanup();
        done({ success: true });
      } catch (err: any) {
        cleanup();
        done({ success: false, error: err?.message ?? 'The browser refused to print.' });
      }
    };

    frame.onerror = () => {
      cleanup();
      done({ success: false, error: 'The document could not be loaded for printing.' });
    };

    document.body.appendChild(frame);
    frame.src = url;

    // If the frame never loads — a blocked plugin, a browser that will not
    // render a PDF inline — do not hang the caller. Report failure so the
    // call site falls back to saving the file.
    window.setTimeout(
      () => done({ success: false, error: 'The print preview did not open in time.' }),
      8000
    );
  });
}

/**
 * Drop-in replacement for the desktop `electronAPI.printPdfBase64(base64)`.
 *
 * Kept base64-in so the 20 call sites need only have the call swapped: they
 * already compute `doc.output('datauristring').split(',')[1]`.
 */
export async function printPdfBase64(base64: string): Promise<PrintResult> {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await printPdfBlob(new Blob([bytes], { type: 'application/pdf' }));
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'The PDF could not be prepared.' };
  }
}
