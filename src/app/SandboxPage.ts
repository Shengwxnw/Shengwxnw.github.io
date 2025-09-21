import { CookieStore } from './CookieStore';
import { UrlHistory } from './UrlHistory';

type Init = {
  method?: 'GET' | 'POST' | 'HEAD';
  bodyB64?: string;
  headers?: Record<string, string>;
};

export type DispatchBody = {
  encoding: 'arrayBuffer' | 'base64' | 'text' | 'json' | string;
  data: unknown;
  note?: string;
};

export type DispatchResult = {
  id: string;
  ok: boolean;
  status: number;
  statusText: string;
  durationMs?: number;
  headers?: Record<string, string>;
  finalUrl?: string;
  redirected?: boolean;
  body?: DispatchBody;
  error?: string;
};

type DispatchEnvelope = {
  sid?: string;
  results?: DispatchResult[];
};

export class SandboxPage {
  id: string;
  title: string;
  homeUrl: string;
  cookieStore: CookieStore;
  history: UrlHistory;

  constructor(opts: { id: string; title: string; homeUrl: string; history: UrlHistory; cookieStore: CookieStore }) {
    this.id = opts.id;
    this.title = opts.title;
    this.homeUrl = opts.homeUrl;
    this.history = opts.history;
    this.cookieStore = opts.cookieStore;
  }

  async navigate(target: string, init: Init | undefined, workerBase: string): Promise<DispatchResult> {
    const url = target || this.homeUrl;
    this.history.push(url);
    const payload = {
      sid: this.id,
      pipeline: 'sequential' as const,
      requests: [
        {
          id: 'document',
          target: url,
          method: init?.method ?? 'GET',
          headers: init?.headers ?? { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
          bodyB64: init?.bodyB64,
          responseType: 'text' as const,
        },
      ],
    };
    const body = JSON.stringify(payload);
    const tried = new Set<string>();

    const attempt = async (endpoint: string): Promise<DispatchEnvelope> => {
      tried.add(endpoint);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        mode: endpoint.startsWith('http') ? 'cors' : undefined,
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(`Worker returned ${res.status}`);
      }
      this.cookieStore.applyFromHeader(res.headers.get('x-set-cookie'));
      return (await res.json()) as DispatchEnvelope;
    };

    let json: DispatchEnvelope;
    try {
      json = await attempt('/dispatch');
    } catch (err) {
      const endpoint = new URL('/dispatch', workerBase).toString();
      if (tried.has(endpoint)) {
        throw err;
      }
      json = await attempt(endpoint);
    }
    const entry = json.results?.[0];
    if (!entry) {
      throw new Error('Empty dispatch response');
    }
    if (entry.status === 0 && !entry.ok) {
      throw new Error(entry.error || 'Upstream fetch error');
    }
    if (entry.finalUrl) {
      this.history.replace(entry.finalUrl);
    }
    return entry;
  }
}
