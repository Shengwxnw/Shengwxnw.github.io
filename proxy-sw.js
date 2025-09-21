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
      const warmUrl = wb.endsWith('/') ? wb : `${wb}/`;
      event.waitUntil(fetch(warmUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' }).catch(() => undefined));
    }
  }
});

function b64url(s) {
  const enc = btoa(unescape(encodeURIComponent(s)));
  return enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const padLength = (4 - (value.length % 4 || 4)) % 4;
  const padded = value + '='.repeat(padLength);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const wb = self.__WORKER_BASE;
  if (!wb) return; // nothing to rewrite without base

  const isAppOrigin = url.origin === location.origin;
  if (!isAppOrigin) return;

  if (url.pathname === '/p' || url.pathname === '/fetch' || url.pathname === '/dispatch') {
    event.respondWith(handleProxy(req));
    return;
  }

  if (url.pathname.startsWith('/__sandbox__/asset/')) {
    event.respondWith(handleSandboxAsset(req));
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
    const sid = await extractSidFromRequest(inUrl, origReq);
    if (sid) {
      const header = collectXSetCookie(res.headers);
      if (header) {
        const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header }));
      }
    }
    return res;
  }

  async function handleSandboxAsset(origReq) {
    const info = decodeSandboxAssetUrl(new URL(origReq.url));
    if (!info) {
      return new Response('Bad sandbox asset request', { status: 400 });
    }
    const target = info.target;
    const sid = info.sid;
    const proxied = `${wb}/p?sid=${encodeURIComponent(sid)}&u=${encodeURIComponent(b64url(target))}`;
    const init = {
      method: origReq.method,
      headers: new Headers(origReq.headers),
      body: origReq.method !== 'GET' && origReq.method !== 'HEAD' ? await origReq.clone().arrayBuffer() : undefined,
      mode: 'cors',
      cache: 'no-cache',
      redirect: 'follow',
      credentials: 'omit'
    };
    const res = await fetch(proxied, init);
    if (sid) {
      const header = collectXSetCookie(res.headers);
      if (header) {
        const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header }));
      }
    }
    return res;
  }
});

function collectXSetCookie(headers) {
  const collected = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'x-set-cookie' && value) {
      collected.push(value);
    }
  });
  if (!collected.length) return null;
  return collected.join(',');
}

async function extractSidFromRequest(url, req) {
  if (url.pathname === '/p') {
    return new URLSearchParams(url.search).get('sid') || '';
  }
  if (url.pathname === '/fetch' || url.pathname === '/dispatch') {
    try {
      const body = await req.clone().text();
      const parsed = JSON.parse(body);
      return parsed && parsed.sid || '';
    } catch {
      return '';
    }
  }
  return '';
}

function decodeSandboxAssetUrl(url) {
  const prefix = '/__sandbox__/asset/';
  if (!url.pathname.startsWith(prefix)) return null;
  const remainder = url.pathname.slice(prefix.length);
  const parts = remainder.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const [sidEncoded, scheme, hostEncoded, ...pathParts] = parts;
  const sid = decodeURIComponent(sidEncoded);
  if (scheme !== 'https') return null;
  const host = decodeURIComponent(hostEncoded);
  const path = pathParts.length ? `/${pathParts.map(decodeURIComponent).join('/')}` : '/';
  const qs = url.searchParams.get('__qs');
  const query = qs ? `?${fromBase64Url(qs)}` : '';
  return { sid, target: `https://${host}${path}${query}` };
}

