import { asc, eq, sql } from 'drizzle-orm';
import type { Role, StaffUser } from '@scan/shared';
import { audit } from './audit.ts';
import { deleteUserSessions } from './auth/session.ts';
import { hashPassword } from './auth/password.ts';
import type { Db } from './db/client.ts';
import { users } from './db/schema.ts';

/** Staff user management shared by the bootstrap, the CLI and (later) the admin screens. */

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  password: string;
}

/**
 * Creates a user and writes the audit row in one transaction. Returns the new id, or null when the
 * email is already taken. `actorId` null means the system (bootstrap or CLI).
 */
export async function createUser(
  db: Db,
  input: NewUser,
  actorId: string | null,
  via: 'bootstrap' | 'cli' | 'admin',
): Promise<string | null> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({ email: input.email, name: input.name, role: input.role, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (!row) return null;
    await audit(tx, {
      actorId,
      action: 'user.created',
      targetType: 'user',
      targetId: row.id,
      details: { role: input.role, via },
    });
    return row.id;
  });
}

export async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return row?.id ?? null;
}

export async function adminExists(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
  return !!row;
}

/**
 * Clears TOTP for a user who lost their phone and logs them out everywhere. Admins are asked to set
 * up TOTP again at their next login.
 */
export async function resetTotp(db: Db, userId: string, actorId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
    await deleteUserSessions(tx, userId);
    await audit(tx, { actorId, action: 'user.totp_reset', targetType: 'user', targetId: userId });
  });
}

export async function listUsers(db: Db): Promise<StaffUser[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      totpEnabledAt: users.totpEnabledAt,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(asc(users.name), asc(users.email));
  return rows.map(({ totpEnabledAt, lastLoginAt, ...rest }) => ({
    ...rest,
    totpEnabled: totpEnabledAt !== null,
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
  }));
}
