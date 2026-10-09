import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * M0 tables. The data model for all phases is described in docs/architecture.md; tables for
 * later phases are added by migrations in their own milestone (PLAN.md decision 8).
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-case; unique. */
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role', { enum: ['admin', 'operator'] }).notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Base32 TOTP secret. Set during setup; only trusted once totpEnabledAt is set. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step, so a code cannot be used twice. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('users_role_check', sql`${t.role} in ('admin', 'operator')`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 (hex) of the random token in the cookie; the token itself is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'password': first factor done, second factor (or TOTP setup) still needed. 'full': logged in. */
    stage: text('stage', { enum: ['password', 'full'] }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    check('sessions_stage_check', sql`${t.stage} in ('password', 'full')`),
  ],
);

/** Key/value settings (branding, presets, defaults). Values are validated by zod schemas in code. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

/**
 * Who did what and when (PLAN.md decision 7). Written from M0, shown in the UI in phase 3.
 * No IP addresses or other personal data beyond the staff user id.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_actor_idx').on(t.actorId)],
);
