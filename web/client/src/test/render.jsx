import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { I18nProvider } from '../i18n/index.jsx';
import { SessionProvider } from '../lib/session.jsx';

export const ME = {
  id: 'u1',
  name: 'Rara Wibisono',
  email: 'rara@example.com',
  plan: 'free',
  paid: false,
  lang: 'id',
  balance: 240,
  voiceLimit: 3,
  voiceCount: 1,
  topupUrl: 'https://demo.lq-studio.com/upgrade-plan',
};

export function renderRoutes(routes, { path = '/', me = ME, lang = 'id', session } = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const initial = session ?? (me ? { status: 'authed', me, error: null } : { status: 'anon', me: null, error: null });
  const utils = render(
    <I18nProvider initialLang={lang}>
      <SessionProvider initial={initial}>
        <RouterProvider router={router} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { ...utils, router };
}
