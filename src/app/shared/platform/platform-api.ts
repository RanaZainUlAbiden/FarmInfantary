/**
 * The boundary between the app and wherever its data lives.
 *
 * This interface is a deliberate mirror of the desktop app's
 * `window.electronAPI`. Keeping the shapes identical is the whole reason 341
 * database call sites did not have to change: `DatabaseService` depends on
 * this, `DatabaseService`'s method signatures are frozen, and everything above
 * it is untouched.
 *
 * RESULT SHAPES ARE CONTRACTUAL, AND NOTHING HERE REJECTS.
 *
 * On the desktop a failing statement came back as `{ success: false, error }`
 * — never a thrown exception — and every call site was written against that.
 * An implementation that rejects its promise on a SQL error would silently
 * change error handling across all 60 screens: `catch` blocks that were never
 * written, and screens showing nothing instead of a message.
 */

/** One statement in a batch. */
export interface DbOp {
  sql: string;
  /**
   * A params entry of `{ $lastId: n }` is replaced, server-side, with the id
   * inserted by operation `n` of the same batch. `n < 0` counts back from the
   * current operation, so `{ $lastId: -1 }` is "the row the previous statement
   * just inserted". 54 call sites rely on this.
   */
  params?: any[];
}

export interface DbGetResult {
  success: boolean;
  data?: any[];
  error?: string;
}

export interface DbRunResult {
  success: boolean;
  lastId?: number | null;
  error?: string;
}

export interface DbBatchResult {
  success: boolean;
  results?: { lastId: number | null }[];
  lastId?: number | null;
  error?: string;
  failedIndex?: number;
  failedSql?: string;
}

export interface DbTxResult {
  success: boolean;
  token?: string;
  error?: string;
}

export interface PlatformApi {
  dbGet(sql: string, params?: any[]): Promise<DbGetResult>;
  dbRun(sql: string, params?: any[]): Promise<DbRunResult>;
  dbRunBatch(ops: DbOp[]): Promise<DbBatchResult>;

  /**
   * A transaction spanning several calls. Always pair a begin with a commit or
   * a rollback, or the writes never reach disk.
   *
   * Only 2 call sites use these; the other 54 multi-statement writes use
   * `dbRunBatch`, which is self-contained — one request, one connection, one
   * transaction. Prefer a batch for new work.
   */
  dbBeginTransaction(): Promise<DbTxResult>;
  dbCommitTransaction(): Promise<DbTxResult>;
  dbRollbackTransaction(): Promise<DbTxResult>;

  getAppSetting(farmId: number, key: string): Promise<any>;
  setAppSetting(farmId: number, key: string, value: string): Promise<any>;

  backupDatabase(): Promise<any>;
  restoreDatabase(): Promise<any>;
}
