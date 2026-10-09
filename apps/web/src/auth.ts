import type { MeResponse, User } from '@scan/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, api } from './api.ts';

/**
 * Session state on the client. There is exactly one source of truth: the 'me' query, which holds
 * the server's MeResponse, or null when nobody is logged in. MeResponse.next decides which screen
 * is allowed: the protected pages need next === null; the login screens redirect accordingly.
 */

export const PATHS = {
  home: '/',
  account: '/account',
  login: '/login',
  totp: '/login/code',
  totpSetup: '/login/tweestaps',
} as const;

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async (): Promise<MeResponse | null> => {
    try {
      return await api.me();
    } catch (error) {
      // Not logged in is a normal state, not an error.
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 30_000,
});

export function useMe() {
  return useQuery(meQuery);
}

/** The logged-in user. Only for components inside the protected layout, which guarantees a full session. */
export function useSessionUser(): User {
  const { data } = useMe();
  if (!data) throw new Error('useSessionUser() used outside the protected layout');
  return data.user;
}

/** Where a session belongs: the login form, a second-factor screen, or the page the user asked for. */
export function destinationFor(session: MeResponse | null, from?: string): string {
  if (session === null) return PATHS.login;
  if (session.next === 'totp') return PATHS.totp;
  if (session.next === 'totp_setup') return PATHS.totpSetup;
  return from ?? PATHS.home;
}

/**
 * The protected page a user was sent away from, kept in router state (never in the URL) while they
 * log in, so they land back on it afterwards.
 */
export type ReturnState = { from?: string };

export function returnPath(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('from' in state)) return undefined;
  const { from } = state;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith(PATHS.login)) {
    return undefined;
  }
  return from;
}

/** Logs out on the server, forgets every cached answer and goes to the login form. */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      try {
        await api.logout();
      } catch (error) {
        // Already logged out (expired session): that is the goal anyway.
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
    },
    onSuccess: async () => {
      queryClient.clear();
      queryClient.setQueryData(meQuery.queryKey, null);
      await navigate(PATHS.login, { replace: true });
    },
  });
}
