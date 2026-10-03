import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import JobPage from './pages/JobPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import TtsPage from './pages/TtsPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <TtsPage /> },
      { path: 'jobs/:id', element: <JobPage /> },
      { path: 'voices', element: <VoicesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
