import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import App from './App';
import './index.css';
import { APP_BUILD, consumeUpdatePendingFlag, startAppUpdateWatcher } from './lib/appUpdate';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register service worker for offline support (production only)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // ?v=<buildId> gives each deploy a distinct worker URL, so the browser
    // notices a new worker and the worker can scope its cache per build.
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(APP_BUILD.buildId)}`)
      .then((reg) => {
        // Only hand control to a waiting worker when this load came from an
        // accepted update. Otherwise it waits until every old tab is gone —
        // which is exactly what keeps a running shift on a consistent bundle.
        if (!consumeUpdatePendingFlag()) return;
        const takeOver = () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
        takeOver();
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', takeOver);
        });
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  });
  startAppUpdateWatcher();
} else if ('serviceWorker' in navigator && import.meta.env.DEV) {
  // Unregister any existing SW in dev to prevent stale caches
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((r) => r.unregister());
  });
}
