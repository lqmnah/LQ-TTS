import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export const routes = [
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
