import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService } from '../shared/services/database.service';
import { FlockService } from '../shared/services/flock.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-balance',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe],
  templateUrl: './balance.component.html',
  styleUrl: './balance.component.scss'
})
export class BalanceComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  entries: any[] = [];
  showNewRow = false;
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;                          // ← re-entry guard

  private subs = new Subscription();

  newRow = {
    date: toLocalDateString(),
    description: '',
    amount: null as number | null,
    type: 'credit'
  };

  // ── Computed ─────────────────────────────────────────────────
  get currentBalance(): number {
    return this.entries.reduce((balance, entry) => {
      return entry.type === 'credit'
        ? balance + entry.amount
        : balance - entry.amount;
    }, 0);
  }

  get totalCredit(): number {
    return this.entries
      .filter(e => e.type === 'credit')
      .reduce((sum, e) => sum + e.amount, 0);
  }

  get totalDebit(): number {
    return this.entries
      .filter(e => e.type === 'debit')
      .reduce((sum, e) => sum + e.amount, 0);
  }

  getRunningBalance(index: number): number {
    return this.entries
      .slice(0, index + 1)
      .reduce((balance, entry) => {
        return entry.type === 'credit'
          ? balance + entry.amount
          : balance - entry.amount;
      }, 0);
  }

  constructor(
    private db: DatabaseService,
    private flockService: FlockService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef            // ← injected
  ) {}

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.entries = resolved.entries || [];
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          this.currentFlock = flock;
          this.showNewRow = false;
          this.editingId = null;
          this.isSaving = false;
          this.loadEntries();
        }
      })
    );
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
  }

  async loadEntries() {
    if (!this.currentFlock) return;
    const result = await this.db.get(
      `SELECT * FROM balance
       WHERE flock_id = ?
       ORDER BY date ASC, balance_id ASC`,
      [this.currentFlock.flock_id]
    );
    if (result.success) {
      this.entries = result.data;
      this.cdr.detectChanges();              // ← force re-render
    }
  }

  // ── Add ────────────────────────────────────────────────────
  addNewRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.newRow = {
      date: toLocalDateString(),
      description: '',
      amount: null,
      type: 'credit'
    };
    this.showNewRow = true;
  }

  async saveNewRow() {
    if (this.isSaving) return;
    if (!this.newRow.date || !this.newRow.amount) return;

    this.isSaving = true;
    this.showNewRow = false;                 // hide BEFORE await

    try {
      await this.db.run(
        `INSERT INTO balance (flock_id, date, description, amount, type)
         VALUES (?, ?, ?, ?, ?)`,
        [
          this.currentFlock.flock_id,
          this.newRow.date,
          this.newRow.description,
          this.newRow.amount,
          this.newRow.type
        ]
      );
      await this.loadEntries();
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
  startEdit(entry: any) {
    if (this.isSaving) return;
    this.showNewRow = false;
    this.editingId = entry.balance_id;
    this.editForm = {
      date: entry.date,
      description: entry.description,
      amount: entry.amount,
      type: entry.type
    };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(balanceId: number) {
    if (this.isSaving) return;

    this.isSaving = true;
    this.editingId = null;                   // hide BEFORE await

    try {
      await this.db.run(
        `UPDATE balance SET
          date = ?, description = ?, amount = ?, type = ?
         WHERE balance_id = ?`,
        [
          this.editForm.date,
          this.editForm.description,
          this.editForm.amount,
          this.editForm.type,
          balanceId
        ]
      );
      this.editForm = {};
      await this.loadEntries();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ─────────────────────────────────────────────────
  confirmDelete(balanceId: number) {
    if (this.isSaving) return;
    this.deletingId = balanceId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteDialog = false;           // hide BEFORE await

    try {
      if (this.deletingId) {
        await this.db.run(
          `DELETE FROM balance WHERE balance_id = ?`,
          [this.deletingId]
        );
        await this.loadEntries();
      }
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