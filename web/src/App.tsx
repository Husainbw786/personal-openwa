import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { clearCache } from './cache';
import { preloadEverything } from './preload';
import { Spinner, ToastHost, useRoute } from './ui';
import UpdateBanner from './screens/UpdateBanner';
import Login from './screens/Login';
import Connect from './screens/Connect';
import Groups from './screens/Groups';
import Lists from './screens/Lists';
import GroupDetail from './screens/GroupDetail';
import Templates from './screens/Templates';
import History from './screens/History';
import More from './screens/More';

export default function App() {
  // Open straight into the app if you were logged in last time; the server still checks every call.
  const [loggedIn, setLoggedInState] = useState<boolean | null>(() => (rememberedLogin() ? true : null));
  const [route, navigate] = useRoute();

  function setLoggedIn(value: boolean) {
    setLoggedInState(value);
    try { localStorage.setItem('wa-loggedIn', value ? '1' : '0'); } catch { /* private mode */ }
    if (!value) clearCache();
  }

  useEffect(() => {
    setUnauthorizedHandler(() => setLoggedIn(false));
    api<{ loggedIn: boolean }>('/api/me')
      .then((r) => setLoggedIn(r.loggedIn))
      .catch(() => { if (!rememberedLogin()) setLoggedIn(false); }); // offline: keep showing the cached app
  }, []);

  // Once logged in, quietly preload what you're likely to open next (and again when you come back).
  useEffect(() => {
    if (!loggedIn) return;
    void preloadEverything();
    const onVisible = () => { if (document.visibilityState === 'visible') void preloadEverything(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loggedIn]);

  if (loggedIn === null) return <Spinner />;
  if (!loggedIn) return <Login onDone={() => setLoggedIn(true)} />;

  let screen;
  if (route.startsWith('/groups/')) screen = <GroupDetail key={route} source={{ kind: 'group', id: decodeURIComponent(route.slice('/groups/'.length)) }} navigate={navigate} />;
  else if (route.startsWith('/lists/')) screen = <GroupDetail key={route} source={{ kind: 'list', id: Number(route.slice('/lists/'.length)) }} navigate={navigate} />;
  else if (route === '/lists') screen = <Lists route={route} navigate={navigate} />;
  else if (route === '/templates') screen = <Templates route={route} navigate={navigate} />;
  else if (route === '/history') screen = <History route={route} navigate={navigate} />;
  else if (route === '/more') screen = <More navigate={navigate} onLogout={() => setLoggedIn(false)} />;
  else if (route === '/connect') screen = <Connect navigate={navigate} />;
  else screen = <Groups route={route} navigate={navigate} />;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col bg-white shadow-sm">
      <main className="flex-1 pb-24">{screen}</main>
      <UpdateBanner />
      <ToastHost />
    </div>
  );
}

function rememberedLogin(): boolean {
  try { return localStorage.getItem('wa-loggedIn') === '1'; } catch { return false; }
}
