import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { FlockService } from '../shared/services/flock.service';
import { AuthService } from '../shared/services/auth.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
@Component({
  selector: 'app-flock-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './flock-management.component.html',
  styleUrl: './flock-management.component.scss'
})
export class FlockManagementComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  flocks: any[] = [];

  // All broiler farms for this account — populates the create-form dropdown
  // and resolves unit_id -> unit_name for the read-only edit-form display.
  units: any[] = [];
  // The farm currently selected in the sidebar — drives list filtering.
  currentUnit: any = null;

  showNewRow = false;
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  errorMessage = '';

  currentPage = 1;
  pageSize = 10;

  searchTerm: string = '';

  private subs = new Subscription();

  get filteredFlocks(): any[] {
    const term = this.searchTerm.toLowerCase().trim();
    if (!term) return this.flocks;
    return this.flocks.filter(f => f.flock_name?.toLowerCase().includes(term));
  }

  onSearchChange() {
    this.currentPage = 1;
    this.cdr.detectChanges();
  }

  get paginatedFlocks() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredFlocks.slice(start, start + this.pageSize);
  }

  newRow = {
    flock_name: '',
    start_date: toLocalDateString(),
    end_date: '',
    status: 'active',
    unit_id: null as number | null
  };

  constructor(
    private db: DatabaseService,
    private flockService: FlockService,
    private authService: AuthService,
    private farmUnitService: FarmUnitService,
    private dataChange: DataChangeService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // Load units first — the currentUnit$ subscription below fires
    // synchronously (BehaviorSubject) and its filtering depends on
    // this.units already being populated.
    await this.loadUnits();

    this.subs.add(
      this.farmUnitService.currentUnit$.subscribe(unit => {
        this.currentUnit = unit;
        this.refresh();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.loadUnits();
        this.refresh();
      })
    );

    // "Add Flock" sidebar shortcut: the layout navigates here with ?add=1, and
    // the inline new-flock row opens on arrival. This is a SHORTCUT, not a
    // second form — it calls the same `addNewRow()` the screen's own
    // "+ Add Flock" button calls, so there is one add path and one save path.
    //
    // Subscribed rather than read once, because the user can click the
    // shortcut again while already on this screen; `navigate()` in the layout
    // stamps a nonce onto the params so that re-click really is a new URL and
    // this fires. Units are already loaded above, so `addNewRow()` can show
    // its "no farms set up" message rather than opening an unusable row.
    this.subs.add(
      this.route.queryParams.subscribe(params => {
        if (params['add']) this.addNewRow();
      })
    );
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
  }

  async loadUnits() {
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, 'broiler');
    this.units = result.success ? result.data : [];
    this.cdr.detectChanges();
  }

  private async refresh() {
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty list.
    // Queries the DB directly (not flockService.refreshFlocks) so this page's
    // full list — including closed flocks — never overwrites the sidebar's
    // filtered active-only selector, which shares the same flocksSubject.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;
    const sql = unitId
      ? `SELECT * FROM flocks WHERE farm_id = ? AND unit_id = ? ORDER BY flock_id ASC`
      : `SELECT * FROM flocks WHERE farm_id = ? ORDER BY flock_id ASC`;
    const params = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const result = await this.db.get(sql, params);
    this.flocks = result.success ? result.data : [];
    this.cdr.detectChanges();
  }

  unitName(unitId: number | null | undefined): string {
    const unit = this.units.find(u => u.unit_id === unitId);
    return unit ? unit.unit_name : '—';
  }

  // ── Auto-fill end date when status changes to closed ──────
  onStatusChangeForNew() {
    if (this.newRow.status === 'closed' && !this.newRow.end_date) {
      this.newRow.end_date = toLocalDateString();
    }
    if (this.newRow.status === 'active') {
      this.newRow.end_date = '';
    }
  }

  onStatusChangeForEdit() {
    if (this.editForm.status === 'closed' && !this.editForm.end_date) {
      this.editForm.end_date = toLocalDateString();
    }
    if (this.editForm.status === 'active') {
      this.editForm.end_date = '';
    }
  }

  // ── Add ────────────────────────────────────────────────────
  async addNewRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.errorMessage = '';

    if (this.units.length === 0) {
      this.errorMessage = 'No farms set up for Broiler yet. Go to the Farms page and create one before adding a flock.';
      this.cdr.detectChanges();
      return;
    }

    const nextNum = await this.flockService.getNextFlockNumber(this.currentFarm.farm_id);
    const year = new Date().getFullYear().toString().slice(-2);

    this.newRow = {
      flock_name: 'F#' + nextNum + '-Y' + year,
      start_date: toLocalDateString(),
      end_date: '',
      status: 'active',
      unit_id: this.currentUnit?.unit_id ?? this.units[0].unit_id
    };
    this.showNewRow = true;
    this.cdr.detectChanges();
  }

  /** A write that failed aborts the save instead of being committed around. */
  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'unknown error')}`);
    }
    return result;
  }

  async saveNewRow() {
    if (this.isSaving) return;
    if (!this.newRow.flock_name.trim()) return;
    if (!this.newRow.unit_id) {
      this.errorMessage = 'Please select a farm.';
      this.cdr.detectChanges();
      return;
    }

    this.isSaving = true;
    this.errorMessage = '';

    try {
      // A flock is one row and nothing else. The chick purchase used to be
      // written alongside it here; it now lives on the broiler Chicks screen,
      // which is where chicks arrive from Distribution as well — see
      // `chick_entries` in electron/database.js.
      this.assertOk(
        await this.db.run(
          'INSERT INTO flocks (farm_id, flock_name, start_date, end_date, status, unit_id) VALUES (?, ?, ?, ?, ?, ?)',
          [
            this.currentFarm.farm_id,
            this.newRow.flock_name.trim(),
            this.newRow.start_date,
            this.newRow.end_date || null,
            this.newRow.status,
            this.newRow.unit_id
          ]
        ),
        'Could not create this flock'
      );

      this.showNewRow = false;
      await this.refresh();
      // Nothing else in the app reads this screen's local list. The sidebar's
      // flock selector, the current-flock slot every other screen scopes its
      // queries by, and the layout's "create your first flock" banner all hang
      // off FlockService — which has no idea a row was just inserted unless
      // this says so. Without it the first flock on a fresh account stays
      // invisible until a business-tab round trip happens to re-read flocks.
      this.dataChange.announce('flocks');
    } catch (err: any) {
      // Nothing was written. The new row is left open with everything the
      // client typed still in it, so the save can simply be retried.
      this.errorMessage = (err?.message || String(err)) + '. Nothing was saved.';
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  cancelNewRow() {
    if (this.isSaving) return;
    this.showNewRow = false;
  }

  // ── Edit ───────────────────────────────────────────────────
  startEdit(flock: any) {
    if (this.isSaving) return;
    this.showNewRow = false;
    this.editingId = flock.flock_id;
    this.editForm = {
      flock_name: flock.flock_name,
      start_date: flock.start_date,
      end_date: flock.end_date || '',
      status: flock.status,
      unit_id: flock.unit_id
    };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(flockId: number) {
    if (this.isSaving) return;
    if (!this.editForm.flock_name?.trim()) return;

    this.isSaving = true;
    this.editingId = null;

    try {
      // A flock's farm is fixed at creation — unit_id is deliberately not
      // part of this UPDATE.
      await this.db.run(
        'UPDATE flocks SET flock_name = ?, start_date = ?, end_date = ?, status = ? WHERE flock_id = ?',
        [
          this.editForm.flock_name.trim(),
          this.editForm.start_date,
          this.editForm.end_date || null,
          this.editForm.status,
          flockId
        ]
      );
      this.editForm = {};
      await this.refresh();
      // A rename has to reach the sidebar label and the header badge too.
      this.dataChange.announce('flocks');
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ─────────────────────────────────────────────────
  confirmDelete(flockId: number) {
    if (this.isSaving) return;
    this.deletingId = flockId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving || !this.deletingId) return;
    const flockId = this.deletingId;
    this.isSaving = true;
    this.showDeleteDialog = false;
    this.errorMessage = '';

    try {
      // Foreign keys are declared but never enforced (PRAGMA foreign_keys is
      // left OFF), so nothing cascades and every child row has to go by hand.
      // One runBatch, so a failure part-way cannot leave the flock deleted with
      // its children behind — or, worse, the children deleted and the flock
      // still listed.
      //
      // MODULE SCOPING — the reason for the guards below.
      // flocks.flock_id and batches.batch_id are separate AUTOINCREMENT
      // sequences, and the ids are database-wide rather than per account, so
      // broiler flock N and layer batch N collide from #1 and may not even
      // belong to the same login. The shared tables reuse `flock_id` to hold a
      // batch_id when module_type = 'layer', so an unguarded
      // `WHERE flock_id = ?` on any of them deletes that batch's data.
      //
      // NULL module_type counts as broiler and IS deleted here. The backfill in
      // database.js can only resolve a NULL when the id exists in exactly one of
      // flocks/batches, so it leaves NULLs behind precisely on the colliding ids
      // — the population at issue. Every read path already resolves that the
      // same way (overview.service, farm-report.service, report.component all
      // use COALESCE(module_type,'broiler')), and every layer read filters
      // module_type = 'layer' strictly: a NULL row is already shown under this
      // flock and already invisible to every layer screen. Deleting it removes
      // what the user actually saw; keeping it would strand a row no screen can
      // reach again, on an id that is never reissued. batch-management.component
      // uses the strict 'layer' test for the same reason, so between the two
      // every row is claimed by exactly one side.
      const broiler = `COALESCE(module_type, 'broiler') = 'broiler'`;

      // BANK ENTRIES GO WITH THE ROWS THAT OWN THEM.
      //
      // Four of the tables below can be settled through a bank account, and
      // each such row has exactly one `bank_ledger` entry keyed to its primary
      // key. Deleting the row without its entry would leave the ledger holding
      // a line for a record that no longer exists and the account's
      // `current_balance` counting money that never moved — the same drift the
      // whole mechanism exists to prevent, arriving by the one path that never
      // shows a form.
      //
      // The accounts have to be read NOW, before anything is deleted: once the
      // rows are gone there is nothing left to say which balances to rebuild.
      // Each reversal is scoped by the IDENTICAL clause as its delete below, so
      // the two cannot disagree — including the module guard, without which a
      // flock delete would reverse the colliding layer batch's deposits.
      const reversals: DbBatchOp[] = [];
      for (const table of ['expenses', 'income', 'sales', 'labour_payments'] as const) {
        const rev = await this.db.bankCascadeReversalOps(
          table, `flock_id = ? AND ${broiler}`, [flockId]
        );
        if (!rev.success) {
          this.errorMessage =
            'Could not delete this flock: ' +
            friendlySqlError(rev.error, 'the bank entries could not be read.') +
            ' Nothing was deleted.';
          return;
        }
        reversals.push(...(rev.ops || []));
      }

      // AND THE DEBT A BANKED SALE CLEARED COMES BACK WITH THAT SALE.
      //
      // A bank sale can auto-settle what this flock's farm owed distribution,
      // as a same-account internal settlement that writes NO bank_ledger row.
      // It is SALE-scoped — it holds the sale's own id — and the sales are about
      // to go, so it goes with them. Leaving it would clear a debt with a sale
      // that no longer exists: the deposit above is reversed, so the account
      // ends where it started, and nothing anywhere would have paid the 50,000.
      //
      // The bill itself survives, correctly: it is farm-scoped and the own-farm
      // customer is keyed to the farm UNIT, so the farm still owes distribution
      // and can settle by hand later.
      //
      // The SAME scope clause as the sales delete below, module guard included
      // — without it this would un-settle the colliding layer batch's sales.
      const autoSettlements = await this.db.autoSettlementCascadeReversalOps(
        'broiler_sale', `flock_id = ? AND ${broiler}`, [flockId]
      );
      if (!autoSettlements.success) {
        this.errorMessage =
          'Could not delete this flock: ' +
          friendlySqlError(autoSettlements.error,
            'the auto-settlements it paid could not be read.') +
          ' Nothing was deleted.';
        return;
      }
      reversals.push(...(autoSettlements.ops || []));

      const result = await this.db.runBatch([
        // Ahead of the deletes: each one reads the rows it is reversing.
        ...reversals,

        // Broiler-only tables — no layer screen writes to these, so flock_id
        // here can only ever be a real flock_id.
        { sql: `DELETE FROM flock_health     WHERE flock_id = ?`, params: [flockId] },
        { sql: `DELETE FROM ledger_entries   WHERE flock_id = ?`, params: [flockId] },
        { sql: `DELETE FROM ledgers          WHERE flock_id = ?`, params: [flockId] },
        { sql: `DELETE FROM brokers          WHERE flock_id = ?`, params: [flockId] },
        // vaccinations carries both keys; a layer row has batch_id set and
        // flock_id NULL, so it cannot match this.
        { sql: `DELETE FROM vaccinations     WHERE flock_id = ?`, params: [flockId] },

        // Shared broiler/layer tables — module_type is what tells the two apart.
        // Entries before their traders, so nothing is briefly orphaned.
        { sql: `DELETE FROM medicine_entries WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM medicine_traders WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM feed_entries     WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM feed_traders     WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM chick_entries    WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM chick_traders    WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM expenses         WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM income           WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM sales            WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        { sql: `DELETE FROM balance          WHERE flock_id = ? AND ${broiler}`, params: [flockId] },
        // Was missing entirely — labour payments are recorded per flock and per
        // batch in the same table, and were left orphaned by every flock delete.
        { sql: `DELETE FROM labour_payments  WHERE flock_id = ? AND ${broiler}`, params: [flockId] },

        { sql: `DELETE FROM flocks           WHERE flock_id = ?`, params: [flockId] }
      ]);

      if (!result?.success) {
        this.errorMessage =
          'Could not delete this flock: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was deleted.';
        return;
      }

      await this.refresh();
      // Load-bearing on delete specifically: FlockService is still holding the
      // deleted flock as the current selection, so every other screen would go
      // on querying WHERE flock_id = <deleted> and show empty tables instead
      // of the empty state. The announcement is what makes it fall back.
      this.dataChange.announce('flocks');
    } catch (err: any) {
      this.errorMessage = 'Could not delete this flock: ' + (err?.message || err);
    } finally {
      this.deletingId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }
}
