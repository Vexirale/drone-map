import { z } from 'zod';

/**
 * Branding is a setting (key 'branding'), editable later in the settings screen. These defaults
 * are the placeholder look: red for "Voor" and problems, green for "Na" and solutions.
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const Branding = z.object({
  companyName: z.string().min(1).max(120),
  phone: z.string().max(40),
  website: z.string().max(200),
  colorVoor: hex,
  colorNa: hex,
});
export type Branding = z.infer<typeof Branding>;

export const DEFAULT_BRANDING: Branding = {
  companyName: 'Bedrijfsnaam',
  phone: '040 000 00 00',
  website: 'bedrijfsnaam.nl',
  colorVoor: '#C22F28',
  colorNa: '#1A7642',
};
