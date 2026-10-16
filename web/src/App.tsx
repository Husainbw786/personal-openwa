import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { Spinner, ToastHost, useRoute } from './ui';
import Login from './screens/Login';
import Connect from './screens/Connect';
import Groups from './screens/Groups';
import Lists from './screens/Lists';
import GroupDetail from './screens/GroupDetail';
import Templates from './screens/Templates';
import History from './screens/History';
import More from './screens/More';

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
  else if (route === '/lists') screen = <Lists route={route} navigate={navigate} />;
  else if (route === '/templates') screen = <Templates route={route} navigate={navigate} />;
  else if (route === '/history') screen = <History route={route} navigate={navigate} />;
  else if (route === '/more') screen = <More navigate={navigate} onLogout={() => setLoggedIn(false)} />;
  else if (route === '/connect') screen = <Connect navigate={navigate} />;
  else screen = <Groups route={route} navigate={navigate} />;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col bg-white shadow-sm">
      <main className="flex-1 pb-24">{screen}</main>
      <ToastHost />
    </div>
  );
}
