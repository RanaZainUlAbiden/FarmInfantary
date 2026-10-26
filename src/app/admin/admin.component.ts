import {Component,OnInit,OnDestroy,ChangeDetectorRef,ElementRef} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {AuthService} from '../shared/services/auth.service';
import {PasswordFieldComponent} from '../shared/components/password-field/password-field.component';
import {AdminApi} from './admin-api.service';
@Component({selector:'app-admin',standalone:true,imports:[CommonModule,FormsModule,PasswordFieldComponent],templateUrl:'./admin.component.html',styleUrl:'./admin.component.scss'})
export class AdminComponent implements OnInit,OnDestroy {
 root=false;busy=false;error='';message='';view='farms';farms:any[]=[];users:any[]=[];events:any[]=[];catalogue:any[]=[];
 selected:any=null;draft:any={};selectedUser:any=null;grants:any[]=[];pendingStatus='active';invalid=new Set<string>();
 newFarm=false;farmName='';businessType='broiler';ownerName='';ownerPassword='';staffName='';staffPassword='';replacementPassword='';
 farmMore=false;userMore=false;auditMore=false;private destroyed=false;
 currentPassword='';newDeleteCode='';deleteConfigured=false;
 constructor(public auth:AuthService,private api:AdminApi,private cdr:ChangeDetectorRef,private host:ElementRef<HTMLElement>){}
 ngOnDestroy(){this.destroyed=true;this.ownerPassword=this.staffPassword=this.replacementPassword=this.currentPassword=this.newDeleteCode='';}
 render(){if(!this.destroyed)this.cdr.detectChanges();}
 async ngOnInit(){this.root=this.auth.getCurrentUser()?.role==='super_admin';await this.refresh();}
 private async read(path:string){const r=await this.api.request('GET',path);if(!r.success)throw new Error(r.error);return r;}
 async task(work:()=>Promise<void>,success='') {
  if(this.busy)return;this.busy=true;this.error='';this.message='';this.render();
  try{await work();this.message=success;}catch(e:any){this.error=e.message||'Could not complete the request.';}
  finally{this.busy=false;this.render();}
 }
 private async mutation(method:string,path:string,body:unknown){const r=await this.api.request(method,path,body);if(!r.success)throw new Error(r.error);return r;}
 async refresh(){await this.task(async()=>{
  this.selectedUser=null;
  if(this.root){this.farms=(await this.read('/api/admin/farms')).farms;this.farmMore=this.farms.length===50;this.catalogue=(await this.read('/api/admin/permissions')).permissions;
   if(this.selected)await this.loadFarm((await this.read('/api/admin/farms/'+this.selected.farm_id)).farm);
  }else{const r=await this.read('/api/account/staff');this.selected=r.farm;this.users=r.users;this.userMore=r.users.length===50;this.deleteConfigured=(await this.read('/api/account/delete-code')).configured;}
 });}
 async tab(value:string){if(this.busy)return;this.view=value;this.render();if(value==='audit')await this.task(async()=>{this.events=(await this.read('/api/admin/audit')).events;this.auditMore=this.events.length===50;});}
 private async loadFarm(f:any){this.selected={...f};this.draft={farmName:f.farm_name,businessType:f.business_type,status:f.status,seatLimit:f.staff_seat_limit,allowStaffCreation:f.can_admin_add_staff===1,expectedVersion:f.admin_version};
  this.selectedUser=null;this.users=(await this.read(`/api/admin/farms/${f.farm_id}/users`)).users;this.userMore=this.users.length===50;}
 async selectFarm(f:any){await this.task(()=>this.loadFarm(f));this.focus('farm-editor-title');}
 focus(id:string){this.render();this.host.nativeElement.querySelector<HTMLElement>('#'+id)?.focus();}
 showCreate(){this.newFarm=!this.newFarm;this.invalid.clear();this.render();if(this.newFarm)this.focus('new-farm-name');}
 private validate(checks:Array<[string,boolean,string]>):boolean {
  this.invalid=new Set(checks.filter(([,valid])=>!valid).map(([id])=>id));const first=checks.find(([,valid])=>!valid);
  if(first){this.error=first[2];this.focus(first[0]);return false;}return true;
 }
 private validName(value:string){return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value.trim());}
 private validPassword(value:string){return [...value].length>=15&&[...value].length<=128;}
 async createFarm(){if(!this.validate([['new-farm-name',!!this.farmName.trim()&&this.farmName.trim().length<=100,'Enter a farm name of 1 to 100 characters.'],['new-owner-name',this.validName(this.ownerName),'Enter a username of 3 to 64 letters, numbers, dots, underscores or hyphens.'],['new-owner-password',this.validPassword(this.ownerPassword),'Use a password of 15 to 128 characters.']]))return;
  await this.task(async()=>{try{const r=await this.mutation('POST','/api/admin/farms',{farmName:this.farmName,businessType:this.businessType,username:this.ownerName,password:this.ownerPassword});this.farms=(await this.read('/api/admin/farms')).farms;this.farmMore=this.farms.length===50;await this.loadFarm(this.farms.find(f=>f.farm_id===r.farmId));this.newFarm=false;this.farmName=this.ownerName='';}finally{this.ownerPassword='';}},'Farm and administrator created.');
  if(!this.error)this.focus('farm-editor-title');
 }
 async saveFarm(){if(!this.validate([['farm-name',!!this.draft.farmName?.trim()&&this.draft.farmName.trim().length<=100,'Enter a farm name.'],['seat-limit',Number.isSafeInteger(this.draft.seatLimit)&&this.draft.seatLimit>=0,'Enter a whole staff seat limit of zero or more.']]))return;
  await this.task(async()=>{await this.mutation('PUT',`/api/admin/farms/${this.selected.farm_id}`,this.draft);const f=(await this.read('/api/admin/farms/'+this.selected.farm_id)).farm;this.farms=this.farms.map(x=>x.farm_id===f.farm_id?f:x);await this.loadFarm(f);},'Farm settings saved.');}
 async createStaff(){if(!this.validate([['new-staff-name',this.validName(this.staffName),'Enter a valid staff username.'],['new-staff-password',this.validPassword(this.staffPassword),'Use a staff password of 15 to 128 characters.']]))return;
  await this.task(async()=>{try{await this.mutation('POST',this.root?`/api/admin/farms/${this.selected.farm_id}/staff`:'/api/account/staff',{username:this.staffName,password:this.staffPassword});this.staffName='';await this.reloadUsers();}finally{this.staffPassword='';}},'Staff account created.');}
 private async reloadUsers(){this.selectedUser=null;if(this.root){const f=(await this.read('/api/admin/farms/'+this.selected.farm_id)).farm;this.farms=this.farms.map(x=>x.farm_id===f.farm_id?f:x);await this.loadFarm(f);}
  else{const r=await this.read('/api/account/staff');this.selected=r.farm;this.users=r.users;this.userMore=r.users.length===50;}}
 async selectUser(u:any){await this.task(async()=>{this.selectedUser={...u};this.pendingStatus=u.status;this.replacementPassword='';
  if(u.role==='staff'){const r=await this.read(`/api/admin/users/${u.user_id}/permissions`);this.selectedUser=r.user;this.pendingStatus=r.user.status;this.grants=this.catalogue.map(c=>{const g=r.grants.find((x:any)=>x.permission_key===c.permission_key);return {...c,view:g?.can_view===1,create:g?.can_create===1,edit:g?.can_edit===1,delete:g?.can_delete===1};});}
 });this.focus('user-editor-title');}
 toggleGrant(g:any,flag:string,event:Event){g[flag]=(event.target as HTMLInputElement).checked;if(flag==='view'&&!g.view)g.create=g.edit=g.delete=false;if(flag!=='view'&&g[flag])g.view=true;this.render();}
 async savePermissions(){await this.task(async()=>{await this.mutation('PUT',`/api/admin/users/${this.selectedUser.user_id}/permissions`,{expectedVersion:this.selectedUser.auth_version,grants:this.grants.map(g=>({key:g.permission_key,view:g.view,create:g.create,edit:g.edit,delete:g.delete}))});await this.reloadUsers();},'Permissions saved. Changed permissions sign the staff user out.');}
 async saveStatus(){await this.task(async()=>{await this.mutation('PUT',`/api/admin/users/${this.selectedUser.user_id}/status`,{expectedVersion:this.selectedUser.auth_version,status:this.pendingStatus});await this.reloadUsers();},'User status saved.');}
 async resetPassword(){if(!this.validate([['replacement-password',this.validPassword(this.replacementPassword),'Use a new password of 15 to 128 characters.']]))return;
  await this.task(async()=>{try{await this.mutation('POST',`/api/admin/users/${this.selectedUser.user_id}/password`,{expectedVersion:this.selectedUser.auth_version,password:this.replacementPassword});await this.reloadUsers();}finally{this.replacementPassword='';}},'Password changed. Existing sessions have ended.');}
 async more(kind:string){await this.task(async()=>{
  if(kind==='farms'){const r=await this.read('/api/admin/farms?before='+this.farms.at(-1).farm_id);this.farms.push(...r.farms);this.farmMore=r.farms.length===50;}
  if(kind==='users'){const r=await this.read((this.root?`/api/admin/farms/${this.selected.farm_id}/users`:'/api/account/staff')+'?before='+this.users.at(-1).user_id);this.users.push(...r.users);this.userMore=r.users.length===50;}
  if(kind==='audit'){const r=await this.read('/api/admin/audit?before='+this.events.at(-1).event_id);this.events.push(...r.events);this.auditMore=r.events.length===50;}
 });}
 async logout(){await this.auth.logout();}
 async configureDeleteCode(){if(!this.validate([['security-password',!!this.currentPassword,'Enter your current account password.'],['security-delete-code',[...this.newDeleteCode].length>=8&&[...this.newDeleteCode].length<=128,'Use a delete code of 8 to 128 characters.']]))return;
  await this.task(async()=>{try{await this.mutation('PUT','/api/account/delete-code',{currentPassword:this.currentPassword,newCode:this.newDeleteCode});this.deleteConfigured=true;}finally{this.currentPassword=this.newDeleteCode='';}},'Delete code saved. Previous delete confirmations have expired.');}
 onEnter(event:Event){if((event as KeyboardEvent).isComposing)event.preventDefault();}
}
