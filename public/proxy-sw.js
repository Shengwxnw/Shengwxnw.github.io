/* Service Worker proxy: rewrites app-origin /p and /fetch to configured Worker base */
/* global self */

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'config' && typeof data.workerBase === 'string') {
    self.__WORKER_BASE = data.workerBase;
  }
  if (data.type === 'warmup') {
    const wb = self.__WORKER_BASE;
    if (wb) {
      event.waitUntil(fetch(wb + '/p?sid=_warm&u=' + encodeURIComponent(b64url('https://example.com'))).catch(() => undefined));
    }
  }
});

function b64url(s) {
  const enc = btoa(unescape(encodeURIComponent(s)));
  return enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const wb = self.__WORKER_BASE;
  if (!wb) return; // nothing to rewrite without base

  if (url.origin === location.origin && (url.pathname === '/p' || url.pathname === '/fetch')) {
    event.respondWith(handleProxy(req));
  }

  async function handleProxy(origReq) {
    const inUrl = new URL(origReq.url);
    const outUrl = wb + inUrl.pathname + inUrl.search;
    const init = {
      method: origReq.method,
      headers: new Headers(origReq.headers),
      body: origReq.method !== 'GET' && origReq.method !== 'HEAD' ? await origReq.clone().arrayBuffer() : undefined,
      mode: 'cors',
      cache: 'no-cache',
      redirect: 'follow',
      credentials: 'omit'
    };
    const res = await fetch(outUrl, init);
    const xsc = res.headers.get('X-Set-Cookie');
    let sid = '';
    if (inUrl.pathname === '/p') sid = new URLSearchParams(inUrl.search).get('sid') || '';
    if (inUrl.pathname === '/fetch') {
      try {
        const body = await origReq.clone().text();
        const parsed = JSON.parse(body);
        sid = parsed && parsed.sid || '';
      } catch {}
    }
    if (xsc) {
      const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header: xsc }));
    }
    return res;
  }
});

