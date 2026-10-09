import { ERROR_CODES } from '@scan/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nl } from '../nl.ts';
import { formatSecret } from '../pages/TotpSetupPage.tsx';
import { admin, fakeApi, operator, renderApp, unauthenticated } from './render.tsx';

describe('login', () => {
  it('sends a visitor without a session to the login form', async () => {
    fakeApi({ 'GET /api/auth/me': unauthenticated });
    const router = renderApp('/account');
    expect(await screen.findByRole('heading', { name: nl.login.title })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('shows the Dutch message for wrong credentials', async () => {
    fakeApi({
      'GET /api/auth/me': unauthenticated,
      'POST /api/auth/login': () => ({ status: 401, body: { error: { code: 'invalid_credentials' } } }),
    });
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(nl.login.email), 'jan@example.nl');
    await user.type(screen.getByLabelText(nl.login.password), 'verkeerd');
    await user.click(screen.getByRole('button', { name: nl.login.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(nl.errors.invalid_credentials);
  });

  it('continues to the code screen when the server asks for TOTP', async () => {
    const calls = fakeApi({
      'GET /api/auth/me': unauthenticated,
      'POST /api/auth/login': () => ({ status: 200, body: { user: admin, next: 'totp' } }),
      'POST /api/auth/totp/verify': () => ({ status: 200, body: { user: admin, next: null } }),
    });
    const router = renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(nl.login.email), 'admin@example.nl');
    await user.type(screen.getByLabelText(nl.login.password), 'een lang wachtwoord');
    await user.click(screen.getByRole('button', { name: nl.login.submit }));

    expect(await screen.findByRole('heading', { name: nl.totpCode.title })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login/code');
    // Pasting "123 456" from an authenticator app works: the space is dropped, all six digits stay.
    await user.click(screen.getByLabelText(nl.totpCode.code));
    await user.paste('123 456');
    expect(screen.getByLabelText(nl.totpCode.code)).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: nl.totpCode.submit }));
    expect(await screen.findByRole('heading', { name: nl.jobs.title })).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /api/auth/totp/verify')?.body).toEqual({ code: '123456' });
  });
});

describe('two-step setup', () => {
  it('shows the secret in groups of 4 and enables TOTP with the first code', async () => {
    const pending = { ...admin, totpEnabled: false };
    let enabled = false;
    const calls = fakeApi({
      'GET /api/auth/me': () =>
        enabled
          ? { status: 200, body: { user: admin, next: null } }
          : { status: 200, body: { user: pending, next: 'totp_setup' } },
      'POST /api/auth/totp/setup': () => ({
        status: 200,
        body: {
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/Bedrijfsnaam:admin%40example.nl?secret=JBSWY3DPEHPK3PXP',
        },
      }),
      'POST /api/auth/totp/enable': () => {
        enabled = true;
        return { status: 200, body: { user: admin, next: null } };
      },
    });
    renderApp('/login/tweestaps');
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: nl.totpSetup.qrLabel })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(nl.totpSetup.code), '654321');
    await user.click(screen.getByRole('button', { name: nl.totpSetup.submit }));
    expect(await screen.findByRole('heading', { name: nl.jobs.title })).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /api/auth/totp/enable')?.body).toEqual({ code: '654321' });
  });

  it('formats secrets for typing over', () => {
    expect(formatSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});

describe('logged in', () => {
  it('shows the Opdrachten page and the user in the header', async () => {
    fakeApi({ 'GET /api/auth/me': () => ({ status: 200, body: { user: operator, next: null } }) });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: nl.jobs.title })).toBeInTheDocument();
    expect(screen.getByText(nl.jobs.emptyTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: nl.nav.account(operator.name) })).toBeInTheDocument();
  });

  it('lets an admin see the staff list, and an operator not', async () => {
    fakeApi({
      'GET /api/auth/me': () => ({ status: 200, body: { user: admin, next: null } }),
      'GET /api/users': () => ({
        status: 200,
        body: {
          users: [
            { ...admin, active: true, lastLoginAt: null },
            { ...operator, active: false, lastLoginAt: '2026-10-09T08:00:00.000Z' },
          ],
        },
      }),
    });
    renderApp('/account');
    expect(await screen.findByRole('heading', { name: nl.account.staffTitle })).toBeInTheDocument();
    expect(await screen.findByText(operator.email)).toBeInTheDocument();
    expect(screen.getByText(nl.account.staffInactive)).toBeInTheDocument();
  });

  it('checks the new password before sending it', async () => {
    const calls = fakeApi({
      'GET /api/auth/me': () => ({ status: 200, body: { user: operator, next: null } }),
      'POST /api/auth/password': () => ({ status: 204 }),
    });
    renderApp('/account');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(nl.account.currentPassword), 'oud wachtwoord');
    await user.type(screen.getByLabelText(nl.account.newPassword), 'een nieuw lang wachtwoord');
    await user.type(screen.getByLabelText(nl.account.confirmPassword), 'iets anders dan dat');
    await user.click(screen.getByRole('button', { name: nl.account.passwordSubmit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(nl.account.passwordMismatch);
    expect(calls.some((c) => c.key === 'POST /api/auth/password')).toBe(false);

    await user.clear(screen.getByLabelText(nl.account.confirmPassword));
    await user.type(screen.getByLabelText(nl.account.confirmPassword), 'een nieuw lang wachtwoord');
    await user.click(screen.getByRole('button', { name: nl.account.passwordSubmit }));
    expect(await screen.findByText(nl.account.passwordSaved)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/auth/password')).toBe(true));
  });
});

describe('texts', () => {
  it('has Dutch text for every error code the server can send', () => {
    for (const code of ERROR_CODES) expect(nl.errors[code], code).toMatch(/\w/);
  });
});
