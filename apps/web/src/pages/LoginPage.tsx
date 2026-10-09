import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { api, errorMessage } from '../api.ts';
import { destinationFor, meQuery, returnPath, useMe, type ReturnState } from '../auth.ts';
import { usePageTitle } from '../branding.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { Button, ErrorAlert, TextField } from '../components/ui.tsx';
import { nl } from '../nl.ts';

/** Step 1: e-mail and password. The answer's `next` decides the following screen. */
export function LoginPage() {
  usePageTitle(nl.login.title);
  const me = useMe();
  const from = returnPath(useLocation().state);

  // Already fully logged in: nothing to do here. A half-way session may start over with a new login.
  if (me.data?.next === null) return <Navigate to={from ?? '/'} replace />;
  return <LoginForm from={from} />;
}

function LoginForm({ from }: { from: string | undefined }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: async (session) => {
      // A 'me' request still in flight from before the login must not overwrite the new session.
      await queryClient.cancelQueries({ queryKey: meQuery.queryKey });
      queryClient.setQueryData(meQuery.queryKey, session);
      await navigate(destinationFor(session, from), { replace: true, state: { from } satisfies ReturnState });
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    login.mutate({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') });
  }

  return (
    <AuthShell title={nl.login.title}>
      <p className="text-muted">{nl.login.intro}</p>
      <form onSubmit={onSubmit} className="grid gap-4">
        <ErrorAlert message={login.isError ? errorMessage(login.error) : null} />
        <TextField
          label={nl.login.email}
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          aria-invalid={login.isError || undefined}
        />
        <TextField
          label={nl.login.password}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={login.isError || undefined}
        />
        <Button type="submit" disabled={login.isPending} className="mt-1 w-full">
          {login.isPending ? nl.login.submitting : nl.login.submit}
        </Button>
      </form>
      <p className="text-sm text-muted">{nl.login.forgotPassword}</p>
    </AuthShell>
  );
}
