import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { BackLinkComponent } from '../shared/components/back-link/back-link.component';

@Component({
  selector: 'app-supplier-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, BackLinkComponent],
  templateUrl: './supplier-management.component.html',
  styleUrl: './supplier-management.component.scss'
})
export class SupplierManagementComponent implements OnInit {
  currentFarm: any = null;
  suppliers: any[] = [];
  showNewRow = false;
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  errorMessage = '';
  isLoading = false;
  
  newRow = { supplier_name: '', phone: '', products_supplied: '' };

  constructor(private db: DatabaseService, private authService: AuthService, private cdr: ChangeDetectorRef) {}
  
  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadSuppliers();
  }

  // 🔥 FIX: Use getAllSuppliersWithBalance to get outstanding_balance
  async loadSuppliers() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const r = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      this.suppliers = r.success ? r.data : [];
      this.cdr.detectChanges();
    } catch (err: any) {
      this.errorMessage = 'Failed to load suppliers: ' + err.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // Total payable across all suppliers (sum of outstanding_balance)
  //
  // All three figures come off the one `getAllSuppliersWithBalance()` query,
  // which derives them from `supplier_ledger` on every read. Nothing here is
  // stored on `suppliers` — a cached balance would drift from the rows behind
  // it, and the rows are the only record of what is owed.
  getTotalPayable(): number {
    return this.suppliers.reduce((sum, s) => sum + (s.outstanding_balance || 0), 0);
  }

  getTotalPurchased(): number {
    return this.suppliers.reduce((sum, s) => sum + (Number(s.total_purchased) || 0), 0);
  }

  getTotalPaid(): number {
    return this.suppliers.reduce((sum, s) => sum + (Number(s.total_paid) || 0), 0);
  }

  addNewRow() {
    this.showNewRow = true;
    this.errorMessage = '';
    this.newRow = { supplier_name: '', phone: '', products_supplied: '' };
  }
  
  cancelNewRow() {
    this.showNewRow = false;
  }

  isValidPhone(phone: string): boolean {
    if (!phone || !phone.trim()) return true;
    const digits = phone.replace(/[\s\-()+]/g, '');
    return /^\d{7,15}$/.test(digits);
  }

  async saveNewRow() {
    if (!this.newRow.supplier_name.trim()) return;
    if (!this.isValidPhone(this.newRow.phone)) {
      this.errorMessage = 'Enter a valid phone number (7–15 digits).';
      this.cdr.detectChanges();
      return;
    }
    this.isSaving = true;
    this.showNewRow = false;
    this.errorMessage = '';
    try {
      await this.db.run(
        'INSERT INTO suppliers (farm_id, supplier_name, phone, products_supplied) VALUES (?,?,?,?)',
        [this.currentFarm.farm_id, this.newRow.supplier_name, this.newRow.phone, this.newRow.products_supplied]
      );
      await this.loadSuppliers();
    } catch (err: any) {
      this.errorMessage = 'Failed to save supplier: ' + err.message;
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  startEdit(s: any) {
    this.editingId = s.supplier_id;
    this.errorMessage = '';
    this.editForm = {
      supplier_name: s.supplier_name,
      phone: s.phone,
      products_supplied: s.products_supplied
    };
  }

  cancelEdit() {
    this.editingId = null;
  }

  async saveEdit(id: number) {
    if (!this.isValidPhone(this.editForm.phone)) {
      this.errorMessage = 'Enter a valid phone number (7–15 digits).';
      this.cdr.detectChanges();
      return;
    }
    this.errorMessage = '';
    try {
      await this.db.run(
        'UPDATE suppliers SET supplier_name=?, phone=?, products_supplied=? WHERE supplier_id=?',
        [this.editForm.supplier_name, this.editForm.phone, this.editForm.products_supplied, id]
      );
      this.editingId = null;
      await this.loadSuppliers();
    } catch (err: any) {
      this.errorMessage = 'Failed to update supplier: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) {
    this.deletingId = id;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    try {
      const result = await this.db.run('DELETE FROM suppliers WHERE supplier_id=?', [this.deletingId]);
      if (!result.success) throw new Error(result.error);
      this.showDeleteDialog = false;
      await this.loadSuppliers();
    } catch (err: any) {
      this.errorMessage = 'Failed to delete supplier: ' + err.message;
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
  }
}