import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { Spinner, ToastHost, useRoute } from './ui';
import Login from './screens/Login';
import Connect from './screens/Connect';
import Groups from './screens/Groups';
import GroupDetail from './screens/GroupDetail';
import Templates from './screens/Templates';
import History from './screens/History';
import More from './screens/More';
import QueueBar from './screens/QueueBar';

const TABS = [
  { path: '/groups', label: 'Groups', icon: 'M17 20h5v-2a4 4 0 00-5-3.9M9 20H2v-2a4 4 0 015-3.9m10-4.1a3 3 0 11-6 0 3 3 0 016 0zM7 10a3 3 0 11-6 0 3 3 0 016 0z' },
  { path: '/templates', label: 'Templates', icon: 'M8 10h8M8 14h5M5 4h14a1 1 0 011 1v11a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z' },
  { path: '/history', label: 'History', icon: 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { path: '/more', label: 'More', icon: 'M4 6h16M4 12h16M4 18h16' },
];

export default function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [route, navigate] = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => setLoggedIn(false));
    api<{ loggedIn: boolean }>('/api/me').then((r) => setLoggedIn(r.loggedIn)).catch(() => setLoggedIn(false));
  }, []);

  if (loggedIn === null) return <Spinner />;
  if (!loggedIn) return <Login onDone={() => setLoggedIn(true)} />;

  let screen;
  if (route.startsWith('/groups/')) screen = <GroupDetail key={route} source={{ kind: 'group', id: decodeURIComponent(route.slice('/groups/'.length)) }} navigate={navigate} />;
  else if (route.startsWith('/lists/')) screen = <GroupDetail key={route} source={{ kind: 'list', id: Number(route.slice('/lists/'.length)) }} navigate={navigate} />;
  else if (route === '/templates') screen = <Templates />;
  else if (route === '/history') screen = <History />;
  else if (route === '/more') screen = <More navigate={navigate} onLogout={() => setLoggedIn(false)} />;
  else if (route === '/connect') screen = <Connect navigate={navigate} />;
  else screen = <Groups navigate={navigate} />;

  const hideNav = route.startsWith('/groups/') || route.startsWith('/lists/');

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col bg-surface">
      <main className={`flex-1 ${hideNav ? '' : 'pb-20'}`}>
        <QueueBar navigate={navigate} onConnectScreen={route === '/connect'} />
        {screen}
      </main>
      {!hideNav && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto flex max-w-2xl">
            {TABS.map((t) => {
              const active = route === t.path || (t.path === '/more' && route === '/connect');
              return (
                <button key={t.path} onClick={() => navigate(t.path)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${active ? 'text-brand font-semibold' : 'text-gray-500'}`}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <ToastHost />
    </div>
  );
}
