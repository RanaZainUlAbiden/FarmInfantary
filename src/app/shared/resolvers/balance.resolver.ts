import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';

@Injectable({
  providedIn: 'root'
})
export class BalanceResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      if (!flock) return { entries: [], flock: null };

      const result = await this.db.get(
        `SELECT * FROM balance
         WHERE flock_id = ?
         ORDER BY date ASC, balance_id ASC`,
        [flock.flock_id]
      );

      return {
        entries: result.success ? result.data : [],
        flock,
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { entries: [], flock: null };
    }
  }
}