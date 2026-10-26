import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const handlers={},stores=new Map(),source=readFileSync(new URL('../../public/sw.js',import.meta.url),'utf8');let offline=false,network=0,claimed=false,passed=0;
const k=request=>typeof request==='string'?request:new URL(request.url).pathname;
const caches={open:async name=>{if(!stores.has(name))stores.set(name,new Map());const data=stores.get(name);return {addAll:async urls=>urls.forEach(url=>data.set(url,new Response('static shell',{headers:{'content-type':'text/html'}}))),match:async request=>data.get(k(request))?.clone(),put:async(request,response)=>data.set(k(request),response.clone())};},keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name)};
vm.runInNewContext(source,{self:{location:{origin:'https://farm.test'},clients:{claim:async()=>{claimed=true;}},addEventListener:(type,fn)=>handlers[type]=fn},caches,URL,fetch:async request=>{network++;if(offline)throw new Error('offline');return new Response('static asset',{headers:{'content-type':request.mode==='navigate'?'text/html':'application/javascript'}});}});
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const event=async(type,request)=>{let promise;handlers[type]({request,waitUntil:p=>promise=p,respondWith:p=>promise=p});return promise?await promise:undefined;};
await check('shell install caches only public static shell assets',async()=>{await event('install');assert.deepEqual([...stores.values()][0].keys().toArray?.()||[...[...stores.values()][0].keys()],['/index.html','/logo.png']);});
await check('API reads, all mutations, exports and foreign origins bypass the service worker',async()=>{
 for(const request of [{url:'https://farm.test/api/auth/me',method:'GET'},{url:'https://farm.test/api/account/export',method:'GET'},{url:'https://farm.test/api/db/run',method:'POST'},{url:'https://other.test/main-ABC.js',method:'GET'}])assert.equal(await event('fetch',request),undefined);assert.equal(network,0);
});
await check('offline navigation can load a cached shell without caching any account response',async()=>{offline=true;assert.equal(await(await event('fetch',{url:'https://farm.test/app/inventory',method:'GET',mode:'navigate'})).text(),'static shell');});
await check('hashed public assets are cached after visiting and can load during connection loss',async()=>{offline=false;const req={url:'https://farm.test/chunk-ABC123.js',method:'GET',mode:'cors'};await event('fetch',req);const count=network;offline=true;assert.equal(await(await event('fetch',req)).text(),'static asset');assert.equal(network,count);});
await check('unrelated files and financial downloads are never added to the static cache',async()=>{assert.equal(await event('fetch',{url:'https://farm.test/customer-report.json',method:'GET'}),undefined);assert.ok(!JSON.stringify([...stores.values()].flatMap(s=>[...s.keys()])).includes('/api/'));});
await check('activation removes only this application old static caches',async()=>{stores.set('unrelated-cache',new Map());stores.set('farminfantary-static-old',new Map());await event('activate');assert.equal(claimed,true);assert.ok(stores.has('unrelated-cache'));assert.ok(!stores.has('farminfantary-static-old'));});
console.log('ALL CHECKS PASSED — '+passed+' static shell privacy scenarios');
