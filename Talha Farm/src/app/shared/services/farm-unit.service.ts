import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, distinctUntilChanged } from 'rxjs';
import { DatabaseService } from './database.service';

// The last unit selected within each module, so switching business tabs and
// back does not reset the selection.
const LAST_UNIT_KEY: { [module: string]: string } = {
  broiler: 'lastBroilerUnitId',
  layer: 'lastLayerUnitId'
};

/**
 * Same-content test for the current-unit stream — see the identical guard in
 * flock.service.ts for why this compares the whole row rather than the id.
 * An edit to a unit's own fields (unit_name, opening_balance) must reach
 * subscribers; a redundant re-emission of an unchanged row must not.
 */
function sameRow(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

@Injectable({
  providedIn: 'root'
})
export class FarmUnitService {

  private currentUnitSubject = new BehaviorSubject<any>(null);
  private unitsSubject = new BehaviorSubject<any[]>([]);
  private moduleChangedSubject = new Subject<'broiler' | 'layer'>();

  currentUnit$ = this.currentUnitSubject.asObservable().pipe(distinctUntilChanged(sameRow));

  units$ = this.unitsSubject.asObservable();

  // Emits whenever the ACTIVE MODULE (broiler/layer) changes — business tab
  // switch or a business-type change. This is NOT a data-change channel:
  // nothing was written, the app is just looking at a different module. Data
  // changes go through DataChangeService.
  moduleChanged$ = this.moduleChangedSubject.asObservable();

  notifyModuleChanged(moduleType: 'broiler' | 'layer') {
    this.moduleChangedSubject.next(moduleType);
  }

  constructor(private db: DatabaseService) {
    const stored = localStorage.getItem('currentUnit');
    if (stored) {
      try {
        this.currentUnitSubject.next(JSON.parse(stored));
      } catch {
        this.currentUnitSubject.next(null);
      }
    }
  }

  setCurrentUnit(unit: any) {
    this.publish(unit);
  }

  getCurrentUnit(): any {
    return this.currentUnitSubject.value;
  }

  /**
   * Drop every cached selection — root services outlive a logout, so without
   * this the next account inherits the previous one's current unit.
   */
  reset() {
    this.unitsSubject.next([]);
    this.currentUnitSubject.next(null);
    localStorage.removeItem('currentUnit');
    localStorage.removeItem(LAST_UNIT_KEY['broiler']);
    localStorage.removeItem(LAST_UNIT_KEY['layer']);
  }

  /**
   * Re-read this farm's units for one module, publish them, and reconcile the
   * current selection against the fresh list.
   *
   * Same four cases as FlockService.refreshFlocks() — keep the selection but
   * swap in the fresh row, else the module's remembered unit, else the first,
   * else null. The fallback chain used to live in
   * LayoutComponent.loadUnitsForActiveModule(); it lives here so that a screen
   * which writes to farm_units can correct the shared selection without
   * needing the layout to run.
   */
  async refreshUnits(farmId: number, moduleType: string): Promise<any[]> {
    const result = await this.db.get(
      `SELECT * FROM farm_units WHERE farm_id = ? AND module_type = ? ORDER BY unit_id ASC`,
      [farmId, moduleType]
    );
    const units = result.success ? result.data : [];
    this.unitsSubject.next(units);

    const current = this.currentUnitSubject.value;
    // A unit from another module is not a candidate here even if its id
    // happens to appear in this list — module_type is what separates them.
    const currentIsMine = current && current.module_type === moduleType;
    const match = currentIsMine
      ? units.find((unit: any) => unit.unit_id === current.unit_id)
      : undefined;

    if (match) {
      this.publish(match, moduleType);
      return units;
    }

    const lastIdKey = LAST_UNIT_KEY[moduleType];
    const lastId = lastIdKey ? localStorage.getItem(lastIdKey) : null;
    const remembered = lastId ? units.find((unit: any) => String(unit.unit_id) === lastId) : undefined;
    this.publish(remembered || units[0] || null, moduleType);
    return units;
  }

  /**
   * The single write point for the current unit. No "same id, skip" guard —
   * replacing the cached row with the fresh one is the point. currentUnit$
   * dedupes on content instead.
   */
  private publish(unit: any, moduleType?: string) {
    if (!unit) {
      this.currentUnitSubject.next(null);
      localStorage.removeItem('currentUnit');
      return;
    }
    this.currentUnitSubject.next(unit);
    localStorage.setItem('currentUnit', JSON.stringify(unit));
    const lastIdKey = LAST_UNIT_KEY[moduleType || unit.module_type];
    if (lastIdKey && unit.unit_id != null) {
      localStorage.setItem(lastIdKey, String(unit.unit_id));
    }
  }
}
