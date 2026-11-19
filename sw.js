/* NATO Term Lookup service worker: cache the whole app so it works with no signal.

   One versioned cache holds the app, and it is filled in a single pass at
   install, straight from the network. Every file in it therefore comes from
   the same deploy.

   That matters more than it sounds. The previous worker served each file from
   cache and refreshed it in the background, one file at a time, so a cache
   could end up holding a new index.html beside the previous app.js. The page
   then looks right and does nothing at all, because the old script is hunting
   for elements the new markup no longer has, and it stays that way on every
   later visit. Nothing rewrites this cache: a new version of the app arrives
   only as a new cache name, built by a new worker, all of it or none of it. */

var CACHE = 'nato-lookup-v12';
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data/terms.json',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* cache: 'reload' keeps the browser's own HTTP cache out of this.
         Without it a file still inside its max-age window is copied over
         from the previous deploy, which is how the versions got mixed. */
      return Promise.all(ASSETS.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
          if (!res || !res.ok) throw new Error('could not fetch ' + url);
          return c.put(url, res);
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
    /* A failure here leaves the previous worker in charge and the previous
       cache whole, and the next visit tries again. A half-filled cache is
       the one outcome worth avoiding. */
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  ev.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        /* Not one of this version's files: go to the network, and fall back
           to the app itself for a navigation so the page still opens. */
        return fetch(req).catch(function () {
          return req.mode === 'navigate' ? c.match('index.html') : Promise.reject();
        });
      });
    })
  );
});
