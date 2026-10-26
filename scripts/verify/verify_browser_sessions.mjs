import assert from 'node:assert/strict';
import {loadBrowserSource,MemoryStorage,rx} from './lib/browser-source-harness.mjs';
let passed=0;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const user=(id=1,farm=1,role='farm_admin',type='all')=>({userId:id,username:'owner.'+id,role,farmId:role==='super_admin'?null:farm,
 farm:role==='super_admin'?null:{farm_id:farm,farm_name:'Farm '+farm,business_type:type}});
function fixture() {
 const localStorage=new MemoryStorage(),sessionStorage=new MemoryStorage(),events={};
 const calls=[],requests=[],resets={flocks:0,units:0,pending:0,platform:0};
 const http=Object.fromEntries(['get','post','patch','put'].map(method=>[method,(url,body)=>{const result=new rx.Subject();requests.push({method,url,body,result});return result;} ]));
 const router={url:'/login',navigate:async(path,options)=>{calls.push({path,options});router.url=path.join('/');return true;},
   createUrlTree:(path,options)=>({path,options})};
 const core={Injectable:()=>target=>target};
 const module=loadBrowserSource('src/app/shared/services/auth.service.ts',{'@angular/core':core},{localStorage,sessionStorage,window:{addEventListener:(key,fn)=>{events[key]=fn;}}});
 const auth=new module.AuthService(http,router,{reset(){resets.flocks++;}},{reset(){resets.units++;}},
  {clearAll(){resets.pending++;for(const k of [...sessionStorage.values.keys()])if(k.startsWith('pending_state_'))sessionStorage.removeItem(k);}},
  {resetSession(){resets.platform++;}});
 const flush=(request,data)=>{request.result.next(data);request.result.complete();};
 const fail=(request,status)=>request.result.error({status});
 return {auth,http,router,localStorage,sessionStorage,events,calls,requests,resets,flush,fail,module};
}
async function signedIn(f,u=user()) {const promise=f.auth.initialize(true);f.flush(f.requests.at(-1),{success:true,user:u});await promise;return f;}

