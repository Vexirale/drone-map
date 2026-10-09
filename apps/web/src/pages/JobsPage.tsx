import { usePageTitle } from '../branding.ts';
import { nl } from '../nl.ts';

/** "Opdrachten". Jobs arrive in M1; until then an honest empty state, no fake data. */
export function JobsPage() {
  usePageTitle(nl.jobs.title);
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">{nl.jobs.title}</h1>
      <section className="grid justify-items-center gap-3 rounded-card border border-dashed border-line bg-surface px-6 py-14 text-center">
        <svg viewBox="0 0 48 48" aria-hidden="true" className="size-12 text-muted">
          <path
            d="M8 20 24 7l16 13v19a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path d="M19 41V28h10v13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        </svg>
        <h2 className="text-xl font-bold">{nl.jobs.emptyTitle}</h2>
        <p className="max-w-prose text-muted">{nl.jobs.emptyText}</p>
      </section>
    </>
  );
}
