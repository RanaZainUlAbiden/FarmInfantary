import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-pagination',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="pagination-controls" *ngIf="totalPages > 1">
      <button class="btn-pagination" [disabled]="currentPage === 1" (click)="onPageChange(currentPage - 1)">Previous</button>
      <span class="page-info">Page {{ currentPage }} of {{ totalPages }}</span>
      <button class="btn-pagination" [disabled]="currentPage === totalPages" (click)="onPageChange(currentPage + 1)">Next</button>
    </div>
  `,
  styles: [`
    .pagination-controls {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
    }
    .btn-pagination {
      padding: 0.5rem 1rem;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      background: white;
      cursor: pointer;
      color: #334155;
      font-weight: 500;
      transition: all 0.2s;
    }
    .btn-pagination:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-pagination:not(:disabled):hover {
      background: #f1f5f9;
    }
    .page-info {
      font-size: 0.9rem;
      color: #64748b;
    }
  `]
})
export class PaginationComponent {
  @Input() currentPage: number = 1;
  @Input() totalItems: number = 0;
  @Input() pageSize: number = 10;
  @Output() pageChange = new EventEmitter<number>();

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalItems / this.pageSize));
  }

  onPageChange(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.pageChange.emit(page);
    }
  }
}
