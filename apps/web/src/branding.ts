import { DEFAULT_BRANDING, type Branding } from '@scan/shared';
import { useEffect } from 'react';
import { nl } from './nl.ts';

/**
 * Company branding (name, colours, contact). It becomes an admin setting in M2 (settings key
 * 'branding'); until then the placeholder defaults from @scan/shared. Components read it through
 * this hook only, so switching to the setting later is a change in one place.
 */
export function useBranding(): Branding {
  return DEFAULT_BRANDING;
}

/** Sets the browser tab title, for example "Opdrachten · Bedrijfsnaam". */
export function usePageTitle(page: string): void {
  const { companyName } = useBranding();
  useEffect(() => {
    document.title = nl.pageTitle(page, companyName);
  }, [page, companyName]);
}
