// Static shell only. API responses, exports and mutations are NEVER cached or replayed.
const CACHE='farminfantary-static-v2-brand';
const asset=/^\/(?:main|polyfills|chunk|styles)-[a-z0-9]+\.(?:js|css)$|^\/(?:logo\.png|favicon\.png|app-icon\.svg)$/i;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/index.html','/logo.png']))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('farminfantary-static-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate')event.respondWith((async()=>{const cache=await caches.open(CACHE);try{const response=await fetch(request);if(response.ok&&response.headers.get('content-type')?.includes('text/html'))await cache.put('/index.html',response.clone());return response;}catch{const shell=await cache.match('/index.html');if(shell)return shell;throw new Error('Connect to load the application.');}})());
 else if(asset.test(url.pathname))event.respondWith((async()=>{const cache=await caches.open(CACHE),cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;})());
});
