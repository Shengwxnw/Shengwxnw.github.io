import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SandboxPage } from '../app/SandboxPage';
import { UrlHistory } from '../app/UrlHistory';
import { CookieStore } from '../app/CookieStore';
import { prepareSandboxDocument } from '../app/sandboxDom';

const schemePrefix = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/;

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('#')) {
    return trimmed;
  }
  if (schemePrefix.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

type SandboxFrameProps = Omit<React.IframeHTMLAttributes<HTMLIFrameElement>, 'src' | 'srcDoc'> & {
  html: string;
};

const SandboxFrame = React.forwardRef<HTMLIFrameElement, SandboxFrameProps>(({ html, ...iframeProps }, ref) => {
  const blobUrl = useMemo(() => {
    const blob = new Blob([html], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [html]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  return <iframe {...iframeProps} ref={ref} src={blobUrl} />;
});

SandboxFrame.displayName = 'SandboxFrame';

function uuid(): string {
  // RFC4122 v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type SandboxDocument = {
  html?: string;
  text?: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  note?: string;
};

type SandboxState = {
  page: SandboxPage;
  document?: SandboxDocument;
  error?: string;
  notice?: string;
  isLoading?: boolean;
};

type NavigateInit = {
  method?: 'GET' | 'POST' | 'HEAD';
  bodyB64?: string;
  headers?: Record<string, string>;
};

// Lookup a header value case-insensitively and coerce non-string payloads to a string
function headerLookup(
  headers: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
    if (value == null) return undefined;
    try {
      return String(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const ConnectorApp: React.FC = () => {
  const [sandboxes, setSandboxes] = useState<Map<string, SandboxState>>(new Map());
  const [activeId, setActiveId] = useState<string>('');
  const [urlValue, setUrlValue] = useState<string>('');
  const [workerBase, setWorkerBase] = useState<string | undefined>(() => {
    const stored = localStorage.getItem('workerBase');
    if (stored) {
      return normalizeUrlInput(stored) || undefined;
    }
    const envBase = import.meta.env.VITE_WORKER_BASE as string | undefined;
    return envBase ? normalizeUrlInput(envBase) || undefined : undefined;
  });

  const sandboxesRef = useRef(sandboxes);
  useEffect(() => { sandboxesRef.current = sandboxes; }, [sandboxes]);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const workerBaseRef = useRef(workerBase);
  useEffect(() => { workerBaseRef.current = workerBase; }, [workerBase]);

  useEffect(() => {
    const activeSandbox = sandboxes.get(activeId);
    if (!activeSandbox) {
      setUrlValue('');
      return;
    }
    const nextUrl =
      activeSandbox.document?.finalUrl ||
      activeSandbox.page.history.current() ||
      activeSandbox.page.homeUrl ||
      '';
    setUrlValue(nextUrl ? normalizeUrlInput(nextUrl) : '');
  }, [activeId, sandboxes]);

  // SW messages: cookie propagation per sandbox
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const data = ev.data as any;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'set-cookie') {
        const { sid, header } = data;
        setSandboxes(prev => {
          const next = new Map(prev);
          const sb = next.get(sid);
          if (sb) {
            sb.page.cookieStore.applyFromHeader(header);
            next.set(sid, { ...sb });
          }
          sandboxesRef.current = next;
          return next;
        });
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  // Apply workerBase to SW when changed
  useEffect(() => {
    if (!workerBase) return;
    const msg = { type: 'config', workerBase } as const;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(msg);
      navigator.serviceWorker.controller.postMessage({ type: 'warmup' });
    }
  }, [workerBase]);

  const handleAdd = useCallback((seedUrl?: string) => {
    const id = uuid();
    const history = new UrlHistory();
    const cookieStore = new CookieStore(id);
    const homeUrl = seedUrl ? normalizeUrlInput(seedUrl) : '';
    const page = new SandboxPage({ id, title: 'New Sandbox', homeUrl, history, cookieStore });
    setSandboxes(prev => {
      const next = new Map(prev);
      next.set(id, { page });
      sandboxesRef.current = next;
      return next;
    });
    setActiveId(id);
    setUrlValue(homeUrl ?? '');
    return id;
  }, []);

  const handleRemove = useCallback((id: string) => {
    setSandboxes(prev => {
      const next = new Map(prev);
      next.delete(id);
      sandboxesRef.current = next;
      if (activeIdRef.current === id) {
        const first = next.keys().next().value ?? '';
        setActiveId(first);
        const firstState = first ? next.get(first) : undefined;
        setUrlValue(firstState?.document?.finalUrl || firstState?.page.homeUrl || '');
      }
      return next;
    });
  }, []);

  const navigateSandbox = useCallback(async (sandboxId: string, url: string, init?: NavigateInit) => {
    const map = sandboxesRef.current;
    const sb = map.get(sandboxId);
    if (!sb) return;
    const base = workerBaseRef.current;
    if (!base) {
      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          next.set(sandboxId, { ...current, error: 'Configure a Worker base URL before navigating.', isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
      return;
    }
    const input = url?.trim() || sb.page.homeUrl;
    const normalizedTarget = normalizeUrlInput(input) || sb.page.homeUrl;
    const target = schemePrefix.test(normalizedTarget) ? normalizedTarget : sb.page.homeUrl;
    if (!target) {
      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          next.set(sandboxId, { ...current, error: 'Enter a valid URL to navigate.', isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
      return;
    }
    setSandboxes(prev => {
      const next = new Map(prev);
      const current = next.get(sandboxId);
      if (current) {
        next.set(sandboxId, { ...current, error: undefined, notice: undefined, isLoading: true });
      }
      sandboxesRef.current = next;
      return next;
    });
    try {
      const result = await sb.page.navigate(target, init, base);
      const finalUrl = result.finalUrl || target;
      const contentType = headerLookup(result.headers as any, 'content-type') || '';
      const doc: SandboxDocument = {
        finalUrl,
        status: result.status,
        statusText: result.statusText,
        contentType,
        note: result.body?.note,
      };

      const bodyEncoding = result.body?.encoding;
      const bodyData = result.body?.data;
      const lowerType = contentType.toLowerCase();
      const isHtmlType = lowerType.includes('text/html') || lowerType.includes('application/xhtml+xml');

      if (bodyEncoding === 'text' && typeof bodyData === 'string') {
        const snippet = bodyData.slice(0, 512).trimStart();
        const looksHtml = isHtmlType || /^<!doctype/i.test(snippet) || /^<html[\s>]/i.test(snippet) || /^<head[\s>]/i.test(snippet) || /^<body[\s>]/i.test(snippet);
        if (looksHtml) {
          const prepared = prepareSandboxDocument(bodyData, { baseUrl: finalUrl, sandboxId, frameId: sandboxId });
          doc.html = prepared.html;
          if (prepared.title) {
            sb.page.title = prepared.title;
          }
        } else {
          doc.text = bodyData;
        }
      } else if (bodyEncoding === 'json') {
        doc.text = JSON.stringify(bodyData, null, 2);
      } else if (bodyEncoding === 'base64' && typeof bodyData === 'string') {
        doc.text = '[binary payload omitted]';
      } else if (typeof bodyData !== 'undefined') {
        doc.text = String(bodyData);
      } else if (!result.body && !result.ok) {
        doc.text = result.error || `Request failed with status ${result.status}`;
      }

      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          next.set(sandboxId, { ...current, document: doc, error: undefined, notice: undefined, isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
      if (activeIdRef.current === sandboxId) {
        setUrlValue(normalizeUrlInput(finalUrl));
      }
    } catch (e: any) {
      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          const message = e?.message || String(e);
          next.set(sandboxId, { ...current, error: `Request failed: ${message}`, isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
    }
  }, []);

  useEffect(() => {
    function onSandboxEvent(ev: MessageEvent) {
      const data = ev.data as any;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'sandbox:navigate') {
        const frameId = data.frameId as string;
        const targetUrl = data.url as string;
        const method = (data.method as 'GET' | 'POST' | 'HEAD' | undefined) || 'GET';
        const headers = (data.headers as Record<string, string> | undefined) || undefined;
        const bodyB64 = data.bodyB64 as string | undefined;
        if (data.openNew) {
          const newId = handleAdd(targetUrl);
          navigateSandbox(newId, targetUrl, { method, headers, bodyB64 });
          setActiveId(newId);
        } else {
          setActiveId(frameId);
          navigateSandbox(frameId, targetUrl, { method, headers, bodyB64 });
        }
      }
      if (data.type === 'sandbox:notify') {
        const frameId = data.frameId as string;
        const message = typeof data.message === 'string' ? data.message : 'Sandbox notification';
        setSandboxes(prev => {
          const next = new Map(prev);
          const current = next.get(frameId);
          if (current) {
            next.set(frameId, { ...current, notice: message, isLoading: false });
          }
          sandboxesRef.current = next;
          return next;
        });
      }
    }
    window.addEventListener('message', onSandboxEvent);
    return () => window.removeEventListener('message', onSandboxEvent);
  }, [handleAdd, navigateSandbox]);

  const active = sandboxes.get(activeId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const navigateActive = useCallback((url: string, method: 'GET' | 'POST' | 'HEAD' = 'GET') => {
    if (!active) return;
    const trimmed = url?.trim() ?? '';
    const normalized = trimmed ? normalizeUrlInput(trimmed) : '';
    const target = normalized || trimmed;
    if (normalized) {
      setUrlValue(prev => (prev === normalized ? prev : normalized));
    }
    if (!target) return;
    navigateSandbox(active.page.id, target, { method });
  }, [active, navigateSandbox]);

  const cookieEntries = useMemo(() => {
    if (!active) return [] as string[];
    return active.page.cookieStore.getDisplay();
  }, [active]);

  function configureWorkerBase() {
    const current = workerBase ?? '';
    const next = window.prompt('Enter Cloudflare Worker Base URL (e.g. https://<sub>.workers.dev)', current || '');
    if (next == null) return; // canceled
    const trimmed = next.trim();
    if (!trimmed) {
      localStorage.removeItem('workerBase');
      setWorkerBase(undefined);
      return;
    }
    const normalized = normalizeUrlInput(trimmed);
    if (!/^https?:\/\//i.test(normalized)) {
      alert('Please provide a valid http(s) URL.');
      return;
    }
    localStorage.setItem('workerBase', normalized);
    setWorkerBase(normalized);
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Connector</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="chip">Worker: {workerBase ?? 'not set'}</div>
          <button className="btn secondary" onClick={configureWorkerBase}>Configure</button>
        </div>
      </div>

      <aside className="sidebar">
        <button className="btn" onClick={() => handleAdd()}>New Sandbox</button>
        <div className="sandboxes">
          {Array.from(sandboxes.values()).map(s => (
            <div key={s.page.id} className={`sandbox-item ${activeId === s.page.id ? 'active' : ''}`} onClick={() => setActiveId(s.page.id)}>
              <div className="sandbox-title">{s.page.title || s.page.homeUrl}</div>
              <button className="btn secondary" onClick={(e) => { e.stopPropagation(); handleRemove(s.page.id); }}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {active ? (
          <>
            <div className="urlbar">
              <button className="btn secondary" onClick={() => navigateActive(active.page.history.back(), 'GET')}>Back</button>
              <button className="btn secondary" onClick={() => navigateActive(active.page.history.forward(), 'GET')}>Forward</button>
              <input
                type="text"
                value={urlValue}
                placeholder="https://example.com"
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigateActive(urlValue); }}
              />
              <button className="btn" onClick={() => { if (urlValue) navigateActive(urlValue); }}>Go</button>
              <button
                className="btn secondary"
                onClick={() => {
                  const frame = iframeRef.current;
                  if (!frame) return;
                  const request =
                    frame.requestFullscreen?.bind(frame) ||
                    (frame as any).webkitRequestFullscreen?.bind(frame) ||
                    (frame as any).mozRequestFullScreen?.bind(frame) ||
                    (frame as any).msRequestFullscreen?.bind(frame);
                  if (request) {
                    Promise.resolve(request()).catch(() => undefined);
                  }
                }}
              >
                Full Screen
              </button>
            </div>

            <section className="viewer">
              <div className="doc">
                {active.isLoading ? (
                  <div className="loading">Loading…</div>
                ) : active.document?.html ? (
                  <SandboxFrame
                    key={active.document.finalUrl ?? active.page.id}
                    ref={iframeRef}
                    title="document"
                    sandbox="allow-scripts allow-forms"
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                    html={active.document.html}
                  />
                ) : active.document?.text ? (
                  <pre>{active.document.text}</pre>
                ) : active.error ? (
                  <pre className="error">{active.error}</pre>
                ) : (
                  <pre>Enter a URL and press Go to fetch via the Worker router.</pre>
                )}
              </div>
              <div className="statusbar">
                {active.document ? (
                  <>
                    <span>Status: {active.document.status} {active.document.statusText}</span>
                    <span>URL: {active.document.finalUrl}</span>
                    <span>Type: {active.document.contentType ?? 'unknown'}</span>
                    {active.document.note ? <span>Note: {active.document.note}</span> : null}
                  </>
                ) : null}
                {active.notice ? <span className="notice">{active.notice}</span> : null}
              </div>
              {cookieEntries.length ? (
                <div className="cookie-panel">
                  <div className="cookie-title">Cookies ({cookieEntries.length})</div>
                  <ul>
                    {cookieEntries.map(entry => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </>
        ) : (
          <div className="empty-state">
            <p>No sandbox open. Create one to start browsing.</p>
          </div>
        )}
      </main>
    </div>
  );
};

export default ConnectorApp;
