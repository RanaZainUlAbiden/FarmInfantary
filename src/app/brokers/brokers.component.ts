import {Component,Input,OnChanges,OnInit,OnDestroy,ChangeDetectorRef,ElementRef} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {ActivatedRoute,Router} from '@angular/router';
import {Subscription} from 'rxjs';
import {AdminApi} from '../admin/admin-api.service';
import {DatabaseService} from '../shared/services/database.service';
import {AuthService} from '../shared/services/auth.service';
import {BankPickerComponent} from '../shared/components/bank-picker/bank-picker.component';
import {DeleteCodeDialogComponent} from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import {ConfirmDialogComponent} from '../shared/components/confirm-dialog/confirm-dialog.component';
import {FormDialogComponent} from '../shared/components/form-dialog/form-dialog.component';
import {toLocalDateString} from '../shared/utils/date.util';
@Component({selector:'app-brokers',standalone:true,imports:[CommonModule,FormsModule,BankPickerComponent,DeleteCodeDialogComponent,ConfirmDialogComponent,FormDialogComponent],templateUrl:'./brokers.component.html',styleUrl:'./brokers.component.scss'})
export class BrokersComponent implements OnInit,OnChanges,OnDestroy {
 @Input() flock:any=null;
 @Input() flockMode=false;
 busy=false;loading=false;error='';message='';search='';brokers:any[]=[];more=false;offset=0;
 selected:any=null;summary:any={total:0,paid:0,pending:0};sales:any[]=[];payments:any[]=[];detailOffset=0;detailMore=false;
 listSummary:any={total:0,paid:0,pending:0};breakdown:any[]=[];moreBreakdown=false;
 editing=false;newBroker=false;brokerForm:any={name:'',phone:'',notes:'',active:true};banks:any[]=[];
 saleForm:any=this.blankSale();paymentForm:any=null;showSale=false;deleteCode=false;confirm=false;
 private pendingDelete:any=null;private timer:any;private generation=0;private destroyed=false;private sub=new Subscription();
 private started=false;
 parties:any[]=[];partySearch='';partyMore=false;partyLoading=false;partyError='';customerBanks:any[]=[];
 private partyOffset=0;private partyEpoch=0;private partyTimer:any;
 get correctionTitle(){return this.pendingDelete?.kind==='payment'?'Reverse payment #'+this.pendingDelete.row.payment_id:'Delete unpaid sale #'+this.pendingDelete?.row.sale_id;}
 get correctionMessage(){return this.pendingDelete?.kind==='payment'?'Reverse the entire receipt of Rs. '+(this.pendingDelete.row.collection_amount??this.pendingDelete.row.amount)+'? Every sale allocation and destination entry for this receipt will be reversed, including other flocks. The amount will become outstanding again and the reversed receipt stays in the ledger.':'Remove this unpaid sale from the flock’s sales and income total?';}
 get correctionAction(){return this.pendingDelete?.kind==='payment'?'Reverse payment':'Delete unpaid sale';}
 constructor(private api:AdminApi,private db:DatabaseService,private auth:AuthService,private route:ActivatedRoute,private router:Router,private cdr:ChangeDetectorRef,private host:ElementRef<HTMLElement>){}
 blankPayment(){return {amount:0,date:toLocalDateString(),method:'cash',bank_id:null,payment_source:'cash',reference:'',note:'',requestId:crypto.randomUUID()};}
 paymentPayload(p:any){return {amount:p.amount,date:p.date,method:p.method,bankId:p.method==='bank'?p.bank_id:null,reference:p.reference,note:p.note};}
 blankSale(){return {date:toLocalDateString(),vehicle:'',driver:'',phone:'',emptyWeight:null,loadWeight:null,rate:null,payment:this.blankPayment(),requestId:crypto.randomUUID()};}
 get saleTotal(){return Math.round(Math.max(0,Number(this.saleForm.loadWeight)-Number(this.saleForm.emptyWeight))*Number(this.saleForm.rate||0)*100)/100;}
 get salePending(){return Math.max(0,this.saleTotal-Number(this.saleForm.payment.amount||0));}
 get context(){return this.flockMode?this.flock?.flock_name:'All broiler flocks';}
 ngOnInit(){this.started=true;this.sub.add(this.route.queryParamMap.subscribe(params=>{this.search=params.get('brokerSearch')??'';const bid=Number(params.get('brokerId'));if(bid)this.open(bid);else{this.selected=null;this.loadList();}}));
  this.db.getHouseBankAccounts(this.auth.getCurrentFarm()?.farm_id).then(r=>{if(!this.destroyed){this.banks=r.success?r.data:[];this.render();}});
 }
 ngOnChanges(){this.saleForm=this.blankSale();this.paymentForm=null;this.showSale=false;if(this.selected)this.open(this.selected.broker_id);else if(this.started)this.loadList();}
 ngOnDestroy(){this.destroyed=true;this.generation++;this.partyEpoch++;clearTimeout(this.timer);clearTimeout(this.partyTimer);this.sub.unsubscribe();}
 render(){if(!this.destroyed)this.cdr.detectChanges();}
 private async read(path:string){const r=await this.api.request('GET',path);if(!r.success)throw new Error(r.error);return r;}
 private async write(method:string,path:string,b?:any){const r=await this.api.request(method,path,b);if(!r.success)throw new Error(r.error);return r;}
 async task(fn:()=>Promise<void>,message=''){if(this.busy)return;this.busy=true;this.error='';this.message='';this.render();try{await fn();this.message=message;}catch(e:any){this.error=e.message;this.focus(this.paymentForm?'broker-payment-error':'broker-error');}finally{this.busy=false;this.render();}}
 focus(id:string){setTimeout(()=>this.host.nativeElement.querySelector<HTMLElement>('#'+id)?.focus());}
 searchChanged(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.router.navigate([],{relativeTo:this.route,queryParams:{brokerSearch:this.search||null,brokerId:null},queryParamsHandling:'merge',replaceUrl:true}),300);}
 async loadList(more=false){const epoch=++this.generation;if(this.flockMode&&!this.flock){this.brokers=[];this.listSummary={total:0,paid:0,pending:0};this.more=false;this.loading=false;this.render();return;}this.loading=true;this.error='';this.render();try{const offset=more?this.offset+30:0,r=await this.read('/api/brokers?search='+encodeURIComponent(this.search)+'&offset='+offset+(this.flockMode?'&flockId='+this.flock.flock_id:''));if(epoch!==this.generation||this.destroyed)return;this.offset=offset;this.brokers=more?[...this.brokers,...r.brokers]:r.brokers;this.more=r.more;this.listSummary=r.summary;}catch(e:any){if(epoch===this.generation)this.error=e.message;}finally{if(epoch===this.generation){this.loading=false;this.render();}}}
 select(b:any){clearTimeout(this.timer);if(!this.busy)this.router.navigate([],{relativeTo:this.route,queryParams:{brokerId:b.broker_id,brokerSearch:this.search||null},queryParamsHandling:'merge'});}
 back(){if(this.busy)return;this.showSale=false;this.paymentForm=null;this.editing=false;this.router.navigate([],{relativeTo:this.route,queryParams:{brokerId:null},queryParamsHandling:'merge'});}
 async open(id:number,more=false){const epoch=++this.generation;if(this.selected?.broker_id!==id){this.selected=null;this.showSale=false;this.paymentForm=null;this.editing=false;}this.loading=true;this.error='';this.render();try{
  if(this.flockMode&&!this.flock){this.selected=null;return;}
  const offset=more?this.detailOffset+30:0,r=await this.read('/api/brokers/'+id+'?offset='+offset+(this.flockMode?'&flockId='+this.flock.flock_id:''));if(epoch!==this.generation||this.destroyed)return;
  this.selected=r.broker;this.summary=r.summary;this.breakdown=more?[...this.breakdown,...r.breakdown]:r.breakdown;this.moreBreakdown=r.moreBreakdown;this.detailOffset=offset;this.sales=more?[...this.sales,...r.sales]:r.sales;this.payments=more?[...this.payments,...r.payments]:r.payments;this.detailMore=r.moreSales||r.morePayments||r.moreBreakdown;
 }catch(e:any){if(epoch===this.generation)this.error=e.message;}finally{if(epoch===this.generation){this.loading=false;this.render();}}}
 editBroker(create=false){this.newBroker=create;this.editing=true;this.brokerForm=create?{name:'',phone:'',notes:'',active:true}:{name:this.selected.broker_name,phone:this.selected.phone,notes:this.selected.notes,active:this.selected.is_active===1};this.focus('broker-name');}
 async saveBroker(){if(!this.brokerForm.name.trim()){this.error='Enter the broker name.';this.focus('broker-name');return;}
  await this.task(async()=>{const payload=this.newBroker?{name:this.brokerForm.name,phone:this.brokerForm.phone,notes:this.brokerForm.notes}:{...this.brokerForm,version:this.selected.version};const r=await this.write(this.newBroker?'POST':'PUT',this.newBroker?'/api/brokers':'/api/brokers/'+this.selected.broker_id,payload);this.editing=false;if(this.newBroker)await this.router.navigate([],{relativeTo:this.route,queryParams:{brokerId:r.broker.broker_id},queryParamsHandling:'merge'});else await this.open(r.broker.broker_id);},'Broker saved.');
 }
 addSale(){if(!this.flock||this.busy)return;this.saleForm=this.blankSale();this.showSale=true;this.paymentForm=null;this.focus('broker-sale-date');}
 paidInFull(){this.saleForm.payment.amount=this.saleTotal;}
 async saveSale(){if(!this.flock||!this.selected)return;const s=this.saleForm;
  if(!s.date||!Number.isFinite(s.emptyWeight)||!Number.isFinite(s.loadWeight)||!Number.isFinite(s.rate)||s.emptyWeight<0||s.loadWeight<=s.emptyWeight||s.rate<=0||s.payment.amount<0||s.payment.amount>this.saleTotal){this.error='Enter a valid date, weights and rate. Amount received must be between zero and the sale total.';this.focus('broker-sale-date');return;}
  await this.task(async()=>{await this.write('POST','/api/brokers/'+this.selected.broker_id+'/sales',{...s,payment:this.paymentPayload(s.payment),flockId:this.flock.flock_id});this.showSale=false;this.saleForm=this.blankSale();await this.open(this.selected.broker_id);},'Sale and payment saved.');
 }
 receive(s?:any){if(this.busy||this.loading)return;const remaining=s?s.total_amount-s.amount_paid:this.summary.pending;this.paymentForm={...this.blankPayment(),destination:'',partyId:null,saleId:s?.sale_id??null,remaining,amount:remaining};this.error='';this.showSale=false;this.destinationChanged();this.focus('broker-payment-destination');}
 compositionEnter(event:Event){if((event as KeyboardEvent).isComposing)event.preventDefault();}
 closePayment(){if(this.busy)return;this.partyEpoch++;clearTimeout(this.partyTimer);this.paymentForm=null;this.error='';}
 destinationChanged(){this.partyEpoch++;clearTimeout(this.partyTimer);this.parties=[];this.customerBanks=[];this.partySearch='';this.partyMore=false;this.partyError='';this.partyLoading=false;const p=this.paymentForm;if(!p)return;p.partyId=null;p.bank_id=null;p.method=p.destination==='supplier'?'other':p.destination==='customer'?'bank':'cash';p.payment_source=p.method;if(['supplier','customer'].includes(p.destination))this.loadParties();}
 partySearchChanged(){clearTimeout(this.partyTimer);this.partyEpoch++;this.partyTimer=setTimeout(()=>this.loadParties(),300);}
 async loadParties(more=false){if(!this.paymentForm)return;const epoch=++this.partyEpoch,p=this.paymentForm,offset=more?this.partyOffset+30:0;this.partyLoading=true;this.partyError='';this.render();try{const r=await this.read('/api/brokers/'+this.selected.broker_id+'/payment-options?type='+p.destination+'&search='+encodeURIComponent(this.partySearch)+'&offset='+offset+(p.destination==='customer'&&p.partyId?'&customerId='+p.partyId:''));if(epoch!==this.partyEpoch||p!==this.paymentForm||this.destroyed)return;this.partyOffset=offset;this.parties=more?[...this.parties,...r.parties]:r.parties;this.partyMore=r.more;this.customerBanks=r.banks;}catch(e:any){if(epoch===this.partyEpoch)this.partyError=e.message;}finally{if(epoch===this.partyEpoch){this.partyLoading=false;this.render();}}}
 chooseParty(p:any){if(this.busy)return;this.paymentForm.partyId=p.id;this.paymentForm.partyName=p.name;this.paymentForm.supplierOutstanding=p.outstanding;this.paymentForm.bank_id=null;this.customerBanks=[];if(this.paymentForm.destination==='customer')this.loadParties();}
 async savePayment(){const p=this.paymentForm;if(!p)return;const payload={...this.paymentPayload(p),requestId:p.requestId,destination:p.destination,supplierId:p.destination==='supplier'?p.partyId:null,customerId:p.destination==='customer'?p.partyId:null,...(p.saleId?{saleId:p.saleId}:{}),...(this.flockMode?{flockId:this.flock?.flock_id}:{})};if(!p.destination||(['supplier','customer'].includes(p.destination)&&!p.partyId)||(p.method==='bank'&&!p.bank_id)||!(payload.amount>0)||payload.amount>p.remaining||(p.destination==='supplier'&&p.amount>p.supplierOutstanding)){this.error='Choose the destination and account, then enter a positive amount within the outstanding balances.';this.focus('broker-payment-error');return;}
  await this.task(async()=>{await this.write('POST','/api/brokers/'+this.selected.broker_id+'/collections',payload);this.paymentForm=null;this.partyEpoch++;await this.open(this.selected.broker_id);},'Payment saved. Broker and destination balances updated.');
 }
 requestDelete(kind:string,row:any){this.pendingDelete={kind,row};this.deleteCode=true;}
 verified(){this.deleteCode=false;this.confirm=true;}
 cancelDelete(){this.deleteCode=false;this.confirm=false;this.pendingDelete=null;}
 async doDelete(){const p=this.pendingDelete;if(!p)return;this.confirm=false;await this.task(async()=>{const base='/api/brokers/'+this.selected.broker_id;await this.write(p.kind==='payment'?'POST':'DELETE',p.kind==='payment'?base+'/payments/'+p.row.payment_id+'/reverse':base+'/sales/'+p.row.sale_id,p.kind==='payment'?{}:undefined);this.pendingDelete=null;await this.open(this.selected.broker_id);},p.kind==='payment'?'Payment reversed. Outstanding balance restored.':'Unpaid sale deleted.');}
}
