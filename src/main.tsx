import React from 'react';
import { createRoot } from 'react-dom/client';
import ConnectorApp from './ui/ConnectorApp';
import './styles.css';

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      // Use built asset from /public for production
      const reg = await navigator.serviceWorker.register('/proxy-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      // Send config to SW (worker base URL)
      const workerBase = (localStorage.getItem('workerBase') || (import.meta.env.VITE_WORKER_BASE as string | undefined)) as string | undefined;
      if (reg.active && workerBase) {
        reg.active.postMessage({ type: 'config', workerBase });
        reg.active.postMessage({ type: 'warmup' });
      } else if (workerBase) {
        navigator.serviceWorker.controller?.postMessage({ type: 'config', workerBase });
        navigator.serviceWorker.controller?.postMessage({ type: 'warmup' });
      }
    } catch (e) {
      console.warn('Service worker registration failed:', e);
    }
  }
}

registerSW();

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><ConnectorApp /></React.StrictMode>);
