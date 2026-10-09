import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { errorMessage } from '../api.ts';
import { PATHS, destinationFor, useLogout, useMe, type ReturnState } from '../auth.ts';
import { useBranding } from '../branding.ts';
import { nl } from '../nl.ts';
import { Logo } from './Logo.tsx';
import { ErrorAlert, PageStatus } from './ui.tsx';

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 font-semibold ${isActive ? 'bg-white/10 text-bar-ink' : 'text-bar-muted hover:text-bar-ink'}`;

/**
 * The frame around every staff page, and the guard in front of it: only a full session gets in.
 * Not logged in goes to the login form (remembering the page), a half-way login to its second step.
 */
export function AppLayout() {
  const me = useMe();
  const location = useLocation();
  const { companyName } = useBranding();
  const logout = useLogout();

  if (me.isPending) return <PageStatus />;
  if (me.isLoadingError) return <PageStatus error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data === null || me.data.next !== null) {
    const state: ReturnState = { from: location.pathname + location.search };
    return <Navigate to={destinationFor(me.data, state.from)} replace state={state} />;
  }
  const { user } = me.data;

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        {nl.common.skipToContent}
      </a>
      <header className="bg-bar text-bar-ink">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2.5 font-bold">
            <Logo className="size-8 shrink-0" onDark />
            <span>{companyName}</span>
          </div>
          <nav aria-label={nl.nav.main} className="flex gap-1">
            <NavLink to={PATHS.home} end className={navLink}>
              {nl.nav.jobs}
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <NavLink to={PATHS.account} className={navLink} aria-label={nl.nav.account(user.name)}>
              {user.name}
            </NavLink>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="rounded-lg px-3 py-2 font-semibold text-bar-muted hover:text-bar-ink disabled:opacity-60"
            >
              {logout.isPending ? nl.nav.loggingOut : nl.nav.logout}
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto grid max-w-5xl gap-6 px-4 py-8">
        <ErrorAlert message={logout.isError ? errorMessage(logout.error) : null} />
        <Outlet />
      </main>
    </div>
  );
}
