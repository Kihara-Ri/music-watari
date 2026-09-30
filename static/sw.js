const CACHE='album-shell-v20';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/offline.html'])));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('album-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// Never cache API responses, private inventory, sessions, or transaction requests.
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate'&&e.request.method==='GET')e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')));});
