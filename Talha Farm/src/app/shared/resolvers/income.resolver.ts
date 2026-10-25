import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';

@Injectable({
  providedIn: 'root'
})
export class IncomeResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      if (!flock) return { income: [], flock: null };

      // Layer batches are stored in FlockService shaped like a flock (with a
      // batch_id). Scope income by module_type so batch and flock income —
      // which can share the same numeric id — never mix.
      const moduleType = flock.batch_id ? 'layer' : 'broiler';
      const result = await this.db.get(
        `SELECT * FROM income
         WHERE flock_id = ? AND module_type = ?
         ORDER BY date DESC, income_id ASC`,
        [flock.flock_id, moduleType]
      );

      return {
        income: result.success ? result.data : [],
        flock,
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { income: [], flock: null };
    }
  }
}
