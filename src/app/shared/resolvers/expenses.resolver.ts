import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';

@Injectable({
  providedIn: 'root'
})
export class ExpensesResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      if (!flock) return { expenses: [], flock: null };

      // `expenses` is shared with the layer module, which files a batch_id in
      // flock_id — and the two id sequences collide. Without the guard this
      // broiler screen lists layer batch N's expenses alongside flock N's.
      // Must stay identical to expenses.component.ts's own loadData().
      //
      // Expenses only, and no join to `ledgers`. The two are independent books:
      // the Ledger screen owns every ledger_entries row and an expense touches
      // none of them. A row's `category` is its own column.
      const expensesResult = await this.db.get(
        `SELECT e.* FROM expenses e
         WHERE e.flock_id = ? AND COALESCE(e.module_type,'broiler') = 'broiler'
         ORDER BY e.date DESC`,
        [flock.flock_id]
      );

      return {
        expenses: expensesResult.success ? expensesResult.data : [],
        flock,
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { expenses: [], flock: null };
    }
  }
}