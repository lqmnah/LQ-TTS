import { IconContext } from '@phosphor-icons/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { I18nProvider } from './i18n/index.jsx';
import { SessionProvider } from './lib/session.jsx';
import { routes } from './router.jsx';
import './styles.css';

const router = createBrowserRouter(routes);
const iconDefaults = { size: 20, weight: 'regular', mirrored: false };

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <SessionProvider>
        <IconContext.Provider value={iconDefaults}>
          <RouterProvider router={router} />
        </IconContext.Provider>
      </SessionProvider>
    </I18nProvider>
  </StrictMode>,
);
