import type { RouteObject } from 'react-router';
import { PATHS } from './auth.ts';
import { AppLayout } from './components/AppLayout.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { JobsPage } from './pages/JobsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { CrashPage, NotFoundPage } from './pages/StatusPages.tsx';
import { TotpCodePage } from './pages/TotpCodePage.tsx';
import { TotpSetupPage } from './pages/TotpSetupPage.tsx';

/** All routes, shared by the browser router (main.tsx) and the memory router in tests. */
export const routes: RouteObject[] = [
  {
    errorElement: <CrashPage />,
    children: [
      { path: PATHS.login, element: <LoginPage /> },
      { path: PATHS.totp, element: <TotpCodePage /> },
      { path: PATHS.totpSetup, element: <TotpSetupPage /> },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <JobsPage /> },
          { path: PATHS.account, element: <AccountPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
