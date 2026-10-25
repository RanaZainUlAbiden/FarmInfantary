import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { BackLinkComponent } from '../shared/components/back-link/back-link.component';

@Component({
  selector: 'app-customer-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, BackLinkComponent],
  templateUrl: './customer-management.component.html',
  styleUrl: './customer-management.component.scss'
})
export class CustomerManagementComponent implements OnInit {
  currentFarm: any = null; customers: any[] = []; showNewRow = false; editingId: number | null = null;
  editForm: any = {}; showDeleteDialog = false; deletingId: number | null = null; isSaving = false; errorMessage = '';
  newRow = { customer_name: '', phone: '', address: '' };

  constructor(private db: DatabaseService, private authService: AuthService, private cdr: ChangeDetectorRef) {}
  ngOnInit() { this.currentFarm = this.authService.getCurrentFarm(); this.loadCustomers(); }

  // Own-farm customers are excluded from this screen. They stand for the
  // owner's own farm_units, are created and named by the app when distribution
  // sells to a farm, and are keyed on unit_id — renaming or deleting one here
  // would orphan the debt on every own-farm bill pointing at it. Their balances
  // are visible (and settleable) on the Customer Ledger screen, which includes
  // them deliberately. The write methods below repeat the guard so a stale id
  // cannot reach them either.
  private static readonly EXTERNAL_ONLY = `COALESCE(customer_type,'external') <> 'own_farm'`;

  async loadCustomers() {
    const r = await this.db.get(
      `SELECT * FROM customers WHERE farm_id=? AND ${CustomerManagementComponent.EXTERNAL_ONLY} ORDER BY customer_name ASC`,
      [this.currentFarm.farm_id]
    );
    this.customers = r.success ? r.data : []; this.cdr.detectChanges();
  }
  addNewRow() { this.showNewRow = true; this.newRow = { customer_name: '', phone: '', address: '' }; }
  cancelNewRow() { this.showNewRow = false; }
  async saveNewRow() {
    if (!this.newRow.customer_name.trim()) return;
    this.isSaving = true; this.showNewRow = false;
    await this.db.run('INSERT INTO customers (farm_id, customer_name, phone, address) VALUES (?,?,?,?)', [this.currentFarm.farm_id, this.newRow.customer_name, this.newRow.phone, this.newRow.address]);
    this.isSaving = false; await this.loadCustomers();
  }
  startEdit(c: any) { this.editingId = c.customer_id; this.editForm = { customer_name: c.customer_name, phone: c.phone, address: c.address, outstanding_balance: c.outstanding_balance }; }
  cancelEdit() { this.editingId = null; }
  async saveEdit(id: number) {
    await this.db.run(
      `UPDATE customers SET customer_name=?, phone=?, address=?, outstanding_balance=? WHERE customer_id=? AND ${CustomerManagementComponent.EXTERNAL_ONLY}`,
      [this.editForm.customer_name, this.editForm.phone, this.editForm.address, this.editForm.outstanding_balance || 0, id]
    );
    this.editingId = null; await this.loadCustomers();
  }
  confirmDelete(id: number) { this.deletingId = id; this.showDeleteDialog = true; }
  async onDeleteConfirmed() {
    await this.db.run(
      `DELETE FROM customers WHERE customer_id=? AND ${CustomerManagementComponent.EXTERNAL_ONLY}`,
      [this.deletingId]
    );
    this.showDeleteDialog = false; await this.loadCustomers();
  }
  onDeleteCancelled() { this.showDeleteDialog = false; }
}