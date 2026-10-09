import type { MeResponse } from '@scan/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { api, errorMessage } from '../api.ts';
import { PATHS, destinationFor, meQuery, returnPath, useLogout, useMe } from '../auth.ts';
import { usePageTitle } from '../branding.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { QrCode } from '../components/QrCode.tsx';
import { Button, CodeField, ErrorAlert, PageStatus, buttonClass } from '../components/ui.tsx';
import { nl } from '../nl.ts';

/**
 * TOTP setup. Two ways in:
 * - required: an admin without TOTP logs in and the server answers next = 'totp_setup';
 * - opt-in: a logged-in user without TOTP (usually an operator) clicks the button on /account.
 */
export function TotpSetupPage() {
  usePageTitle(nl.totpSetup.title);
  const me = useMe();
  const from = returnPath(useLocation().state);
  // Where to go once setup succeeded. Decided here, before the updated session re-runs the checks
  // below, which would otherwise send a just-finished admin to /account instead of the app.
  const [done, setDone] = useState<string | null>(null);

  if (done) return <Navigate to={done} replace />;
  if (me.isPending) return <PageStatus />;
  if (me.isLoadingError) return <PageStatus error={me.error} onRetry={() => void me.refetch()} />;

  const session = me.data;
  const required = session?.next === 'totp_setup';
  const optIn = session?.next === null && !session.user.totpEnabled;
  if (!required && !optIn) {
    // Not logged in, a code is due first, or TOTP is already on.
    return <Navigate to={session?.next === null ? PATHS.account : destinationFor(session, from)} replace />;
  }
  return <TotpSetup required={required} from={from} onDone={setDone} />;
}

/** Groups the base32 secret in blocks of 4 for typing it over: "JBSW Y3DP EHPK 3PXP". */
export function formatSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? '';
}

function TotpSetup({
  required,
  from,
  onDone,
}: {
  required: boolean;
  from: string | undefined;
  onDone: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const logout = useLogout();
  const [code, setCode] = useState('');
  const [incomplete, setIncomplete] = useState(false);

  // A query (not a mutation) so the setup request runs once per visit, also under StrictMode.
  // gcTime 0: leaving the screen forgets the secret; coming back starts a fresh setup.
  const setup = useQuery({
    queryKey: ['totp-setup'],
    queryFn: api.totpSetup,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  const enable = useMutation({
    mutationFn: api.totpEnable,
    onSuccess: async (newSession) => {
      await queryClient.cancelQueries({ queryKey: meQuery.queryKey });
      // Use the server's new session state when it sends one; otherwise assume TOTP is on and the
      // session is complete, and let the refetch below correct that if the server disagrees.
      const session = queryClient.setQueryData<MeResponse | null>(
        meQuery.queryKey,
        (old) => newSession ?? (old ? { user: { ...old.user, totpEnabled: true }, next: null } : null),
      );
      onDone(required ? destinationFor(session ?? null, from) : PATHS.account);
      void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setIncomplete(code.length !== 6);
    if (code.length === 6) enable.mutate({ code });
  }

  const error = incomplete ? nl.codeFormat : enable.isError ? errorMessage(enable.error) : null;

  return (
    <AuthShell title={nl.totpSetup.title} wide>
      <div className="grid gap-2 text-muted">
        {required ? <p>{nl.totpSetup.introRequired}</p> : null}
        <p>{nl.totpSetup.intro}</p>
      </div>

      {setup.isPending ? (
        <p role="status" className="text-muted">
          {nl.totpSetup.loadingQr}
        </p>
      ) : setup.isError ? (
        <div className="grid justify-items-start gap-3">
          <ErrorAlert message={errorMessage(setup.error)} />
          <Button variant="secondary" onClick={() => void setup.refetch()}>
            {nl.common.retry}
          </Button>
        </div>
      ) : (
        <>
          <QrCode
            value={setup.data.otpauthUrl}
            label={nl.totpSetup.qrLabel}
            className="mx-auto size-52 rounded-lg border border-line"
          />
          <div className="grid gap-1">
            <p className="text-sm text-muted">{nl.totpSetup.manualEntry}</p>
            <p className="font-mono text-lg tracking-wider break-words select-all" translate="no">
              {formatSecret(setup.data.secret)}
            </p>
          </div>
          <form onSubmit={onSubmit} className="grid gap-4">
            <ErrorAlert message={error} />
            <CodeField label={nl.totpSetup.code} value={code} onChange={setCode} invalid={error !== null} />
            <Button type="submit" disabled={enable.isPending} className="w-full">
              {enable.isPending ? nl.totpSetup.submitting : nl.totpSetup.submit}
            </Button>
          </form>
        </>
      )}

      {required ? (
        <>
          <ErrorAlert message={logout.isError ? errorMessage(logout.error) : null} />
          <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? nl.nav.loggingOut : nl.totpSetup.logout}
          </Button>
        </>
      ) : (
        <Link to={PATHS.account} className={buttonClass('secondary')}>
          {nl.totpSetup.cancel}
        </Link>
      )}
    </AuthShell>
  );
}
