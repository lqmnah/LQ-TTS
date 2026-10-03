import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
