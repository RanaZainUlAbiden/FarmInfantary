import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

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
  private sessionGeneration = 0;
  private activePosts = 0;
  private readonly postLimit = 4;
  private readonly queueLimit = 128;
  private postQueue: Array<{ start: () => void; cancel: () => void }> = [];
  resetSession(): void {
    this.txToken = null;
    this.sessionGeneration++;
    const discarded = this.postQueue.splice(0);
    discarded.forEach(task => task.cancel());
  }

  constructor(private http: HttpClient) {}

  /** Bound bursts from reports without replaying reads or mutations. A queued
   * request belongs to the identity and payload present when it was requested. */
  private post<T>(path: string, body: unknown, onTransportError: (msg: string) => T): Promise<T> {
    const generation = this.sessionGeneration;
    let payload: unknown;
    try { payload = JSON.parse(JSON.stringify(body)); }
    catch { return Promise.resolve(onTransportError('Invalid database operation.')); }
    return new Promise(resolve => {
      const cancelled = () => resolve(onTransportError('Your sign-in changed. Start again.'));
      const task = { cancel: cancelled, start: () => {
        if (generation !== this.sessionGeneration) { cancelled(); return; }
        this.activePosts++;
        void this.sendPost(path, payload, onTransportError).then(result => {
          resolve(generation === this.sessionGeneration ? result : onTransportError('Your sign-in changed. Start again.'));
        }).finally(() => {
          this.activePosts--;
          this.drainPosts();
        });
      }};
      if (this.activePosts < this.postLimit) task.start();
      else if (this.postQueue.length < this.queueLimit) this.postQueue.push(task);
      else resolve(onTransportError('Too many database operations are waiting. Wait for this screen to finish and try again.'));
    });
  }

  private drainPosts(): void {
    while (this.activePosts < this.postLimit && this.postQueue.length) this.postQueue.shift()!.start();
  }

  private async sendPost<T>(path: string, body: unknown, onTransportError: (msg: string) => T): Promise<T> {
    try {
      return await firstValueFrom(this.http.post<T>(`${this.base}/${path}`, body).pipe(timeout(45_000)));
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
    const generation = this.sessionGeneration;
    const res = await this.post<DbTxResult>(
      'db/tx/begin', {}, (error) => ({ success: false, error })
    );
    if (generation !== this.sessionGeneration) return { success: false, error: 'Your sign-in changed. Start again.' };
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
    try {
      const response=await firstValueFrom(this.http.get(`${this.base}/account/export`,{responseType:'blob',observe:'response'}).pipe(timeout(90_000)));
      const filename=/filename="([a-zA-Z0-9._-]+)"/.exec(response.headers.get('Content-Disposition')||'')?.[1]||'farminfantary-export.json';
      const url=URL.createObjectURL(response.body!),link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      return {success:true,filename};
    }catch(error:any){let message=error?.error?.error;if(error?.error instanceof Blob){try{message=JSON.parse(await error.error.text()).error;}catch{}}
      return {success:false,error:message||'Could not download farm data. Check your connection and try again.'};}
  }

  async restoreDatabase(): Promise<any> {
    return { success: false, error: 'Restore is not available yet.' };
  }
}
