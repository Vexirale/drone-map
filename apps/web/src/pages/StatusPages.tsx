import { Link, useRouteError } from 'react-router';
import { usePageTitle } from '../branding.ts';
import { buttonClass } from '../components/ui.tsx';
import { nl } from '../nl.ts';

export function NotFoundPage() {
  usePageTitle(nl.notFound.title);
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <h1 className="text-2xl font-bold">{nl.notFound.title}</h1>
        <p className="text-muted">{nl.notFound.text}</p>
        <Link to="/" className={buttonClass()}>
          {nl.notFound.home}
        </Link>
      </div>
    </main>
  );
}

/** Shown when a page throws while rendering. The error goes to the console for the developer. */
export function CrashPage() {
  const error = useRouteError();
  console.error(error);
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div role="alert" className="grid max-w-md justify-items-center gap-4 text-center">
        <h1 className="text-2xl font-bold">{nl.crash.title}</h1>
        <p className="text-muted">{nl.crash.text}</p>
        <button type="button" className={buttonClass()} onClick={() => window.location.reload()}>
          {nl.crash.reload}
        </button>
      </div>
    </main>
  );
}
