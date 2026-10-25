import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';

@Injectable({
  providedIn: 'root'
})
export class FeedResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      if (!flock) return { traders: [], flock: null };
      const targetId = flock.flock_id || flock.batch_id;
      const moduleType = flock.batch_id ? 'layer' : 'broiler';
      const result = await this.db.get(
        `SELECT t.*,
          COALESCE(SUM(e.total_amount), 0) as total
         FROM Feed_traders t
         LEFT JOIN Feed_entries e ON t.trader_id = e.trader_id
         WHERE t.flock_id = ? AND t.module_type = ?
         GROUP BY t.trader_id
         ORDER BY t.trader_name ASC`,
        [targetId, moduleType]
      );

      return {
        traders: result.success ? result.data : [],
        flock,
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { traders: [], flock: null };
    }
  }
}