await check('server restoration is deduplicated and no local identity can authenticate',async()=>{
 const f=fixture();f.localStorage.setItem('currentFarm','{broken');f.sessionStorage.setItem('fi_ui_owner','1:1:farm_admin');
 assert.equal(f.auth.isLoggedIn(),false);const a=f.auth.initialize(),b=f.auth.initialize();assert.equal(f.requests.length,1);
 f.fail(f.requests[0],401);await Promise.all([a,b]);assert.equal(f.auth.getCurrentFarm(),null);assert.equal(f.auth.isLoggedIn(),false);
});
await check('cookie restoration adopts only validated server identity without persisting it',async()=>{
 const f=await signedIn(fixture());assert.equal(f.auth.getCurrentFarm().farm_id,1);assert.equal(f.localStorage.getItem('currentFarm'),null);
 assert.equal(f.localStorage.getItem('businessType'),null);const copy=f.auth.getCurrentFarm();copy.farm_id=2;assert.equal(f.auth.getCurrentFarm().farm_id,1);
 assert.equal(f.auth.canUseBusinessApp(),true);
});
await check('malformed server actors and mismatched farms fail closed',async()=>{
 for(const bad of [{...user(),farmId:2},{...user(),role:'invented'}, {...user(),userId:0}, {...user(),farm:{...user().farm,business_type:'unknown'}}]) {
  const f=fixture();const p=f.auth.initialize();f.flush(f.requests[0],{success:true,user:bad});await p;assert.equal(f.auth.isLoggedIn(),false);
 }
});
await check('login preserves password bytes, prevents duplicates and stores no credential',async()=>{
 const f=fixture(),secret='  test password unchanged  ';const first=f.auth.login('  Owner.One  ',secret);
 assert.equal(await f.auth.login('other','secret'),false);assert.equal(f.requests.length,1);
 assert.equal(f.requests[0].url,'/api/auth/login');assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].body)),{username:'Owner.One',password:secret});
 f.flush(f.requests[0],{success:true,user:user()});assert.equal(await first,true);
 assert.ok(!JSON.stringify([...f.localStorage.values,...f.sessionStorage.values]).includes(secret));
});
await check('credential, throttling and network failures stay distinguishable without leaking details',async()=>{
 for(const [status,part]of[[401,'Invalid username'],[429,'Too many'],[0,'connection']]) {
  const f=fixture(),p=f.auth.login('owner','password');f.fail(f.requests[0],status);assert.equal(await p,false);assert.ok(f.auth.message.includes(part));assert.equal(f.auth.isLoggedIn(),false);
 }
});
await check('a stale restore response cannot replace a newer successful login',async()=>{
 const f=fixture(),restore=f.auth.initialize(),login=f.auth.login('owner','password');
 f.flush(f.requests[1],{success:true,user:user()});await login;f.flush(f.requests[0],{success:true,user:user(2,2)});await restore;
 assert.equal(f.auth.getCurrentUser().userId,1);
});
await check('account changes clear selections, pending drafts and transaction state',async()=>{
 const f=fixture();f.localStorage.setItem('lastLayerBatchId','9');f.localStorage.setItem('currentFlock','{"farm_id":2}');
 f.sessionStorage.setItem('fi_ui_owner','2:2:farm_admin');f.sessionStorage.setItem('pending_state_money','private draft');await signedIn(f);
 assert.equal(f.localStorage.getItem('currentFlock'),null);assert.equal(f.localStorage.getItem('lastLayerBatchId'),null);assert.equal(f.sessionStorage.getItem('pending_state_money'),null);
 assert.ok(Object.values(f.resets).every(v=>v>0));
});
await check('same-server-user reload can preserve UI preferences without trusting them for identity',async()=>{
 const f=fixture();f.sessionStorage.setItem('fi_ui_owner','1:1:farm_admin');f.localStorage.setItem('lastLayerBatchId','9');await signedIn(f);
 assert.equal(f.localStorage.getItem('lastLayerBatchId'),'9');assert.equal(f.auth.getCurrentUser().userId,1);
});
await check('offline sign-out stays pending and prevents automatic session restoration or a racing login',async()=>{
 const f=await signedIn(fixture());f.router.url='/app/inventory';const p=f.auth.logout();assert.equal(f.auth.isLoggedIn(),false);assert.equal(f.auth.logoutPending,true);
 assert.equal(await f.auth.login('another','password'),false);f.fail(f.requests.at(-1),0);assert.equal((await p).success,false);assert.equal(f.auth.logoutPending,true);
 const count=f.requests.length,retry=f.auth.initialize(true);assert.equal(f.requests.at(-1).url,'/api/auth/logout');assert.equal(f.requests.length,count+1);
 f.flush(f.requests.at(-1),{success:true});await retry;assert.equal(f.auth.logoutPending,false);assert.equal(f.auth.isLoggedIn(),false);
});
await check('cross-tab changes invalidate memory and redirect without promoting storage claims',async()=>{
 const f=await signedIn(fixture());f.router.url='/app/inventory?filter=active';f.events.storage({key:'fi_auth_event'});
 assert.equal(f.auth.isLoggedIn(),false);assert.equal(f.calls.at(-1).path[0],'/login');assert.ok(f.auth.message.includes('another tab'));
});
await check('old failures cannot expire a newer identity and return URLs stay internal',async()=>{
 const f=await signedIn(fixture()),epoch=f.auth.sessionEpoch;await signedIn(f,user(2,2));f.auth.invalidate('old failure',epoch);assert.equal(f.auth.getCurrentUser().userId,2);
 for(const value of ['https://evil.example','//evil.example','/app\\evil','/access','javascript:alert(1)'])assert.equal(f.module.safeReturnUrl(value),'/app');
 assert.equal(f.module.safeReturnUrl('/app/inventory?page=2'),'/app/inventory?page=2');
});
await check('business type updates use a dedicated API and discard responses after sign-out',async()=>{
 const f=await signedIn(fixture());const modes=[];f.auth.businessTypeChanged$.subscribe(v=>modes.push(v));
 const update=f.auth.updateBusinessType(999,'layer'),request=f.requests.at(-1);assert.equal(request.url,'/api/account/business-type');assert.equal(Object.keys(request.body).join(','),'businessType');
 f.flush(request,{success:true,user:user(1,1,'farm_admin','layer')});assert.equal((await update).success,true);assert.deepEqual(modes,['layer']);
 const stale=f.auth.updateBusinessType(1,'broiler'),old=f.requests.at(-1);f.auth.invalidate();f.flush(old,{success:true,user:user()});assert.equal((await stale).success,false);assert.equal(f.auth.isLoggedIn(),false);
});
await check('late BEGIN responses cannot restore a previous identity transaction token',async()=>{
 const requests=[],http={post:(url,body)=>{const result=new rx.Subject();requests.push({url,body,result});return result;}};
 const {HttpPlatformApi}=loadBrowserSource('src/app/shared/platform/http-platform-api.ts',{'@angular/core':{Injectable:()=>t=>t}});
 const api=new HttpPlatformApi(http),begin=api.dbBeginTransaction();api.resetSession();requests[0].result.next({success:true,token:'old'});requests[0].result.complete();assert.equal((await begin).success,false);
 const read=api.dbGet('SELECT 1');assert.equal(requests[1].body.token,null);requests[1].result.next({success:true,data:[]});requests[1].result.complete();await read;
});

