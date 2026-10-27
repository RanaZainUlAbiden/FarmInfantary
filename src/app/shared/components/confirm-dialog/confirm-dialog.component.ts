import { Component, EventEmitter, Input, Output, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss'
})
export class ConfirmDialogComponent implements AfterViewInit,OnDestroy {
  @Input() modal=false;
  @ViewChild('dialog') dialog?:ElementRef<HTMLDialogElement>;
  private previous:HTMLElement|null=null;
  ngAfterViewInit(){if(this.modal){this.previous=document.activeElement as HTMLElement;this.dialog?.nativeElement.showModal();this.dialog?.nativeElement.querySelector<HTMLElement>('.btn-cancel')?.focus();}}
  ngOnDestroy(){if(this.modal){this.dialog?.nativeElement.close();if(this.previous?.isConnected)this.previous.focus();}}
  @Input() title: string = 'Confirm';
  @Input() message: string = 'Are you sure?';
  @Input() confirmText: string = 'Confirm';
  @Input() cancelText: string = 'Cancel';
  @Input() hideCancel: boolean = false;
  @Input() type: 'danger' | 'warning' | 'success' = 'danger';
  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();
}
