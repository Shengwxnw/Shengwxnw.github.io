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
      const warmUrl = wb.endsWith('/') ? wb : `${wb}/`;
      event.waitUntil(
        fetch(warmUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' }).catch(() => undefined)
      );
    }
  }
});

function b64url(s: string) {
  // eslint-disable-next-line no-undef
  const enc = btoa(unescape(encodeURIComponent(s)));
  return enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padLength = (4 - (value.length % 4 || 4)) % 4;
  const padded = value + '='.repeat(padLength);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

ctx.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const wb = (ctx as any).__WORKER_BASE as string | undefined;
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
    const sid = await extractSidFromRequest(inUrl, origReq);
    if (sid) {
      const header = collectXSetCookie(res.headers);
      if (header) {
        const all = await ctx.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header }));
      }
    }
    return res;
  }

  async function handleSandboxAsset(origReq: Request): Promise<Response> {
    const info = decodeSandboxAssetUrl(new URL(origReq.url));
    if (!info) {
      return new Response('Bad sandbox asset request', { status: 400 });
    }
    const target = info.target;
    const sid = info.sid;
    const proxied = `${wb}/p?sid=${encodeURIComponent(sid)}&u=${encodeURIComponent(b64url(target))}`;
    const init: RequestInit = {
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
        const all = await ctx.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        all.forEach(c => c.postMessage({ type: 'set-cookie', sid, header }));
      }
    }
    return res;
  }
});

function collectXSetCookie(headers: Headers): string | null {
  const collected: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'x-set-cookie' && value) {
      collected.push(value);
    }
  });
  if (!collected.length) return null;
  return collected.join(',');
}

async function extractSidFromRequest(url: URL, req: Request): Promise<string> {
  if (url.pathname === '/p') {
    return new URLSearchParams(url.search).get('sid') || '';
  }
  if (url.pathname === '/fetch' || url.pathname === '/dispatch') {
    try {
      const body = await req.clone().text();
      const parsed = JSON.parse(body);
      return parsed?.sid || '';
    } catch {
      return '';
    }
  }
  return '';
}

function decodeSandboxAssetUrl(url: URL): { sid: string; target: string } | null {
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
