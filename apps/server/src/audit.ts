import type { Db } from './db/client.ts';
import { auditLog } from './db/schema.ts';

/**
 * Audit actions written from M0. Add new ones here so the list stays greppable.
 * Never put IP addresses, passwords, TOTP codes or secrets in `details`.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.totp_failed'
  | 'auth.totp_enabled'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'user.created'
  | 'user.totp_reset'
  | 'user.password_reset';

export interface AuditEntry {
  /** The staff user who did it; null for the system (bootstrap, CLI) or an unknown login email. */
  actorId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  details?: Record<string, string | number | boolean | null>;
}

export async function audit(db: Pick<Db, 'insert'>, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    details: entry.details ?? {},
  });
}
