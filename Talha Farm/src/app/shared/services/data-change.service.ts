import { Injectable } from '@angular/core';
import { Observable, Subject, filter, map } from 'rxjs';

/**
 * The entities a writer must announce.
 *
 * Deliberately just these three. Every screen in this app is a lazy
 * standalone component that is destroyed on navigation and re-reads in its
 * own ngOnInit (or resolver), so for everything else **navigation is the
 * invalidation** and no announcement is needed.
 *
 * These three are the exception because they are displayed by the layout
 * shell, which mounts once per login at /app and is never destroyed, and
 * because they are cached in root services (FlockService, FarmUnitService)
 * that every screen reads. Nothing about a navigation refreshes those.
 *
 * Do not grow this list to cover ordinary tables — that would be a
 * cache-invalidation framework this app does not need and will not maintain.
 */
export type DataScope = 'units' | 'flocks' | 'batches';

/**
 * "I changed this data, everyone re-read it."
 *
 * This replaces the hand-wired FarmUnitService.unitsChanged$ and
 * FlockService.batchesChanged$, which were added one per bug and left flocks —
 * the entity at the centre of the whole broiler module — with no channel at
 * all. One channel means there is exactly one thing to remember, and
 * scripts/verify/verify_change_announcements.js can check that every writer
 * remembered it.
 */
@Injectable({
  providedIn: 'root'
})
export class DataChangeService {

  private changedSubject = new Subject<DataScope>();

  /** Every announcement, for a consumer that cares about more than one scope. */
  changed$ = this.changedSubject.asObservable();

  /** Announcements for one scope. */
  onChange(scope: DataScope): Observable<void> {
    return this.changed$.pipe(
      filter(changed => changed === scope),
      map(() => undefined)
    );
  }

  /**
   * Announce that `scope`'s rows changed. Call after create, edit AND delete —
   * a delete that is not announced leaves the selection pointing at a row that
   * no longer exists, which is worse than a missed create.
   */
  announce(scope: DataScope) {
    this.changedSubject.next(scope);
  }
}
