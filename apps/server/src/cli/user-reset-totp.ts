import { parseArgs } from 'node:util';
import { email as emailSchema } from '@scan/shared';
import { loadConfig } from '../config.ts';
import { createDatabase } from '../db/client.ts';
import { findUserIdByEmail, resetTotp } from '../users.ts';

/**
 * Clears two-step verification for someone who lost their phone, and logs them out everywhere.
 *   pnpm user:reset-totp --email jan@bedrijfsnaam.nl
 * Admins must set it up again at their next login.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { email: { type: 'string' } },
});
const parsed = emailSchema.safeParse(values.email ?? '');
if (!parsed.success) {
  console.error('--email is missing or not a valid e-mail address');
  process.exit(1);
}

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl, 'scan-cli');
try {
  const id = await findUserIdByEmail(db, parsed.data);
  if (!id) {
    console.error(`no user with e-mail ${parsed.data}`);
    process.exitCode = 1;
  } else {
    await resetTotp(db, id, null);
    console.log(`two-step verification cleared for ${parsed.data}; all their sessions were ended`);
  }
} finally {
  await pool.end();
}
