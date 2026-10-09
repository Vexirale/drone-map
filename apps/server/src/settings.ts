import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Branding, DEFAULT_BRANDING } from '@scan/shared';
import type { Db } from './db/client.ts';
import { settings } from './db/schema.ts';

/**
 * Typed key/value settings. Each key has a zod schema and a default; values are validated on the
 * way in and on the way out, so a hand-edited row can never crash a render or a page.
 * Add a key here to add a setting.
 */
const DEFINITIONS = {
  branding: { schema: Branding, defaultValue: DEFAULT_BRANDING },
} as const;

export type SettingKey = keyof typeof DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof DEFINITIONS)[K]['schema']>;

/** Returns the stored value, or the default when the row is missing or no longer valid. */
export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  const definition = DEFINITIONS[key];
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  const parsed = definition.schema.safeParse(row?.value);
  return (parsed.success ? parsed.data : definition.defaultValue) as SettingValue<K>;
}

/** Validates and stores a value. Throws a ZodError when the value does not fit the schema. */
export async function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValue<K>,
  updatedBy: string | null,
): Promise<void> {
  const valid = DEFINITIONS[key].schema.parse(value);
  await db
    .insert(settings)
    .values({ key, value: valid, updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value: valid, updatedBy, updatedAt: sql`now()` } });
}

/** Inserts the default for every setting that has no row yet. Existing values are left alone. */
export async function seedSettings(db: Db): Promise<void> {
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    await db.insert(settings).values({ key, value: definition.defaultValue }).onConflictDoNothing();
  }
}
