import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { TOTP } from 'otpauth';
import { nl } from '../apps/web/src/nl.ts';

/**
 * The whole M0 login story in a real browser against the real API and database:
 * first admin from the environment -> forced two-step setup -> Opdrachten -> logout -> login with a code.
 * Both projects (desktop, phone) share one fresh database per run, so the test looks at the screen it
 * gets: the first project sets TOTP up, the next one logs in with a code. The secret and the last used
 * time step are kept in a file, because each project runs in its own worker process.
 */
const ADMIN = { email: 'admin@example.nl', password: 'e2e-admin-wachtwoord', name: 'Anne Beheerder' };
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.results', 'totp-state.json');
type TotpState = { secret: string; lastStep: number };

const stepNow = () => Math.floor(Date.now() / 30_000);

/** A code for a time step that has not been used yet; the server accepts one step of drift and no replays. */
async function nextCode(page: Page, state: TotpState): Promise<string> {
  const step = Math.max(stepNow() - 1, state.lastStep + 1);
  while (step > stepNow() + 1) await page.waitForTimeout(2_000);
  state.lastStep = step;
  await writeFile(STATE_FILE, JSON.stringify(state));
  return new TOTP({ secret: state.secret, digits: 6, period: 30, algorithm: 'SHA1' }).generate({
    timestamp: step * 30_000 + 1_000,
  });
}

async function login(page: Page, password = ADMIN.password, email = ADMIN.email) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: nl.login.title, exact: true })).toBeVisible();
  await page.getByLabel(nl.login.email).fill(email);
  await page.getByLabel(nl.login.password).fill(password);
  await page.getByRole('button', { name: nl.login.submit }).click();
}

async function enterCode(page: Page, state: TotpState) {
  await expect(page.getByRole('heading', { name: nl.totpCode.title, exact: true })).toBeVisible();
  await page.getByLabel(nl.totpCode.code).fill(await nextCode(page, state));
  await page.getByRole('button', { name: nl.totpCode.submit }).click();
  await expect(page.getByRole('heading', { name: nl.jobs.title, exact: true })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('wrong password shows a Dutch error', async ({ page }) => {
  // Another e-mail address, so this does not count towards the admin's login rate limit (5 a minute).
  await login(page, 'helemaal verkeerd', 'onbekend@example.nl');
  await expect(page.getByRole('alert')).toHaveText(nl.errors.invalid_credentials);
});

test('admin sets up two-step verification once, then logs in with codes', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  const setupHeading = page.getByRole('heading', { name: nl.totpSetup.title, exact: true });
  await expect(setupHeading.or(page.getByRole('heading', { name: nl.totpCode.title, exact: true }))).toBeVisible();
  let state: TotpState;
  if (await setupHeading.isVisible()) {
    // First login ever: the admin has to set up TOTP before anything else.
    await expect(page.getByRole('img', { name: nl.totpSetup.qrLabel })).toBeVisible();
    state = { secret: (await page.locator('p.font-mono').innerText()).replace(/\s/g, ''), lastStep: 0 };
    await page.getByLabel(nl.totpSetup.code).fill(await nextCode(page, state));
    await page.getByRole('button', { name: nl.totpSetup.submit }).click();
    await expect(page.getByRole('heading', { name: nl.jobs.title, exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  } else {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8')) as TotpState;
    await enterCode(page, state);
  }
  await expect(page.getByText(nl.jobs.emptyTitle)).toBeVisible();

  await page.getByRole('link', { name: nl.nav.account(ADMIN.name) }).click();
  await expect(page.getByRole('heading', { name: nl.account.staffTitle, exact: true })).toBeVisible();
  await expect(page.getByText(nl.account.staffTotp)).toBeVisible();

  await page.getByRole('button', { name: nl.nav.logout }).click();
  await expect(page.getByRole('heading', { name: nl.login.title, exact: true })).toBeVisible();
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: nl.login.title, exact: true })).toBeVisible();

  await login(page);
  await enterCode(page, state);
});
