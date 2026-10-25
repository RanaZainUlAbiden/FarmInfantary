import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { DatabaseService, DbBatchOp, BankSourceKey } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
@Component({
  selector: 'app-batch-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './batch-management.component.html',
  styleUrl: './batch-management.component.scss'
})
export class BatchManagementComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];

  // All layer farms for this account — populates the create-form dropdown
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

  private subs = new Subscription();

  get paginatedBatches() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.batches.slice(start, start + this.pageSize);
  }

  newRow = { batch_name: '', start_date: toLocalDateString(), end_date: '', initial_birds: null, breed: '', status: 'active', unit_id: null as number | null };

  constructor(
    private db: DatabaseService,
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
        this.loadBatches();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.loadUnits();
        this.loadBatches();
      })
    );

    // "Add Batch" sidebar shortcut: the layout navigates here with ?add=1, and
    // the inline new-batch row opens on arrival. This is a SHORTCUT, not a
    // second form — it calls the same `addNewRow()` the screen's own
    // "+ Add Batch" button calls, so there is one add path and one save path.
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
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, 'layer');
    this.units = result.success ? result.data : [];
    this.cdr.detectChanges();
  }

  async loadBatches() {
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty list.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;
    const sql = unitId
      ? `SELECT * FROM batches WHERE farm_id = ? AND unit_id = ? ORDER BY batch_id DESC`
      : `SELECT * FROM batches WHERE farm_id = ? ORDER BY batch_id DESC`;
    const params = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const result = await this.db.get(sql, params);
    this.batches = result.success ? result.data : [];
    this.cdr.detectChanges();
  }

  unitName(unitId: number | null | undefined): string {
    const unit = this.units.find(u => u.unit_id === unitId);
    return unit ? unit.unit_name : '—';
  }

  addNewRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.errorMessage = '';

    if (this.units.length === 0) {
      this.errorMessage = 'No farms set up for Layer yet. Go to the Farms page and create one before adding a batch.';
      this.cdr.detectChanges();
      return;
    }

    this.newRow = {
      batch_name: '',
      start_date: toLocalDateString(),
      end_date: '',
      initial_birds: null,
      breed: '',
      status: 'active',
      unit_id: this.currentUnit?.unit_id ?? this.units[0].unit_id
    };
    this.showNewRow = true;
    this.cdr.detectChanges();
  }

  onStatusChangeForNew() {
    if (this.newRow.status === 'closed' && !this.newRow.end_date) {
      this.newRow.end_date = toLocalDateString();
    } else if (this.newRow.status === 'active') {
      this.newRow.end_date = '';
    }
  }

  onStatusChangeForEdit() {
    if (this.editForm.status === 'closed' && !this.editForm.end_date) {
      this.editForm.end_date = toLocalDateString();
    } else if (this.editForm.status === 'active') {
      this.editForm.end_date = '';
    }
  }

  async saveNewRow() {
    if (this.isSaving || !this.newRow.batch_name.trim()) return;
    if (Number(this.newRow.initial_birds) < 0) {
      this.errorMessage = 'Number of birds cannot be negative.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.newRow.unit_id) {
      this.errorMessage = 'Please select a farm.';
      this.cdr.detectChanges();
      return;
    }
    this.isSaving = true;
    this.showNewRow = false;
    this.errorMessage = '';
    try {
      await this.db.run(
        `INSERT INTO batches (farm_id, batch_name, start_date, end_date, initial_birds, breed, status, unit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.currentFarm.farm_id, this.newRow.batch_name.trim(), this.newRow.start_date, this.newRow.end_date || null, this.newRow.initial_birds || 0, this.newRow.breed || '', this.newRow.status, this.newRow.unit_id]
      );
      await this.loadBatches();
      this.dataChange.announce('batches');
    } catch {
      this.errorMessage = 'Could not create batch.';
      this.showNewRow = true;
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }



  cancelNewRow() {
    if (!this.isSaving) this.showNewRow = false;
  }

  startEdit(batch: any) {
    if (this.isSaving) return;
    this.showNewRow = false;
    this.errorMessage = '';
    this.editingId = batch.batch_id;
    this.editForm = { batch_name: batch.batch_name, start_date: batch.start_date, end_date: batch.end_date || '', initial_birds: batch.initial_birds, breed: batch.breed || '', status: batch.status, unit_id: batch.unit_id };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(batchId: number) {
    if (this.isSaving || !this.editForm.batch_name?.trim()) return;
    if (Number(this.editForm.initial_birds) < 0) {
      this.errorMessage = 'Number of birds cannot be negative.';
      this.cdr.detectChanges();
      return;
    }
    this.isSaving = true;
    this.editingId = null;
    this.errorMessage = '';
    try {
      // A batch's farm is fixed at creation — unit_id is deliberately not
      // part of this UPDATE.
      await this.db.run(
        `UPDATE batches SET batch_name = ?, start_date = ?, end_date = ?, initial_birds = ?, breed = ?, status = ? WHERE batch_id = ?`,
        [this.editForm.batch_name.trim(), this.editForm.start_date, this.editForm.end_date || null, this.editForm.initial_birds || 0, this.editForm.breed || '', this.editForm.status, batchId]
      );
      this.editForm = {};
      await this.loadBatches();
      this.dataChange.announce('batches');
    } catch {
      this.errorMessage = 'Could not update batch.';
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(batchId: number) {
    if (this.isSaving) return;
    this.deletingId = batchId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving || !this.deletingId) return;
    const batchId = this.deletingId;
    this.isSaving = true;
    this.showDeleteDialog = false;
    this.errorMessage = '';
    try {
      // Explicitly clean up dependent records — FK cascades are not guaranteed
      // to be enforced (PRAGMA foreign_keys may be OFF), so do this manually.
      // One runBatch, so a failure part-way cannot orphan the children or leave
      // the batch listed with its data already gone.
      //
      // MODULE SCOPING — the mirror image of flock-management.component.
      // batches.batch_id and flocks.flock_id are separate AUTOINCREMENT
      // sequences shared across the whole database, so batch N collides with
      // broiler flock N. The shared tables below hold this batch_id in their
      // `flock_id` column alongside module_type = 'layer', so every one of them
      // must be filtered on BOTH or this delete wipes that flock's data.
      //
      // The test here is strict: a NULL module_type is NOT deleted. The backfill
      // in database.js leaves NULLs exactly on the colliding ids, and every read
      // path in the app resolves a NULL as broiler (COALESCE(module_type,
      // 'broiler')) while every layer read demands 'layer' outright — so a NULL
      // row is shown under the broiler flock and has never been visible here.
      // flock-management deletes those; between the two tests every row belongs
      // to exactly one side, none to both and none to neither.
      // BANK ENTRIES GO WITH THE ROWS THAT OWN THEM.
      //
      // Five of the tables below can be settled through a bank account, and
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
      // the two cannot disagree — including the strict `module_type = 'layer'`
      // on the shared tables, without which a batch delete would reverse the
      // colliding broiler flock's withdrawals.
      const reversals: DbBatchOp[] = [];
      const cascades: [BankSourceKey, string][] = [
        // Layer-only, keyed on batch_id.
        ['egg_sales',       `batch_id = ?`],
        ['hen_sales',       `batch_id = ?`],
        // Shared with broiler: flock_id holds this batch_id, and the ids
        // collide from #1, so the module guard is load-bearing here.
        ['expenses',        `flock_id = ? AND module_type = 'layer'`],
        ['income',          `flock_id = ? AND module_type = 'layer'`],
        ['labour_payments', `flock_id = ? AND module_type = 'layer'`]
      ];
      for (const [table, scope] of cascades) {
        const rev = await this.db.bankCascadeReversalOps(table, scope, [batchId]);
        if (!rev.success) {
          this.errorMessage =
            'Could not delete batch: ' +
            friendlySqlError(rev.error, 'the bank entries could not be read.') +
            ' Nothing was deleted.';
          return;
        }
        reversals.push(...(rev.ops || []));
      }

      // AND THE DEBT A BANKED SALE CLEARED COMES BACK WITH THAT SALE.
      //
      // An egg or hen sale banked into one of the owner's accounts can
      // auto-settle what this batch's farm owed distribution, as a same-account
      // internal settlement that writes NO bank_ledger row. It is SALE-scoped —
      // it holds that sale's own id — and the sales are about to go, so it goes
      // with them. Leaving it would clear a debt with a sale that no longer
      // exists: the deposits above are reversed, so the accounts end where they
      // started and nothing anywhere would have paid it.
      //
      // The bill itself survives, correctly: it is farm-scoped and the own-farm
      // customer is keyed to the farm UNIT, so the farm still owes distribution
      // and can settle by hand later. Both sale tables, each by the SAME clause
      // its own delete below uses. The mirror of flock-management.component.
      for (const source of ['egg_sale', 'hen_sale'] as const) {
        const auto = await this.db.autoSettlementCascadeReversalOps(
          source, `batch_id = ?`, [batchId]
        );
        if (!auto.success) {
          this.errorMessage =
            'Could not delete batch: ' +
            friendlySqlError(auto.error,
              'the auto-settlements it paid could not be read.') +
            ' Nothing was deleted.';
          return;
        }
        reversals.push(...(auto.ops || []));
      }

      const result = await this.db.runBatch([
        // Ahead of the deletes: each one reads the rows it is reversing.
        ...reversals,

        // Layer-only, keyed on batch_id — no ambiguity to guard against.
        { sql: `DELETE FROM egg_collection  WHERE batch_id = ?`, params: [batchId] },
        { sql: `DELETE FROM egg_sales       WHERE batch_id = ?`, params: [batchId] },
        // Was missing — hen sales survived every batch delete as orphans.
        { sql: `DELETE FROM hen_sales       WHERE batch_id = ?`, params: [batchId] },
        { sql: `DELETE FROM vaccinations    WHERE batch_id = ?`, params: [batchId] },
        { sql: `DELETE FROM layer_mortality WHERE batch_id = ?`, params: [batchId] },
        { sql: `DELETE FROM layer_health    WHERE batch_id = ?`, params: [batchId] },
        // The layer Ledger screen's own book. Entries before their ledgers, so
        // nothing is briefly orphaned — and note this needs NO module_type guard:
        // `layer_ledgers`/`layer_ledger_entries` are keyed on batch_id and hold
        // no flock's rows, which is the whole reason they are separate tables
        // from `ledgers`/`ledger_entries` rather than module_type on those.
        { sql: `DELETE FROM layer_ledger_entries WHERE batch_id = ?`, params: [batchId] },
        { sql: `DELETE FROM layer_ledgers        WHERE batch_id = ?`, params: [batchId] },

        // Shared broiler/layer tables: flock_id holds this batch_id when
        // module_type = 'layer'. All were missing, so a deleted batch left its
        // feed, medicine, expenses, income and labour behind for good.
        // Entries before their traders, so nothing is briefly orphaned.
        { sql: `DELETE FROM medicine_entries WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM medicine_traders WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM feed_entries     WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM feed_traders     WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM chick_entries    WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM chick_traders    WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM expenses         WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM income           WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },
        { sql: `DELETE FROM labour_payments  WHERE flock_id = ? AND module_type = 'layer'`, params: [batchId] },

        { sql: `DELETE FROM batches          WHERE batch_id = ?`, params: [batchId] }
      ]);

      if (!result?.success) {
        this.errorMessage =
          'Could not delete batch: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was deleted.';
        return;
      }

      this.batches = this.batches.filter(b => b.batch_id !== batchId);
      this.dataChange.announce('batches');
    } catch (err: any) {
      this.errorMessage = 'Could not delete batch: ' + (err?.message || err);
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
