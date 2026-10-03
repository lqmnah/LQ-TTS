import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { path: 'voices', element: <VoicesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
