type CookieRecord = {
  raw: string;
  lastSeen: string;
};

export class CookieStore {
  private key: string;
  private jar: Record<string, CookieRecord> = {};

  constructor(sessionId: string) {
    this.key = `cookies:${sessionId}`;
    this.load();
  }

  applyFromHeader(xSetCookie: string | null | undefined) {
    if (!xSetCookie) return;
    const chunks = xSetCookie.split(',');
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        const decoded = decodeURIComponent(trimmed);
        const [namePart] = decoded.split(';', 1);
        const [cookieName] = namePart?.split('=', 1) ?? [];
        if (cookieName) {
          this.jar[cookieName.trim()] = { raw: decoded, lastSeen: now };
        }
      } catch {
        // ignore parse errors per cookie
      }
    }
    this.save();
  }

  getDisplay(host?: string): string[] {
    void host; // host filtering not implemented but kept for API shape
    const entries = Object.values(this.jar);
    if (!entries.length) return [];
    return entries
      .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
      .map(entry => `${entry.lastSeen} — ${entry.raw}`);
  }

  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.jar = parsed as Record<string, CookieRecord>;
        }
      }
    } catch {
      this.jar = {};
    }
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.jar)); } catch { /* no-op */ }
  }
}

