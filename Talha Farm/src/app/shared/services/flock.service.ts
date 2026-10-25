import { Injectable } from '@angular/core';
import { BehaviorSubject, distinctUntilChanged } from 'rxjs';
import { DatabaseService } from './database.service';

// The last selection made within each module. A flock and a batch share one
// "current" slot, so switching business tabs would otherwise reset whichever
// one you were not looking at.
const LAST_FLOCK_KEY = 'lastBroilerFlockId';
const LAST_BATCH_KEY = 'lastLayerBatchId';

/**
 * Same-content test used to dedup the selection stream.
 *
 * The old guard compared flock_id + batch-ness only, which made "same row,
 * new field values" unrepresentable — a rename could not reach any subscriber
 * — so both re-read paths bypassed it with a raw .next() and a five-line
 * comment. Comparing the whole row lets an edit through while still
 * suppressing the redundant re-emission a refresh produces when nothing
 * actually changed.
 *
 * That suppression is load-bearing, not cosmetic: every currentFlock$
 * subscriber reads an emission as "the user switched flock" and clears its
 * unsaved draft rows (see expenses.component.ts), so a spurious emission
 * destroys the user's work. Do not weaken this to an identity check.
 */
function sameRow(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A batch presented in the shared "current flock" slot. `batch_id` being set
 * is what tells the two apart everywhere in the app — the ids themselves
 * collide from #1 (see CLAUDE.md), so it is never enough to compare ids.
 */
function batchAsFlock(batch: any): any {
  return { ...batch, flock_name: batch.batch_name, flock_id: batch.batch_id, batch_id: batch.batch_id };
}

@Injectable({
  providedIn: 'root'
})
export class FlockService {

  private currentFlockSubject = new BehaviorSubject<any>(null);
  private flocksSubject = new BehaviorSubject<any[]>([]);
  private batchesSubject = new BehaviorSubject<any[]>([]);

  currentFlock$ = this.currentFlockSubject.asObservable().pipe(distinctUntilChanged(sameRow));

  flocks$ = this.flocksSubject.asObservable();
  batches$ = this.batchesSubject.asObservable();

  constructor(private db: DatabaseService) {
    const stored = localStorage.getItem('currentFlock');
    if (stored) {
      try {
        this.currentFlockSubject.next(JSON.parse(stored));
      } catch {
        this.currentFlockSubject.next(null);
      }
    }
  }

  // ── Selection ──────────────────────────────────────────────

  setCurrentFlock(flock: any) {
    if (flock === null) {
      this.publish(null, LAST_FLOCK_KEY);
      return;
    }
    this.publish(flock, flock.batch_id ? LAST_BATCH_KEY : LAST_FLOCK_KEY);
  }

  /** Select a raw `batches` row, wrapped into the shared current-flock shape. */
  setCurrentBatch(batch: any) {
    this.publish(batch ? batchAsFlock(batch) : null, LAST_BATCH_KEY);
  }

  getCurrentFlock(): any {
    return this.currentFlockSubject.value;
  }

  /**
   * Drop every cached selection. Root services outlive a logout — navigating
   * to /login does not destroy them — so without this the next account
   * inherits the previous one's in-memory selection.
   */
  reset() {
    this.flocksSubject.next([]);
    this.batchesSubject.next([]);
    this.currentFlockSubject.next(null);
    localStorage.removeItem('currentFlock');
    localStorage.removeItem(LAST_FLOCK_KEY);
    localStorage.removeItem(LAST_BATCH_KEY);
  }

  // ── Refresh ────────────────────────────────────────────────

  /**
   * Re-read this farm/unit's active flocks, publish them, and reconcile the
   * current selection against the fresh list.
   *
   * This is THE entry point for "broiler flock data changed". The
   * reconciliation used to live in LayoutComponent.loadFlocks(), which meant
   * only a navigation or a business-tab switch could ever run it: a screen
   * that wrote to `flocks` had no way to correct the shared selection, so
   * creating the first flock left currentFlock null and left the layout's
   * "Create your first flock" banner covering every screen until the user
   * round-tripped through another business tab.
   */
  async refreshFlocks(farmId: number, unitId?: number, activeOnly: boolean = true): Promise<any[]> {
    const conditions = ['farm_id = ?'];
    const params: any[] = [farmId];
    if (unitId) {
      conditions.push('unit_id = ?');
      params.push(unitId);
    }
    if (activeOnly) {
      conditions.push(`status = 'active'`);
    }

    const result = await this.db.get(
      `SELECT * FROM flocks WHERE ${conditions.join(' AND ')} ORDER BY flock_id ASC`,
      params
    );
    const flocks = result.success ? result.data : [];
    this.flocksSubject.next(flocks);

    this.reconcile(flocks, 'flock_id', LAST_FLOCK_KEY, row => row);
    return flocks;
  }

  /** Layer's half of refreshFlocks(), against `batches`. */
  async refreshBatches(farmId: number, unitId?: number): Promise<any[]> {
    const conditions = ['farm_id = ?', `status = 'active'`];
    const params: any[] = [farmId];
    if (unitId) {
      conditions.push('unit_id = ?');
      params.push(unitId);
    }

    const result = await this.db.get(
      `SELECT * FROM batches WHERE ${conditions.join(' AND ')} ORDER BY batch_id ASC`,
      params
    );
    const batches = result.success ? result.data : [];
    this.batchesSubject.next(batches);

    this.reconcile(batches, 'batch_id', LAST_BATCH_KEY, batchAsFlock);
    return batches;
  }

  /**
   * Given a freshly-read list, decide what "current" should be, and publish it.
   * Four cases, in order:
   *
   *  1. the selection is still in the list — re-publish the FRESH row, so an
   *     edit to its own fields (a rename) reaches every subscriber. The old
   *     code kept serving the pre-edit snapshot because the setter deduped on
   *     id alone.
   *  2. it is gone — deleted, closed, or it belongs to the other module,
   *     since a flock and a batch share this one slot — fall back to whichever
   *     row was last active in THIS module, so a business-tab round trip does
   *     not silently reset the user's selection.
   *  3. nothing remembered — the first row.
   *  4. empty list — null, which is what raises the "create your first" banner.
   */
  private reconcile(
    rows: any[],
    idKey: 'flock_id' | 'batch_id',
    lastIdKey: string,
    wrap: (row: any) => any
  ) {
    const current = this.currentFlockSubject.value;
    // "Is the selection one of MY rows" has to test batch-ness, not just the
    // id: flocks.flock_id and batches.batch_id are separate sequences that
    // both start at 1, so broiler flock N and layer batch N collide.
    const currentIsMine = idKey === 'batch_id'
      ? !!current?.batch_id
      : !!current && !current.batch_id;

    const match = currentIsMine
      ? rows.find(row => row[idKey] === current[idKey])
      : undefined;

    if (match) {
      this.publish(wrap(match), lastIdKey);
      return;
    }

    const lastId = localStorage.getItem(lastIdKey);
    const remembered = lastId ? rows.find(row => String(row[idKey]) === lastId) : undefined;
    const next = remembered || rows[0];
    this.publish(next ? wrap(next) : null, lastIdKey);
  }

  /**
   * The single write point for the current selection.
   *
   * There is deliberately no "same id, skip" guard here — replacing the cached
   * row with the freshly-read one is the entire job of the refresh path.
   * currentFlock$ dedupes on content instead, so an unchanged row still
   * produces no subscriber emission.
   */
  private publish(flock: any, lastIdKey: string) {
    if (!flock) {
      this.currentFlockSubject.next(null);
      localStorage.removeItem('currentFlock');
      return;
    }
    this.currentFlockSubject.next(flock);
    localStorage.setItem('currentFlock', JSON.stringify(flock));
    const id = lastIdKey === LAST_BATCH_KEY ? flock.batch_id : flock.flock_id;
    if (id != null) {
      localStorage.setItem(lastIdKey, String(id));
    }
  }

  // ── Get next flock number from DB — never use array.length ──
  async getNextFlockNumber(farmId: number): Promise<number> {
    const result = await this.db.get(
      `SELECT COUNT(*) as total FROM flocks WHERE farm_id = ?`,
      [farmId]
    );
    // COUNT(*) gives total rows including any gaps — add 1 for next.
    const total = result.success ? (result.data[0]?.total || 0) : 0;
    return total + 1;
  }
}
