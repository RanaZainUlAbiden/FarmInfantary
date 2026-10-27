import {AfterViewInit,Component,ElementRef,EventEmitter,Input,OnDestroy,Output,ViewChild} from '@angular/core';

/** Projected forms share native modal focus containment and return focus. */
@Component({selector:'app-form-dialog',standalone:true,template:`
 <dialog #dialog [attr.aria-label]="title" [attr.aria-busy]="busy" (cancel)="cancel($event)">
  <ng-content />
 </dialog>`,styles:[`
 dialog{box-sizing:border-box;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;scrollbar-gutter:stable;border:1px solid var(--fi-border,#d5dedb);border-radius:12px;padding:24px;color:var(--fi-text,#1a1a1a);background:white;box-shadow:0 12px 48px #0003}
 dialog::backdrop{background:#142d2466}
 @media(max-width:600px){dialog{padding:16px}}
 `]})
export class FormDialogComponent implements AfterViewInit,OnDestroy {
 @Input() title='Form';@Input() busy=false;
 @Output() cancelled=new EventEmitter<void>();
 @ViewChild('dialog') dialog!:ElementRef<HTMLDialogElement>;
 private previous:HTMLElement|null=null;
 ngAfterViewInit(){this.previous=document.activeElement as HTMLElement;this.dialog.nativeElement.showModal();}
 cancel(event:Event){event.preventDefault();if(!this.busy)this.cancelled.emit();}
 ngOnDestroy(){this.dialog.nativeElement.close();if(this.previous?.isConnected)this.previous.focus();}
}
