import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SandboxPage } from '../app/SandboxPage';
import { UrlHistory } from '../app/UrlHistory';
import { CookieStore } from '../app/CookieStore';

function uuid(): string {
  // RFC4122 v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type SandboxState = {
  page: SandboxPage;
  lastContentType?: string;
  renderedHtml?: string; // raw HTML for iframe srcdoc
  renderedText?: string; // JSON or text fallback
  mediaUrl?: string;     // media viewer target (proxied /p)
};

const ConnectorApp: React.FC = () => {
  const [sandboxes, setSandboxes] = useState<Map<string, SandboxState>>(new Map());
  const [activeId, setActiveId] = useState<string>('');
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [urlValue, setUrlValue] = useState<string>('https://example.com');
  const [workerBase, setWorkerBase] = useState<string | undefined>(() => {
    return localStorage.getItem('workerBase') || (import.meta.env.VITE_WORKER_BASE as string | undefined) || undefined;
  });

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
          }
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

  useEffect(() => {
    if (sandboxes.size === 0) {
      handleAdd('https://example.com');
    }
  }, []);

  function handleAdd(seedUrl?: string) {
    const id = uuid();
    const history = new UrlHistory();
    const cookieStore = new CookieStore(id);
    const page = new SandboxPage({ id, title: 'New Sandbox', homeUrl: seedUrl ?? 'https://example.com', history, cookieStore });

    const next = new Map(sandboxes);
    next.set(id, { page });
    setSandboxes(next);
    setActiveId(id);
    setUrlValue(seedUrl ?? 'https://example.com');
  }

  function handleRemove(id: string) {
    const next = new Map(sandboxes);
    next.delete(id);
    setSandboxes(next);
    if (activeId === id) {
      setActiveId(next.keys().next().value ?? '');
    }
  }

  const active = sandboxes.get(activeId);

  async function navigateCurrent(url: string, method: 'GET' | 'POST' | 'HEAD' = 'GET') {
    if (!active) return;
    try {
      const resp = await active.page.navigate(url, { method });
      const ct = resp.headers.get('Content-Type') || '';
      const newState: Partial<SandboxState> = { lastContentType: ct, renderedHtml: undefined, renderedText: undefined };
      if (ct.includes('text/html')) {
        const html = await resp.text();
        newState.renderedHtml = html;
      } else if (ct.includes('application/json')) {
        try {
          const text = await resp.text();
          newState.renderedText = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          newState.renderedText = await resp.text();
        }
      } else {
        newState.renderedText = await resp.text();
      }
      setSandboxes(prev => {
        const next = new Map(prev);
        const cur = next.get(active.page.id);
        if (cur) next.set(active.page.id, { ...cur, ...newState });
        return next;
      });
    } catch (e: any) {
      setSandboxes(prev => {
        const next = new Map(prev);
        const cur = next.get(active.page.id);
        if (cur) next.set(active.page.id, { ...cur, renderedHtml: undefined, renderedText: `Request failed: ${e?.message ?? e}` });
        return next;
      });
    }
  }

  function base64url(s: string) {
    const enc = btoa(unescape(encodeURIComponent(s)));
    return enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function setMediaUrl(url: string) {
    if (!active) return;
    const u = `/p?sid=${encodeURIComponent(active.page.id)}&u=${base64url(url)}`;
    setSandboxes(prev => {
      const next = new Map(prev);
      const cur = next.get(active.page.id)!;
      next.set(active.page.id, { ...cur, mediaUrl: u });
      return next;
    });
  }

  function configureWorkerBase() {
    const current = workerBase ?? '';
    const next = window.prompt('Enter Cloudflare Worker Base URL (e.g. https://<sub>.workers.dev)', current || '');
    if (next == null) return; // canceled
    const trimmed = next.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      alert('Please provide a valid http(s) URL.');
      return;
    }
    localStorage.setItem('workerBase', trimmed);
    setWorkerBase(trimmed || undefined);
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
        <button className="btn" onClick={() => handleAdd('https://example.com')}>New Sandbox</button>
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
        {active && (
          <>
            <div className="urlbar">
              <button className="btn secondary" onClick={() => navigateCurrent(active.page.history.back(), 'GET')}>Back</button>
              <button className="btn secondary" onClick={() => navigateCurrent(active.page.history.forward(), 'GET')}>Forward</button>
              <input
                ref={urlInputRef}
                type="text"
                value={urlValue}
                placeholder="https://example.com"
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigateCurrent(urlValue); }}
              />
              <button className="btn" onClick={() => { if (urlValue) navigateCurrent(urlValue); }}>Go</button>
            </div>

            <section className="viewer">
              <div className="doc">
                {active.renderedHtml ? (
                  <iframe title="document" srcDoc={active.renderedHtml} />
                ) : active.renderedText ? (
                  <pre>{active.renderedText}</pre>
                ) : (
                  <pre>Enter a URL and press Go to fetch via /fetch.
Also try a media URL below to load through /p.</pre>
                )}
              </div>
            </section>

            <div className="footer">
              <input ref={mediaInputRef} type="text" placeholder="Media URL (image/video/audio)" onKeyDown={(e) => { if (e.key === 'Enter') setMediaUrl((e.target as HTMLInputElement).value); }} />
              <button className="btn" onClick={() => { const v = mediaInputRef.current?.value?.trim(); if (v) setMediaUrl(v); }}>Load Media via /p</button>
              {active.mediaUrl?.length ? <span className="cookies">Proxied media: {active.mediaUrl}</span> : null}
            </div>

            {active.mediaUrl && (
              <div className="doc" style={{ padding: 12 }}>
                {/* naive type check by extension */}
                {/\.(mp4|webm|mov|m4v)$/i.test(active.mediaUrl) ? (
                  <video src={active.mediaUrl} controls style={{ maxWidth: '100%' }} />
                ) : /\.(mp3|wav|ogg)$/i.test(active.mediaUrl) ? (
                  <audio src={active.mediaUrl} controls />
                ) : (
                  <img src={active.mediaUrl} alt="media" style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8 }} />
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default ConnectorApp;
