import { useEffect, useState } from 'react';

/**
 * The service worker downloads new versions in the background. When one is ready we offer a
 * restart; if you ignore it, the next time you open the app you're on the new version anyway.
 */
export default function UpdateBanner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => { if (e.data === 'update-ready') setReady(true); };
    navigator.serviceWorker.addEventListener('message', onMessage);
    // Coming back to the app after a while: look for a new version (and a new service worker).
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker.controller?.postMessage('check-update');
      void navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!ready) return null;
  return (
    <div className="fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-50 flex justify-center px-4">
      <div role="status" className="flex items-center gap-3 rounded-full bg-[#323739] py-2 pl-5 pr-2 text-sm text-white shadow-lg">
        New version ready
        <button onClick={() => window.location.reload()} className="rounded-full bg-accent px-4 py-1.5 font-semibold text-[#0a3d33]">Restart</button>
        <button onClick={() => setReady(false)} aria-label="Later" className="px-2 text-white/70">Later</button>
      </div>
    </div>
  );
}
