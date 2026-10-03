import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import CreditsPage from './pages/CreditsPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
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
      { path: 'history', element: <HistoryPage /> },
      { path: 'credits', element: <CreditsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
