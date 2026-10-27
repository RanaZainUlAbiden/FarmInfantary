import assert from 'node:assert/strict';
import {loadBrowserSource} from './lib/browser-source-harness.mjs';
const core={Component:()=>x=>x,HostListener:()=>()=>{},ViewEncapsulation:{None:0},ChangeDetectorRef:class{},ElementRef:class{},inject:token=>values.get(token)};
const values=new Map(),imports={'@angular/core':core,'@angular/common':{CommonModule:{}},'@angular/core/rxjs-interop':{toSignal:(_source,options)=>()=>options.initialValue},'@angular/router':{Router:class{},RouterOutlet:{},ActivatedRoute:class{}}};
const utility=loadBrowserSource('src/app/shared/utils/sidebar-order.ts',{});imports['../shared/utils/sidebar-order']=utility;
const business=loadBrowserSource('src/app/shared/utils/business-modules.ts',{});imports['../shared/utils/business-modules']=business;
for(const [path,name] of [['../shared/services/auth.service','AuthService'],['../shared/services/flock.service','FlockService'],['../shared/services/farm-unit.service','FarmUnitService'],['../shared/services/data-change.service','DataChangeService'],['../shared/utils/sql-error.util','friendlySqlError'],['../shared/services/database.service','DatabaseService'],['../shared/services/license.service','LicenseService'],['../shared/services/pending-state.service','PendingStateService'],['../admin/admin-api.service','AdminApi']]){const token=class{};imports[path]={[name]:token};values.set(token,{});}
const auth={sessionEpoch:1};values.set(imports['../shared/services/auth.service'].AuthService,auth);values.set(core.ChangeDetectorRef,{detectChanges(){}});
let calls=[],response={success:true,orders:{}},selectedRow=null,nav={scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:600})};
values.set(core.ElementRef,{nativeElement:{querySelector:selector=>selector==='.sidebar-nav'?nav:{focus(){}},contains:()=>true}});
values.set(imports['../admin/admin-api.service'].AdminApi,{request:async(method,path,body)=>{calls.push({method,path,body});return typeof response==='function'?response():response;}});
const {LayoutComponent}=loadBrowserSource('src/app/layout/layout.component.ts',imports,{window:{innerWidth:1280},document:{elementFromPoint:()=>selectedRow},requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
let passed=0;const check=async(label,work)=>{await work();passed++;console.log('  PASS  '+label);};
const keys=items=>Array.from(items,utility.sidebarItemKey);
const fresh=()=>{calls=[];response={success:true,orders:{}};auth.sessionEpoch=1;const c=new LayoutComponent();c.menuOrderReady=true;return c;};
await check('saved order restores only existing navigation, appends new entries and distinguishes Add Batch',async()=>{
 const items=[{route:'batch-management'},{route:'batch-management',queryParams:{add:1}},{route:'egg-sales'}];
 assert.deepEqual(keys(utility.orderedSidebarItems(items,['egg-sales','unknown','egg-sales','batch-management:add'])),['egg-sales','batch-management:add','batch-management']);assert.equal(utility.orderedSidebarItems(items,null).length,3);
});
await check('actual layout restores three independent module orders from the current account',async()=>{
 const c=fresh();response={success:true,orders:{broiler:['sale'],layer:['batch-management:add'],distribution:['brokers','supplier-management']}};await c.loadMenuOrder();
 assert.equal(c.broilerMenu[0].route,'sale');assert.equal(c.layerMenu[0].queryParams.add,1);assert.equal(c.distributionMenu[1].route,'supplier-management');assert.equal(c.menuOrderReady,true);
});
await check('moving a section saves its complete module order and leaves routing unchanged',async()=>{
 const c=fresh(),before=c.activeRoute,item=c.broilerMenu[1];c.moveMenuItem(item,-1);await new Promise(setImmediate);assert.equal(c.menuItems[0],item);assert.equal(c.activeRoute,before);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/account/sidebar-order/broiler');assert.deepEqual(Array.from(calls[0].body.order),keys(c.menuItems));assert.equal(c.menuOrderStatus,'Sidebar order saved.');
});
await check('keyboard arrows reorder and boundary moves do not send requests',async()=>{
 const c=fresh();c.moveMenuItem(c.menuItems[0],-1);c.moveMenuItem(c.menuItems.at(-1),1);assert.equal(calls.length,0);let prevented=false;const item=c.menuItems[1];c.menuHandleKey({key:'ArrowUp',preventDefault(){prevented=true;}},item);await new Promise(setImmediate);assert.equal(c.menuItems[0],item);assert.equal(prevented,true);
});
await check('saving disables duplicate moves and failure retains the draft for explicit retry',async()=>{
 const c=fresh();let resolve;response=()=>new Promise(done=>resolve=done);const item=c.menuItems[1];c.moveMenuItem(item,-1);c.moveMenuItem(item,1);assert.equal(calls.length,1);assert.equal(c.menuOrderSaving,true);resolve({success:false});await new Promise(setImmediate);assert.equal(c.menuItems[0],item);assert.ok(c.menuOrderError);response={success:true};await c.saveMenuOrder();assert.equal(calls.length,2);assert.equal(c.menuOrderError,'');assert.equal(c.menuOrderSaving,false);
});
await check('failed load prevents overwriting a saved order, and a user retry can restore it',async()=>{
 const c=fresh();response={success:false};await c.loadMenuOrder();c.moveMenuItem(c.menuItems[1],-1);assert.equal(calls.length,1);assert.equal(c.menuOrderReady,false);response={success:true,orders:{broiler:['feed']}};await c.loadMenuOrder();assert.equal(c.menuItems[0].route,'feed');
});
await check('late load/save results from an older identity never update the new account UI',async()=>{
 const c=fresh();let resolve;response=()=>new Promise(done=>resolve=done);const before=keys(c.menuItems),work=c.loadMenuOrder();auth.sessionEpoch++;resolve({success:true,orders:{broiler:['sale']}});await work;assert.deepEqual(keys(c.menuItems),before);
});
await check('pointer drag previews order, commits once on release and does not navigate',async()=>{
 const c=fresh(),item=c.menuItems[0],target=c.menuItems[2],active=c.activeRoute;selectedRow={dataset:{menuKey:utility.sidebarItemKey(target)},closest(){return this;}};
 c.beginMenuDrag({button:0,pointerId:1,clientX:20,clientY:40,preventDefault(){},stopPropagation(){},currentTarget:{focus(){},setPointerCapture(){}}},item);
 c.moveMenuDrag({pointerId:1,clientX:20,clientY:130,preventDefault(){}});assert.equal(c.menuItems[2],item);assert.equal(calls.length,0);c.endMenuDrag({pointerId:1});await new Promise(setImmediate);assert.equal(calls.length,1);assert.equal(c.activeRoute,active);
});
await check('cancelling an active drag restores the original order without writing',async()=>{
 const c=fresh(),before=keys(c.menuItems);selectedRow={dataset:{menuKey:utility.sidebarItemKey(c.menuItems[3])},closest(){return this;}};c.beginMenuDrag({button:0,pointerId:1,clientX:20,clientY:40,preventDefault(){},stopPropagation(){},currentTarget:{focus(){},setPointerCapture(){}}},c.menuItems[0]);c.moveMenuDrag({pointerId:1,clientX:20,clientY:160,preventDefault(){}});c.cancelMenuDrag();assert.deepEqual(keys(c.menuItems),before);assert.equal(calls.length,0);
});
await check('only three module bundles are offered and each always includes Distribution and account Overview',async()=>{
 assert.deepEqual(Array.from(business.BUSINESS_BUNDLES,b=>b.value),['broiler_distribution','layer_distribution','all']);
 for(const bundle of business.BUSINESS_BUNDLES){assert.ok(business.businessTabs(bundle.value).includes('distribution'));assert.ok(business.businessTabs(bundle.value).includes('overview'));}
});
await check('paired bundles show the correct core menu, hide the other core module and cannot switch to it',async()=>{
 for(const [bundle,enabled,excluded] of [['broiler_distribution','broiler','layer'],['layer_distribution','layer','broiler']]){
  const c=fresh();c.savedBusinessType=bundle;c.activeBusinessTab=excluded;assert.equal(c.menuModule,enabled);assert.equal(c.hasBusinessTab(excluded),false);assert.equal(c.hasBusinessTab('distribution'),true);
  await c.switchBusinessTab(excluded);assert.equal(calls.length,0);c.activeBusinessTab='distribution';assert.equal(c.isDistributionMode,true);
 }
});
await check('legacy saved modes open their matching combinations without changing stored farm data',async()=>{
 assert.equal(business.businessBundle('broiler'),'broiler_distribution');assert.equal(business.businessBundle('layer'),'layer_distribution');assert.equal(business.businessBundle('distribution'),'all');
 assert.equal(business.activeBusinessModule('layer_distribution','broiler'),'layer');assert.equal(business.activeBusinessModule('all','layer'),'layer');
});
console.log('ALL CHECKS PASSED — '+passed+' actual sidebar source scenarios');
