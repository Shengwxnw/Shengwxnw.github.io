/// <reference lib="webworker" />
export {};

const ctx: ServiceWorkerGlobalScope = self as any;

ctx.addEventListener('install', (e) => {
  e.waitUntil(ctx.skipWaiting());
});

ctx.addEventListener('activate', (e) => {
  e.waitUntil(ctx.clients.claim());
});

ctx.addEventListener('message', (event) => {
  const data = event.data as any;
  if (!data) return;
  if (data.type === 'config' && typeof data.workerBase === 'string') {
    (ctx as any).__WORKER_BASE = data.workerBase;
  }
  if (data.type === 'warmup') {
    const wb = (ctx as any).__WORKER_BASE as string | undefined;
    if (wb) {
      // warm a trivial GET to establish TLS/H2
      event.waitUntil(fetch(wb + '/p?sid=_warm&u=' + encodeURIComponent(b64url('https://example.com'))).catch(() => undefined));
    }
  }
});

function b64url(s: string) {
  // eslint-disable-next-line no-undef
  const enc = btoa(unescape(encodeURIComponent(s)));
  return enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

ctx.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const wb = (ctx as any).__WORKER_BASE as string | undefined;
  if (!wb) return; // nothing to rewrite without base

  // Only handle app-origin requests to /p and /fetch
  if (url.origin === location.origin && (url.pathname === '/p' || url.pathname === '/fetch')) {
    event.respondWith(handleProxy(req));
  }

  async function handleProxy(origReq: Request): Promise<Response> {
    const inUrl = new URL(origReq.url);
    let outUrl = wb + inUrl.pathname + inUrl.search;
    const init: RequestInit = {
      method: origReq.method,
      headers: new Headers(origReq.headers),
      body: origReq.method !== 'GET' && origReq.method !== 'HEAD' ? await origReq.clone().arrayBuffer() : undefined,
      mode: 'cors',
      cache: 'no-cache',
      redirect: 'follow',
      credentials: 'omit'
    };

    // For /fetch, keep JSON body as-is
    if (inUrl.pathname === '/fetch') {
      // keep headers Content-Type
    }

    const res = await fetch(outUrl, init);
    // Broadcast X-Set-Cookie to all clients with sid association if present on request
    const xsc = res.headers.get('X-Set-Cookie');
    let sid = '';
    if (inUrl.pathname === '/p') sid = new URLSearchParams(inUrl.search).get('sid') || '';
    if (inUrl.pathname === '/fetch') {
      try {
        const body = await origReq.clone().text();
        const parsed = JSON.parse(body);
        sid = parsed?.sid || '';
      } catch { /* ignore */ }
    }
    if (xsc) {
      const all = await ctx.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header: xsc }));
    }
    return res;
  }
});
