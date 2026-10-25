import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import {
  PlatformApi, DbOp, DbGetResult, DbRunResult, DbBatchResult, DbTxResult,
} from './platform-api';

/**
 * `PlatformApi` over HTTP, replacing the Electron IPC bridge.
 *
 * THE ONE RULE: this never rejects on a database error.
 *
 * The desktop returned `{ success: false, error }` for a failing statement and
 * all 341 call sites check `.success`; none were written to `catch`. The
 * server already answers 200 with that shape for any statement that reached
 * the database, so the only rejections left are genuine TRANSPORT failures —
 * offline, DNS, a 500 from an unhandled server bug. Those are translated into
 * the same result shape here, so a dropped connection surfaces as a message on
 * screen rather than an unhandled promise rejection.
 */
@Injectable({ providedIn: 'root' })
export class HttpPlatformApi implements PlatformApi {
  /** Relative, so the app works behind any host or path prefix. */
  private readonly base = 'api';

  /** The open transaction's token, if any. Mirrors the desktop's one-at-a-time rule. */
  private txToken: string | null = null;

  constructor(private http: HttpClient) {}

  private async post<T>(path: string, body: unknown, onTransportError: (msg: string) => T): Promise<T> {
    try {
      return await firstValueFrom(this.http.post<T>(`${this.base}/${path}`, body));
    } catch (err: any) {
      // Transport, not SQL. Keep the result shape so callers need no catch.
      const detail =
        err?.status === 0
          ? 'Could not reach the server. Check your connection and try again.'
          : err?.error?.error ?? err?.message ?? 'The server could not be reached.';
      return onTransportError(detail);
    }
  }

  dbGet(sql: string, params: any[] = []): Promise<DbGetResult> {
    return this.post<DbGetResult>(
      'db/get', { sql, params, token: this.txToken },
      (error) => ({ success: false, error })
    );
  }

  dbRun(sql: string, params: any[] = []): Promise<DbRunResult> {
    return this.post<DbRunResult>(
      'db/run', { sql, params, token: this.txToken },
      (error) => ({ success: false, error })
    );
  }

  dbRunBatch(ops: DbOp[]): Promise<DbBatchResult> {
    return this.post<DbBatchResult>(
      'db/batch', { ops, token: this.txToken },
      (error) => ({ success: false, error })
    );
  }

  async dbBeginTransaction(): Promise<DbTxResult> {
    const res = await this.post<DbTxResult>(
      'db/tx/begin', {}, (error) => ({ success: false, error })
    );
    if (res.success && res.token) this.txToken = res.token;
    return res;
  }

  async dbCommitTransaction(): Promise<DbTxResult> {
    const token = this.txToken;
    // Cleared first: whether the commit succeeds or fails, this transaction is
    // over. Leaving a dead token attached would silently route every later
    // statement at a connection that is no longer open.
    this.txToken = null;
    if (!token) return { success: false, error: 'No database transaction is open.' };
    return this.post<DbTxResult>('db/tx/commit', { token }, (error) => ({ success: false, error }));
  }

  async dbRollbackTransaction(): Promise<DbTxResult> {
    const token = this.txToken;
    this.txToken = null;
    if (!token) return { success: false, error: 'No database transaction is open.' };
    return this.post<DbTxResult>('db/tx/rollback', { token }, (error) => ({ success: false, error }));
  }

  // ── app settings (the delete-code PIN) ───────────────────
  // farmId is accepted for signature compatibility and deliberately NOT sent:
  // the server resolves the farm from the session. Phase 3 also moves the PIN
  // COMPARISON server-side — a client-side check is no control at all once the
  // browser is under the user's control.

  async getAppSetting(_farmId: number, key: string): Promise<any> {
    try {
      return await firstValueFrom(this.http.get(`${this.base}/settings/${encodeURIComponent(key)}`));
    } catch {
      return { success: false, error: 'Could not read the setting.' };
    }
  }

  async setAppSetting(_farmId: number, key: string, value: string): Promise<any> {
    try {
      return await firstValueFrom(
        this.http.put(`${this.base}/settings/${encodeURIComponent(key)}`, { value })
      );
    } catch {
      return { success: false, error: 'Could not save the setting.' };
    }
  }

  // ── backup / restore ─────────────────────────────────────
  // Phase 5. Restore in particular is a new design, not a port: the desktop
  // overwrote one local file belonging to one user, and the same operation on
  // a shared server would destroy every other account's data (D10).

  async backupDatabase(): Promise<any> {
    return { success: false, error: 'Backup is not available yet.' };
  }

  async restoreDatabase(): Promise<any> {
    return { success: false, error: 'Restore is not available yet.' };
  }
}
