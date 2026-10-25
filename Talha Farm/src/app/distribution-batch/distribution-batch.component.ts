import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
@Component({
  selector: 'app-distribution-batch',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent],
  templateUrl: './distribution-batch.component.html',
  styleUrl: './distribution-batch.component.scss'
})
export class DistributionBatchComponent implements OnInit {
  productId: number = 0;
  farmId: number = 0;
  productName: string = '';
  productUnit: string = '';
  
  batches: any[] = [];
  isLoading = false;
  errorMessage = '';
  
  showBatchForm = false;
  isEditing = false;
  editingBatchId: number | null = null;
  batchForm: any = {
    manufacturing_date: '',
    expiry_date: '',
    quantity: 0,
    purchase_price: 0
  };
  
  showDeleteDialog = false;
  deletingBatchId: number | null = null;
  
  selectedBatchId: number | null = null;
  showTransactions = false;
  transactions: any[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.productId = +params['productId'];
      
      // 🔥 FIXED: Better error handling for invalid product ID
      if (!this.productId || this.productId === 0) {
        console.error('Invalid product ID in route');
        this.errorMessage = 'Invalid product ID';
        this.router.navigate(['/inventory']);
        return;
      }
      
      this.farmId = this.authService.getCurrentFarm()?.farm_id || 0;
      this.loadProductInfo();
      this.loadBatches();
    });
  }

  async loadProductInfo() {
    const result = await this.db.get('SELECT product_name, unit FROM products WHERE product_id = ?', [this.productId]);
    if (result.success && result.data && result.data.length > 0) {
      this.productName = result.data[0].product_name;
      this.productUnit = result.data[0].unit || 'unit';
    } else {
      this.errorMessage = 'Product not found';
    }
  }

  async loadBatches() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      await this.db.updateBatchStatuses();
      
      const result = await this.db.getBatchesByProduct(this.productId, this.farmId);
      if (result.success) {
        this.batches = result.data || [];
        const statusOrder: { [key: string]: number } = { expiring: 0, active: 1, depleted: 2, expired: 3 };
        this.batches.sort((a, b) => {
          const aStatus = a.calculated_status || a.status || 'active';
          const bStatus = b.calculated_status || b.status || 'active';
          return (statusOrder[aStatus] ?? 99) - (statusOrder[bStatus] ?? 99);
        });
      } else {
        this.errorMessage = 'Failed to load batches: ' + friendlySqlError(result.error, 'Unknown error');
      }
    } catch (error: any) {
      this.errorMessage = 'Error loading batches: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  openAddBatchForm() {
    this.showBatchForm = true;
    this.isEditing = false;
    this.editingBatchId = null;
    this.batchForm = {
      manufacturing_date: toLocalDateString(),
      expiry_date: '',
      quantity: 0,
      purchase_price: 0
    };
  }

  editBatch(batch: any) {
    this.showBatchForm = true;
    this.isEditing = true;
    this.editingBatchId = batch.batch_id;
    this.batchForm = {
      manufacturing_date: batch.manufacturing_date,
      expiry_date: batch.expiry_date,
      quantity: batch.quantity,
      purchase_price: batch.purchase_price || 0
    };
  }

  cancelBatchForm() {
    this.showBatchForm = false;
    this.isEditing = false;
    this.editingBatchId = null;
    this.batchForm = { manufacturing_date: '', expiry_date: '', quantity: 0, purchase_price: 0 };
  }

  async saveBatch() {
    if (!this.batchForm.manufacturing_date || !this.batchForm.expiry_date) {
      this.errorMessage = 'Manufacturing date and expiry date are required';
      return;
    }
    
    if (this.batchForm.quantity <= 0) {
      this.errorMessage = 'Quantity must be greater than 0';
      return;
    }

    if (new Date(this.batchForm.expiry_date) <= new Date(this.batchForm.manufacturing_date)) {
      this.errorMessage = 'Expiry date must be after manufacturing date';
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';

    try {
      // ONE TRANSACTION FOR THE WHOLE SAVE.
      //
      // `addBatch()` is itself TWO writes — the `product_batches` row, and the
      // 'purchase' `batch_transactions` row recording where its stock came
      // from — and it is not atomic on its own. It reports a failed stock-in
      // row rather than swallowing it, but the batch row stayed behind: an
      // orphan holding stock with no record of where it came from, on a screen
      // that had just told the user the save failed. Inventory's own
      // new-product save was already inside a transaction; this screen was the
      // one path that was not.
      //
      // The edit branch needs it for the same reason. The quantity change and
      // the 'adjustment' row that explains it are one movement, and that row
      // was not even checked: a failed adjustment left the new quantity
      // committed with nothing on the audit trail to account for it.
      await this.db.transaction(async () => {
        if (this.isEditing && this.editingBatchId) {
          const existingBatch = this.batches.find(b => b.batch_id === this.editingBatchId);
          const oldQuantity = existingBatch ? Number(existingBatch.quantity) : 0;
          const newQuantity = Number(this.batchForm.quantity);

          this.assertOk(
            await this.db.updateBatch(this.editingBatchId, {
              manufacturing_date: this.batchForm.manufacturing_date,
              expiry_date: this.batchForm.expiry_date,
              quantity: this.batchForm.quantity,
              purchase_price: this.batchForm.purchase_price
            }),
            'Failed to update batch'
          );

          if (newQuantity !== oldQuantity) {
            // Keep an audit trail for manual quantity edits, same as every
            // other place batch quantity changes.
            this.assertOk(
              await this.db.addBatchTransaction(
                this.editingBatchId,
                this.productId,
                'adjustment',
                Math.abs(newQuantity - oldQuantity),
                toLocalDateString(),
                null,
                `Manual batch edit (${newQuantity > oldQuantity ? '+' : ''}${newQuantity - oldQuantity})`
              ),
              'Failed to record the batch adjustment'
            );
          }
        } else {
          this.assertOk(
            await this.db.addBatch({
              product_id: this.productId,
              farm_id: this.farmId,
              manufacturing_date: this.batchForm.manufacturing_date,
              expiry_date: this.batchForm.expiry_date,
              quantity: this.batchForm.quantity,
              purchase_price: this.batchForm.purchase_price
            }),
            'Failed to add batch'
          );
        }
      });
    } catch (error: any) {
      // The transaction rolled back — nothing at all was written. The form
      // stays open holding what the user typed, rather than closing on a save
      // that did not happen.
      this.errorMessage = error?.message || 'Error saving batch';
      this.isLoading = false;
      return;
    }

    // Committed. A failure from here on is a screen-refresh problem, not a
    // failed save, and must not be reported as one.
    this.showBatchForm = false;
    try {
      await this.loadBatches();
    } catch (error: any) {
      console.error('The batch was saved, but refreshing the list failed:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * `db.run()`, `db.get()` and the DatabaseService helpers report failures as
   * `{ success: false }` instead of throwing, so a bad write inside a
   * transaction would otherwise pass unnoticed and be committed along with
   * everything else. Every write on the save path goes through this — the same
   * helper `sales-orders.component.ts` and `inventory.component.ts` use.
   */
  private assertOk(result: any, what: string): any {
    if (!result || !result.success) {
      throw new Error(`${what}: ${friendlySqlError(result && result.error, 'Unknown error')}`);
    }
    return result;
  }

  confirmDeleteBatch(batchId: number) {
    this.deletingBatchId = batchId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (!this.deletingBatchId) return;
    
    this.isLoading = true;
    try {
      const result = await this.db.deleteBatch(this.deletingBatchId);
      if (result.success) {
        this.showDeleteDialog = false;
        this.deletingBatchId = null;
        await this.loadBatches();
      } else {
        this.errorMessage = 'Failed to delete batch: ' + friendlySqlError(result.error, 'Unknown error');
      }
    } catch (error: any) {
      this.errorMessage = 'Error deleting batch: ' + error.message;
    } finally {
      this.isLoading = false;
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingBatchId = null;
  }

  async viewTransactions(batchId: number) {
    this.selectedBatchId = batchId;
    this.showTransactions = true;
    this.isLoading = true;
    
    try {
      const result = await this.db.getBatchTransactions(batchId);
      this.transactions = result.success && result.data ? result.data : [];
    } catch (error: any) {
      this.errorMessage = 'Error loading transactions: ' + error.message;
    } finally {
      this.isLoading = false;
    }
  }

  closeTransactions() {
    this.showTransactions = false;
    this.selectedBatchId = null;
    this.transactions = [];
  }

  getStatusClass(status: string): string {
    const statusMap: { [key: string]: string } = {
      'active': 'status-active',
      'expiring': 'status-expiring',
      'expired': 'status-expired',
      'depleted': 'status-depleted'
    };
    return statusMap[status] || 'status-active';
  }

  getStatusIcon(status: string): string {
    const iconMap: { [key: string]: string } = {
      'active': '✅',
      'expiring': '⚠️',
      'expired': '❌',
      'depleted': '⛔'
    };
    return iconMap[status] || '✅';
  }

  getStatusText(status: string): string {
    const textMap: { [key: string]: string } = {
      'active': 'Active',
      'expiring': 'Expiring Soon',
      'expired': 'Expired',
      'depleted': 'Depleted'
    };
    return textMap[status] || status;
  }

  getDaysUntilExpiry(batch: any): string {
    const days = batch.days_until_expiry;
    if (days === undefined || days === null) return 'N/A';
    if (days < 0) return 'Expired';
    if (days === 0) return 'Today';
    return `${Math.ceil(days)} days`;
  }

  // 🔥 FIXED: Use calculated_status for accurate stock
  getTotalStock(): number {
    return this.batches
      .filter(b => {
        const status = b.calculated_status || b.status || 'active';
        return (status === 'active' || status === 'expiring') && b.quantity > 0;
      })
      .reduce((sum, b) => sum + (b.quantity || 0), 0);
  }

  goBack() {
   this.router.navigate(['/app/inventory']);
  }
}