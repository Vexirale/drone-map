import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api.ts';
import { meQuery } from './auth.ts';

/**
 * One QueryClient for the app (and a fresh one per test).
 *
 * Any request that finds the session gone updates the 'me' query, and the route guards then send
 * the user to the login form or the second-factor screen. No component has to handle that itself.
 */
export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => handleSessionError(error) }),
    mutationCache: new MutationCache({ onError: (error) => handleSessionError(error) }),
    defaultOptions: {
      queries: {
        // Retry only what can succeed a moment later: no connection or a server error.
        retry: (failureCount, error) =>
          failureCount < 2 && error instanceof ApiError && (error.code === 'network' || error.status >= 500),
      },
    },
  });

  function handleSessionError(error: Error): void {
    if (!(error instanceof ApiError)) return;
    if (error.code === 'unauthenticated') queryClient.setQueryData(meQuery.queryKey, null);
    if (error.code === 'second_factor_required') void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
  }

  return queryClient;
}
