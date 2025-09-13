export type SandboxSettings = {
  sessionId: string; // sid
  corsMode: 'pinned' | 'star';
  rewriteMode: 'auto' | 'off';
};

import { CookieStore } from './CookieStore';
import { UrlHistory } from './UrlHistory';

type Init = {
  method?: 'GET' | 'POST' | 'HEAD';
  bodyB64?: string;
  headers?: Record<string, string>;
};

export class SandboxPage {
  id: string;
  title: string;
  homeUrl: string;
  cookieStore: CookieStore;
  history: UrlHistory;
  settings: SandboxSettings;

  constructor(opts: { id: string; title: string; homeUrl: string; history: UrlHistory; cookieStore: CookieStore }) {
    this.id = opts.id;
    this.title = opts.title;
    this.homeUrl = opts.homeUrl;
    this.history = opts.history;
    this.cookieStore = opts.cookieStore;
    this.settings = { sessionId: opts.id, corsMode: 'pinned', rewriteMode: 'off' };
  }

  async navigate(target: string, init?: Init): Promise<Response> {
    const url = target || this.homeUrl;
    this.history.push(url);
    const payload = {
      sid: this.id,
      target: url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? { 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' },
      bodyB64: init?.bodyB64,
    };
    // Use same-origin /fetch, Service Worker rewrites to Worker base
    const res = await fetch('/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Worker returned ${res.status}`);
    }
    return res;
  }

  // renderDocument is handled in UI; kept for parity
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  renderDocument(_resp: Response): void {
    // no-op here; UI layer renders based on Content-Type
  }
}
