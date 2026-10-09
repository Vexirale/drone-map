import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../queryClient.ts';
import { routes } from '../routes.tsx';

type Handler = (body: unknown) => { status: number; body?: unknown };

/**
 * A fake API: `routes` maps "METHOD /path" to a handler. Unknown requests answer 404, so a test
 * fails loudly when the app calls something unexpected. Returns the recorded calls.
 */
export function fakeApi(handlers: Record<string, Handler>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${input}`;
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      const handler = handlers[key];
      const result = handler ? handler(body) : { status: 404, body: { error: { code: 'not_found' } } };
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

export const admin = {
  id: '5d6f3f2a-58e4-4b44-9d6e-0f0f8b7c2a11',
  email: 'admin@example.nl',
  name: 'Anne',
  role: 'admin',
  totpEnabled: true,
} as const;
export const operator = {
  ...admin,
  id: '6e7a4a3b-69f5-4c55-8e7f-1a1a9c8d3b22',
  email: 'jan@example.nl',
  name: 'Jan',
  role: 'operator',
  totpEnabled: false,
} as const;
export const unauthenticated = () => ({ status: 401, body: { error: { code: 'unauthenticated' } } });
