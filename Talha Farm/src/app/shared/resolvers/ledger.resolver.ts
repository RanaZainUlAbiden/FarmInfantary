import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';

@Injectable({
  providedIn: 'root'
})
export class LedgerResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      if (!flock) return { ledgers: [], flock: null };

      const result = await this.db.get(
        `SELECT l.*, 
          COALESCE(SUM(le.amount), 0) as total
         FROM ledgers l
         LEFT JOIN ledger_entries le ON l.ledger_id = le.ledger_id
         WHERE l.flock_id = ?
         GROUP BY l.ledger_id
         ORDER BY l.created_at DESC`,
        [flock.flock_id]
      );

      return {
        ledgers: result.success ? result.data : [],
        flock,
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { ledgers: [], flock: null };
    }
  }
}