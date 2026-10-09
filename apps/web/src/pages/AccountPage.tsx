import { MIN_PASSWORD_LENGTH } from '@scan/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, api, errorMessage } from '../api.ts';
import { PATHS, useSessionUser } from '../auth.ts';
import { usePageTitle } from '../branding.ts';
import { Button, ErrorAlert, PageStatus, TextField, buttonClass } from '../components/ui.tsx';
import { nl } from '../nl.ts';

const card = 'grid gap-4 rounded-card border border-line bg-surface p-6 shadow-card';
const dateTime = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });

/** Your own account: details, two-step verification, password. Admins also see the staff list. */
export function AccountPage() {
  usePageTitle(nl.account.title);
  const user = useSessionUser();
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">{nl.account.title}</h1>
      <section className={card}>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">{nl.account.name}</dt>
          <dd>{user.name}</dd>
          <dt className="text-muted">{nl.account.email}</dt>
          <dd className="break-all">{user.email}</dd>
          <dt className="text-muted">{nl.account.role}</dt>
          <dd>{nl.roles[user.role]}</dd>
          <dt className="text-muted">{nl.account.totp}</dt>
          <dd>{user.totpEnabled ? nl.account.totpOn : nl.common.off}</dd>
        </dl>
        {user.totpEnabled ? null : (
          <div className="grid justify-items-start gap-3 border-t border-line pt-4">
            <p className="max-w-prose text-muted">{nl.account.totpExplain}</p>
            <Link to={PATHS.totpSetup} className={buttonClass('secondary')}>
              {nl.account.totpEnable}
            </Link>
          </div>
        )}
      </section>
      <PasswordForm />
      {user.role === 'admin' ? <StaffList /> : null}
    </>
  );
}

function PasswordForm() {
  const [problem, setProblem] = useState<string | null>(null);
  const change = useMutation({ mutationFn: api.changePassword });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    if (newPassword.length < MIN_PASSWORD_LENGTH) return setProblem(nl.account.passwordTooShort);
    if (newPassword !== form.get('confirmPassword')) return setProblem(nl.account.passwordMismatch);
    setProblem(null);
    change.mutate({ currentPassword, newPassword }, { onSuccess: () => formElement.reset() });
  }

  const failed =
    change.error instanceof ApiError && change.error.code === 'invalid_credentials'
      ? nl.account.wrongCurrentPassword
      : change.isError
        ? errorMessage(change.error)
        : null;

  return (
    <section className={card} aria-labelledby="password-title">
      <h2 id="password-title" className="text-xl font-bold">
        {nl.account.passwordTitle}
      </h2>
      <form onSubmit={onSubmit} className="grid max-w-md gap-4">
        <ErrorAlert message={problem ?? failed} />
        {change.isSuccess && !problem ? (
          <p role="status" className="rounded-lg border border-na/40 bg-na-soft px-3 py-2 text-sm">
            {nl.account.passwordSaved}
          </p>
        ) : null}
        <TextField
          label={nl.account.currentPassword}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <TextField
          label={nl.account.newPassword}
          hint={nl.account.newPasswordHint}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <TextField
          label={nl.account.confirmPassword}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
        <Button type="submit" disabled={change.isPending} className="justify-self-start">
          {change.isPending ? nl.account.passwordSaving : nl.account.passwordSubmit}
        </Button>
      </form>
    </section>
  );
}

function StaffList() {
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  return (
    <section className={card} aria-labelledby="staff-title">
      <h2 id="staff-title" className="text-xl font-bold">
        {nl.account.staffTitle}
      </h2>
      <p className="text-sm text-muted">{nl.account.staffIntro}</p>
      {users.isPending ? (
        <PageStatus />
      ) : users.isError ? (
        <ErrorAlert message={errorMessage(users.error)} />
      ) : (
        <ul className="divide-y divide-line">
          {users.data.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
              <span className="font-semibold">{u.name}</span>
              <span className="break-all text-muted">{u.email}</span>
              <span className="text-sm">{nl.roles[u.role]}</span>
              <span className="text-sm text-muted">
                {u.totpEnabled ? nl.account.staffTotp : nl.account.staffNoTotp}
              </span>
              {u.active ? null : <span className="text-sm text-voor">{nl.account.staffInactive}</span>}
              <span className="ml-auto text-sm text-muted">
                {u.lastLoginAt
                  ? `${nl.account.lastLogin}: ${dateTime.format(new Date(u.lastLoginAt))}`
                  : nl.account.neverLoggedIn}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
