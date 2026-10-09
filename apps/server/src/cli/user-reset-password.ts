import { parseArgs } from 'node:util';
import { email as emailSchema } from '@scan/shared';
import { generatePassword } from '../auth/password.ts';
import { loadConfig } from '../config.ts';
import { createDatabase } from '../db/client.ts';
import { findUserIdByEmail, resetPassword } from '../users.ts';

/**
 * New password for someone who forgot theirs; ends all their sessions.
 *   pnpm user:reset-password --email jan@bedrijfsnaam.nl
 * Prints the generated password once; hand it over safely and let them change it under "Je account".
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
    const password = generatePassword();
    await resetPassword(db, id, password, null);
    console.log(`new password for ${parsed.data} (shown once, hand it over safely): ${password}`);
    console.log('all their sessions were ended');
  }
} finally {
  await pool.end();
}
