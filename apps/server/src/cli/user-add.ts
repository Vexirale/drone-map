import { parseArgs } from 'node:util';
import { ROLES, email as emailSchema, type Role } from '@scan/shared';
import { MIN_PASSWORD_LENGTH, generatePassword } from '../auth/password.ts';
import { loadConfig } from '../config.ts';
import { createDatabase } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { createUser } from '../users.ts';

/**
 * Adds a staff user.
 *   pnpm user:add --email jan@bedrijfsnaam.nl --name "Jan" --role operator
 *   echo 'een lang wachtwoord' | pnpm user:add --email ... --name ... --role admin --password-stdin
 * Without --password-stdin a strong random password is generated and printed once.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'operator' },
    'password-stdin': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const parsedEmail = emailSchema.safeParse(values.email ?? '');
if (!parsedEmail.success) fail('--email is missing or not a valid e-mail address');
const name = values.name?.trim();
if (!name) fail('--name is required');
if (!ROLES.includes(values.role as Role)) fail(`--role must be one of: ${ROLES.join(', ')}`);

let password: string;
let generated = false;
if (values['password-stdin']) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (password.length < MIN_PASSWORD_LENGTH) fail(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`);
} else {
  password = generatePassword();
  generated = true;
}

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl, 'scan-cli');
try {
  await runMigrations(db);
  const id = await createUser(db, { email: parsedEmail.data, name, role: values.role as Role, password }, null, 'cli');
  if (!id) fail(`a user with e-mail ${parsedEmail.data} already exists`);
  console.log(`created ${values.role} ${parsedEmail.data}`);
  if (generated) console.log(`password (shown once, hand it over safely): ${password}`);
} finally {
  await pool.end();
}
