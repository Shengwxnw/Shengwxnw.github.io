export class CookieStore {
  private key: string;
  private jar: Record<string, string> = {};

  constructor(sessionId: string) {
    this.key = `cookies:${sessionId}`;
    this.load();
  }

  applyFromHeader(xSetCookie: string | null | undefined) {
    if (!xSetCookie) return;
    // X-Set-Cookie is URL-encoded by the Worker; decode and store raw for display.
    try {
      const decoded = decodeURIComponent(xSetCookie);
      // Very naive: store under a synthetic host bucket
      const now = new Date().toISOString();
      this.jar[now] = decoded;
      this.save();
    } catch {
      // ignore parse errors
    }
  }

  getDisplay(host?: string): string[] {
    const entries = Object.entries(this.jar);
    if (!entries.length) return [];
    return entries.map(([k, v]) => `${k}: ${v}`);
  }

  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.jar = JSON.parse(raw);
    } catch {
      this.jar = {};
    }
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.jar)); } catch { /* no-op */ }
  }
}

