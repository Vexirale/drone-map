import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { api, errorMessage } from '../api.ts';
import { destinationFor, meQuery, returnPath, useLogout, useMe, type ReturnState } from '../auth.ts';
import { usePageTitle } from '../branding.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { Button, CodeField, ErrorAlert, PageStatus } from '../components/ui.tsx';
import { nl } from '../nl.ts';

/** Step 2 for users with TOTP: the 6-digit code from the authenticator app. */
export function TotpCodePage() {
  usePageTitle(nl.totpCode.title);
  const me = useMe();
  const from = returnPath(useLocation().state);

  if (me.isPending) return <PageStatus />;
  if (me.isError) return <PageStatus error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data?.next !== 'totp') {
    return <Navigate to={destinationFor(me.data, from)} replace state={{ from } satisfies ReturnState} />;
  }
  return <TotpCodeForm from={from} />;
}

function TotpCodeForm({ from }: { from: string | undefined }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();
  const [code, setCode] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const verify = useMutation({
    mutationFn: api.totpVerify,
    onSuccess: async (session) => {
      await queryClient.cancelQueries({ queryKey: meQuery.queryKey });
      queryClient.setQueryData(meQuery.queryKey, session);
      await navigate(destinationFor(session, from), { replace: true });
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setIncomplete(code.length !== 6);
    if (code.length === 6) verify.mutate({ code });
  }

  const error = incomplete ? nl.codeFormat : verify.isError ? errorMessage(verify.error) : null;

  return (
    <AuthShell title={nl.totpCode.title}>
      <p className="text-muted">{nl.totpCode.intro}</p>
      <form onSubmit={onSubmit} className="grid gap-4">
        <ErrorAlert message={error} />
        <CodeField label={nl.totpCode.code} value={code} onChange={setCode} invalid={error !== null} autoFocus />
        <Button type="submit" disabled={verify.isPending} className="w-full">
          {verify.isPending ? nl.totpCode.submitting : nl.totpCode.submit}
        </Button>
      </form>
      <ErrorAlert message={logout.isError ? errorMessage(logout.error) : null} />
      <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {logout.isPending ? nl.nav.loggingOut : nl.totpCode.cancel}
      </Button>
    </AuthShell>
  );
}
