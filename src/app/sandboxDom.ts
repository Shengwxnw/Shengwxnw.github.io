export type PreparedDocument = {
  html: string;
  title?: string;
};

export type PrepareOptions = {
  baseUrl: string;
  sandboxId: string;
  frameId: string;
};

const disallowedSchemes = ['javascript:', 'data:', 'mailto:', 'tel:'];

export function toBase64Url(input: string): string {
  const encoded = btoa(unescape(encodeURIComponent(input)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeHtml(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

function resolveAbsoluteUrl(ref: string | null, base: string): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (disallowedSchemes.some(prefix => lower.startsWith(prefix))) return null;
  try {
    const absolute = new URL(trimmed, base);
    if (!absolute.protocol.startsWith('http')) return null;
    return absolute.toString();
  } catch {
    return null;
  }
}

function rewriteCssUrls(css: string, base: string, sandboxId: string): string {
  const urlPattern = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
  const importPattern = /@import\s+(?:url\(\s*(['"]?)([^'"\)]+)\1\s*\)|(['"])([^'"\)]+)\3)/gi;

  const proxifyCssRef = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('javascript:') || lower.startsWith('#')) {
      return null;
    }
    const absolute = resolveAbsoluteUrl(trimmed, base);
    if (!absolute) return null;
    return buildSandboxAssetUrl(sandboxId, absolute);
  };

  const rewriteUrlMatch = (_match: string, quote: string, raw: string) => {
    const proxied = proxifyCssRef(raw);
    if (!proxied) return _match;
    const q = quote || '';
    return `url(${q}${proxied}${q})`;
  };

  const rewriteImportMatch = (_match: string, q1: string, raw1: string, q2: string, raw2: string) => {
    const raw = raw1 ?? raw2;
    const quote = q1 || q2 || '';
    if (!raw) return _match;
    const proxied = proxifyCssRef(raw);
    if (!proxied) return _match;
    if (q1) {
      return `@import url(${quote}${proxied}${quote})`;
    }
    if (q2) {
      return `@import ${quote}${proxied}${quote}`;
    }
    return _match;
  };

  return css.replace(urlPattern, rewriteUrlMatch).replace(importPattern, rewriteImportMatch);
}

function encodePathname(pathname: string): string {
  const segments = pathname.split('/').map(segment => encodeURIComponent(segment));
  let joined = segments.join('/');
  if (!joined.startsWith('/')) {
    joined = `/${joined}`;
  }
  if (joined === '') {
    joined = '/';
  }
  return joined;
}

export function buildSandboxAssetUrl(sandboxId: string, targetUrl: string): string {
  const url = new URL(targetUrl);
  const scheme = url.protocol.replace(':', '');
  const host = encodeURIComponent(url.host);
  const path = encodePathname(url.pathname);
  const qs = url.search ? `?__qs=${toBase64Url(url.search.slice(1))}` : '';
  return `/__sandbox__/asset/${encodeURIComponent(sandboxId)}/${scheme}/${host}${path}${qs}`;
}

function rewriteSrcSet(value: string, base: string, sandboxId: string): string {
  const candidates = value.split(',');
  const rewritten: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const urlPart = parts.shift() ?? '';
    const descriptor = parts.join(' ');
    const absolute = resolveAbsoluteUrl(urlPart, base);
    if (!absolute) {
      rewritten.push(trimmed);
      continue;
    }
    const proxied = buildSandboxAssetUrl(sandboxId, absolute);
    rewritten.push(descriptor ? `${proxied} ${descriptor}` : proxied);
  }
  return rewritten.join(', ');
}

function injectControllerScript(doc: Document, frameId: string) {
  const script = doc.createElement('script');
  script.type = 'application/javascript';
  script.textContent = `(() => {
    const FRAME_ID = ${JSON.stringify(frameId)};
    const toBase64Url = (input) => {
      const encoded = btoa(unescape(encodeURIComponent(input)));
      return encoded.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    };
    const post = (type, payload) => {
      try {
        parent.postMessage(Object.assign({ type, frameId: FRAME_ID }, payload || {}), '*');
      } catch (err) {
        console.warn('sandbox postMessage failed', err);
      }
    };
    const nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      const evt = new Event('submit', { bubbles: true, cancelable: true });
      if (!this.dispatchEvent(evt)) return;
      nativeSubmit.call(this);
    };
    const originalOpen = window.open;
    window.open = function (url, target, features) {
      if (url == null) {
        return originalOpen ? originalOpen.call(window, url, target, features) : null;
      }
      try {
        const absolute = new URL(String(url), location.href).toString();
        post('sandbox:navigate', { url: absolute, method: 'GET', openNew: true });
      } catch (err) {
        post('sandbox:notify', { level: 'error', message: 'Failed to open URL: ' + (err && err.message ? err.message : err) });
      }
      return null;
    };
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[data-proxy-target]') : null;
      if (!target) return;
      const href = target.getAttribute('data-proxy-target');
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      post('sandbox:navigate', {
        url: href,
        method: 'GET',
        openNew: target.getAttribute('data-proxy-open') === 'new'
      });
    }, true);
    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = form.getAttribute('data-proxy-action');
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const method = (form.getAttribute('data-proxy-method') || form.getAttribute('method') || 'GET').toUpperCase();
      const enctype = (form.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
      const formData = new FormData(form);
      if (method === 'GET') {
        try {
          const nextUrl = new URL(action);
          const params = new URLSearchParams(nextUrl.search);
          for (const [key, value] of formData.entries()) {
            if (typeof value === 'string') params.append(key, value);
          }
          nextUrl.search = params.toString();
          post('sandbox:navigate', { url: nextUrl.toString(), method: 'GET' });
        } catch (err) {
          post('sandbox:notify', { level: 'error', message: 'Failed to submit form: ' + (err && err.message ? err.message : err) });
        }
        return;
      }
      if (method === 'POST' && (enctype === 'application/x-www-form-urlencoded' || enctype === '')) {
        const params = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          if (typeof value === 'string') params.append(key, value);
        }
        const body = params.toString();
        post('sandbox:navigate', {
          url: action,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          bodyB64: toBase64Url(body)
        });
        return;
      }
      post('sandbox:notify', { level: 'error', message: 'Unsupported form encoding: ' + enctype });
    }, true);
  })();`;
  doc.head?.insertBefore(script, doc.head.firstChild);
}

export function prepareSandboxDocument(html: string, options: PrepareOptions): PreparedDocument {
  const doc = decodeHtml(html);
  const { baseUrl, sandboxId, frameId } = options;

  doc.querySelectorAll('base').forEach(el => el.remove());

  const proxify = (value: string | null) => {
    const absolute = resolveAbsoluteUrl(value, baseUrl);
    if (!absolute) return null;
    return buildSandboxAssetUrl(sandboxId, absolute);
  };

  const proxifyAttribute = (selector: string, attr: string) => {
    doc.querySelectorAll<HTMLElement>(selector).forEach(element => {
      const value = element.getAttribute(attr);
      const proxied = proxify(value);
      if (proxied) {
        element.setAttribute(attr, proxied);
      }
    });
  };

  proxifyAttribute('img[src]', 'src');
  doc.querySelectorAll('img[srcset]').forEach(img => {
    const srcset = img.getAttribute('srcset');
    if (!srcset) return;
    img.setAttribute('srcset', rewriteSrcSet(srcset, baseUrl, sandboxId));
  });
  doc.querySelectorAll('source[srcset]').forEach(source => {
    const srcset = source.getAttribute('srcset');
    if (!srcset) return;
    source.setAttribute('srcset', rewriteSrcSet(srcset, baseUrl, sandboxId));
  });
  proxifyAttribute('source[src]', 'src');
  proxifyAttribute('video[poster]', 'poster');
  proxifyAttribute('video[src]', 'src');
  proxifyAttribute('audio[src]', 'src');
  proxifyAttribute('track[src]', 'src');
  proxifyAttribute('iframe[src]', 'src');
  proxifyAttribute('embed[src]', 'src');
  proxifyAttribute('object[data]', 'data');
  proxifyAttribute('script[src]', 'src');
  doc.querySelectorAll('script[integrity]').forEach(script => script.removeAttribute('integrity'));
  doc.querySelectorAll('link[href]').forEach(link => {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const shouldProxy = ['stylesheet', 'icon', 'preload', 'prefetch', 'apple-touch-icon', 'manifest', 'alternate'].some(token => rel.includes(token));
    if (!shouldProxy) return;
    const proxied = proxify(link.getAttribute('href'));
    if (proxied) {
      link.setAttribute('href', proxied);
      link.removeAttribute('integrity');
    }
  });

  doc.querySelectorAll('style').forEach(style => {
    const text = style.textContent;
    if (!text) return;
    style.textContent = rewriteCssUrls(text, baseUrl, sandboxId);
  });

  doc.querySelectorAll<HTMLElement>('[style]').forEach(element => {
    const inline = element.getAttribute('style');
    if (!inline) return;
    const rewritten = rewriteCssUrls(inline, baseUrl, sandboxId);
    if (rewritten !== inline) {
      element.setAttribute('style', rewritten);
    }
  });

  doc.querySelectorAll('a[href]').forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) return;
    const absolute = resolveAbsoluteUrl(href, baseUrl);
    if (!absolute) return;
    anchor.setAttribute('data-proxy-target', absolute);
    if (anchor.getAttribute('target') === '_blank') {
      anchor.setAttribute('data-proxy-open', 'new');
    }
    anchor.setAttribute('href', '#');
    anchor.setAttribute('rel', 'noreferrer noopener');
  });

  doc.querySelectorAll('form').forEach(form => {
    const actionAttr = form.getAttribute('action');
    const absolute = resolveAbsoluteUrl(actionAttr || baseUrl, baseUrl) || baseUrl;
    form.setAttribute('data-proxy-action', absolute);
    const method = (form.getAttribute('method') || 'GET').toUpperCase();
    form.setAttribute('data-proxy-method', method);
  });

  injectControllerScript(doc, frameId);

  if (!doc.head.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.insertBefore(meta, doc.head.firstChild);
  }

  const title = doc.querySelector('title')?.textContent ?? undefined;
  const serialized = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  return { html: serialized, title };
}
