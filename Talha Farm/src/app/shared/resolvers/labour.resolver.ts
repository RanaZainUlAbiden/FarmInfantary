import { Injectable } from '@angular/core';
import { Resolve, ActivatedRouteSnapshot } from '@angular/router';
import { DatabaseService } from '../services/database.service';
import { FlockService } from '../services/flock.service';
import { AuthService } from '../services/auth.service';

@Injectable({
  providedIn: 'root'
})
export class LabourResolver implements Resolve<any> {
  constructor(
    private db: DatabaseService,
    private flockService: FlockService,
    private authService: AuthService
  ) {}

  async resolve(route: ActivatedRouteSnapshot) {
    try {
      const flock = this.flockService.getCurrentFlock();
      const farm = this.authService.getCurrentFarm();
      if (!flock || !farm) return { flock: null, roster: [], payments: [] };

      const targetId = flock.flock_id || flock.batch_id;
      const moduleType = flock.batch_id ? 'layer' : 'broiler';

      const rosterResult = await this.db.get(
        `SELECT * FROM labour WHERE farm_id = ? AND status = 'active' ORDER BY labour_name ASC`,
        [farm.farm_id]
      );

      // LEFT JOIN + the same module fragment as labour.component.ts's
      // loadPayments(). A deleted roster entry must not hide payments that were
      // really made — Overview and the Farm Report never join `labour`, so an
      // INNER JOIN here made the two disagree with no visible cause.
      const moduleWhere = moduleType === 'layer'
        ? `lp.module_type = 'layer'`
        : `COALESCE(lp.module_type,'broiler') = 'broiler'`;
      const paymentsResult = await this.db.get(
        `SELECT lp.*, COALESCE(l.labour_name, 'Deleted Worker') AS labour_name
         FROM labour_payments lp
         LEFT JOIN labour l ON lp.labour_id = l.labour_id
         WHERE lp.flock_id = ? AND ${moduleWhere}
         ORDER BY lp.date ASC`,
        [targetId]
      );

      return {
        flock,
        roster: rosterResult.success ? rosterResult.data : [],
        payments: paymentsResult.success ? paymentsResult.data : [],
        timestamp: new Date().getTime()
      };
    } catch (error) {
      return { flock: null, roster: [], payments: [] };
    }
  }
}