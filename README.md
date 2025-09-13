Connector Router UI

Light themed, chat-style sandboxed browser-in-browser client that proxies all network via a Cloudflare Worker using two endpoints: GET /p and POST /fetch. Built with React + Vite + TypeScript and a Service Worker that rewrites app-origin requests to the Worker base.

Quick start
- Copy .env.example to .env and set VITE_WORKER_BASE
- npm i
- npm run dev

Build and deploy
- npm run build
- Push to dev; GitHub Actions publishes dist to gh-pages

Structure
- src/app: SandboxPage.ts, CookieStore.ts, UrlHistory.ts
- src/ui: ConnectorApp.tsx (UI)
- src/sw: proxy-sw.ts (service worker)

Config
- VITE_WORKER_BASE must be the Worker origin, e.g. https://<subdomain>.workers.dev