function interceptorFor(f) {
 class Response {constructor(body){this.body=body;}}
 class Failure extends Error {constructor(value){super('HTTP failure');Object.assign(this,value);}}
 const intercept=loadBrowserSource('src/app/shared/auth/session.interceptor.ts',{
  '@angular/core':{inject:()=>f.auth},'@angular/common/http':{HttpResponse:Response,HttpErrorResponse:Failure},'../services/auth.service':f.module,
 }).sessionInterceptor;
 const request=url=>({url,headers:{},clone(value){return {...this,...value,headers:{...this.headers,...value.setHeaders},clone:this.clone};}});
 return {intercept,Response,Failure,request};
}
await check('interceptor adds same-origin credentials/context and never attaches them to external services',async()=>{
 const f=await signedIn(fixture()),{intercept,request,Response}=interceptorFor(f);let seen;
 await rx.firstValueFrom(intercept(request('/api/db/get'),r=>{seen=r;return rx.of(new Response({success:true}));}));
 assert.equal(seen.withCredentials,true);assert.equal(seen.headers['X-FI-Session-Context'],'1:1');
 const external=request('https://other.example/api/data');await rx.firstValueFrom(intercept(external,r=>{assert.equal(r,external);return rx.of(new Response({}));}));
});
await check('interceptor drops stale successful data and never replays a mutation',async()=>{
 const f=await signedIn(fixture()),{intercept,request,Response}=interceptorFor(f);let calls=0;const response=new rx.Subject();
 const result=rx.firstValueFrom(intercept(request('/api/db/run'),()=>{calls++;return response;}));f.auth.invalidate();response.next(new Response({privateData:'old account'}));
 await assert.rejects(result,error=>error.status===409);assert.equal(calls,1);
});
await check('401 invalidates the current identity while ordinary 403 does not erase it',async()=>{
 const f=await signedIn(fixture()),{intercept,request,Failure}=interceptorFor(f);f.router.url='/app/inventory';
 await assert.rejects(rx.firstValueFrom(intercept(request('/api/db/get'),()=>rx.throwError(()=>new Failure({status:403,error:{}})))));assert.equal(f.auth.isLoggedIn(),true);
 await assert.rejects(rx.firstValueFrom(intercept(request('/api/db/get'),()=>rx.throwError(()=>new Failure({status:401,error:{}})))));assert.equal(f.auth.isLoggedIn(),false);assert.equal(f.calls.at(-1).path[0],'/login');
});
await check('protected route guards wait for server restore and block staff/platform business entry',async()=>{
 const f=fixture();class RouterToken{}
 const guards=loadBrowserSource('src/app/shared/guards/session.guard.ts',{'@angular/core':{inject:token=>token===RouterToken?f.router:f.auth},
  '@angular/router':{Router:RouterToken},'../services/auth.service':f.module});
 const pending=guards.sessionGuard({}, {url:'/app/inventory'});assert.equal(f.auth.isLoggedIn(),false);f.fail(f.requests[0],401);
 assert.equal((await pending).path[0],'/login');
 for(const role of ['staff','super_admin']){await signedIn(f,user(1,1,role));assert.equal((await guards.sessionGuard({}, {url:'/app/inventory'})).path[0],'/access');}
 await signedIn(f);assert.equal(await guards.sessionGuard({}, {url:'/app/inventory'}),true);
});
await check('admin and team guards restore identity and isolate platform/farm roles',async()=>{
 const f=fixture();class RouterToken{};const guards=loadBrowserSource('src/app/shared/guards/session.guard.ts',{'@angular/core':{inject:token=>token===RouterToken?f.router:f.auth},'@angular/router':{Router:RouterToken},'../services/auth.service':f.module});
 await signedIn(f,user(1,1,'super_admin'));assert.equal(await guards.adminGuard({},{}),true);assert.equal(f.auth.landingUrl(),'/admin');assert.equal((await guards.teamGuard({},{})).path[0],'/access');
 await signedIn(f);assert.equal(await guards.teamGuard({},{}),true);assert.equal((await guards.adminGuard({},{})).path[0],'/access');assert.equal(f.auth.landingUrl('/team'),'/team');
 await signedIn(f,user(1,1,'staff'));assert.equal((await guards.adminGuard({},{})).path[0],'/access');assert.equal((await guards.teamGuard({},{})).path[0],'/access');
});
await check('admin requests receive context protection and expired identity leaves admin screens',async()=>{
 const f=await signedIn(fixture(),user(1,1,'super_admin')),{intercept,request,Failure}=interceptorFor(f);f.router.url='/admin';
 await assert.rejects(rx.firstValueFrom(intercept(request('/api/admin/farms'),r=>{assert.equal(r.headers['X-FI-Session-Context'],'1:platform');return rx.throwError(()=>new Failure({status:401,error:{}}));})));
 assert.equal(f.calls.at(-1).path[0],'/login');assert.equal(f.auth.isLoggedIn(),false);
});
await check('sign-out navigates away before network completion and normal initialization retries pending revocation',async()=>{
 const f=await signedIn(fixture());f.router.url='/admin';const p=f.auth.logout();assert.equal(f.calls.at(-1).path[0],'/login');f.fail(f.requests.at(-1),0);await p;
 const retry=f.auth.initialize();assert.equal(f.requests.at(-1).url,'/api/auth/logout');f.flush(f.requests.at(-1),{success:true});await retry;assert.equal(f.auth.logoutPending,false);
});
console.log(`\nALL CHECKS PASSED — ${passed} browser session state scenarios`);
