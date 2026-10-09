/** Staff roles. Admins manage settings and users; operators (employees) work on jobs. */
export const ROLES = ['admin', 'operator'] as const;
export type Role = (typeof ROLES)[number];

/** Admins must use TOTP; for operators it is optional (SPEC: Users and auth). */
export const totpRequired = (role: Role): boolean => role === 'admin';
