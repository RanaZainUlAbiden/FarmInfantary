import {Component,EventEmitter,Input,Output,ViewChild,ElementRef,AfterViewInit,OnDestroy,ChangeDetectorRef} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {DeleteAuthService} from '../../services/delete-auth.service';
import {PasswordFieldComponent} from '../password-field/password-field.component';
@Component({selector:'app-delete-code-dialog',standalone:true,imports:[CommonModule,FormsModule,PasswordFieldComponent],templateUrl:'./delete-code-dialog.component.html',styleUrl:'./delete-code-dialog.component.scss'})
export class DeleteCodeDialogComponent implements AfterViewInit,OnDestroy {
 @Input() correction=false;
 @Output() verified=new EventEmitter<void>();@Output() cancelled=new EventEmitter<void>();
 @ViewChild('dialog') dialog?:ElementRef<HTMLDialogElement>;@ViewChild(PasswordFieldComponent) input?:PasswordFieldComponent;
 code='';error='';isVerifying=false;private destroyed=false;private previous:HTMLElement|null=null;private previousOverflow='';
 constructor(private deleteAuth:DeleteAuthService,private cdr:ChangeDetectorRef){}
 ngAfterViewInit(){this.previous=document.activeElement as HTMLElement;this.previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';this.dialog?.nativeElement.showModal();this.input?.focus();}
 ngOnDestroy(){this.destroyed=true;this.code='';this.dialog?.nativeElement.close();document.body.style.overflow=this.previousOverflow;if(this.previous?.isConnected)this.previous.focus();}
 private render(){if(!this.destroyed)this.cdr.detectChanges();}
 async submit(){if(!this.code.trim()||this.isVerifying)return;this.isVerifying=true;this.error='';this.render();
  const ok=await this.deleteAuth.verifyCode(this.code);this.code='';this.isVerifying=false;
  if(this.destroyed)return;if(ok)this.verified.emit();else{this.error=this.deleteAuth.message||'Incorrect delete code.';this.render();this.input?.focus();}}
 cancel(){this.code='';this.cancelled.emit();}
 setCode(value:string){this.code=value;this.render();}
 trapTab(event:KeyboardEvent){if(event.key!=='Tab')return;const controls=Array.from(this.dialog!.nativeElement.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')).filter(e=>e.getClientRects().length>0);
  const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
 onEnter(event:Event){if((event as KeyboardEvent).isComposing)event.preventDefault();}
}
