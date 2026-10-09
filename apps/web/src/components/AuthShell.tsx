import type { ReactNode } from 'react';
import { useBranding } from '../branding.ts';
import { Logo } from './Logo.tsx';

/** Centered card with the logo on top, used by the login, code and two-step setup screens. */
export function AuthShell({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  const { companyName } = useBranding();
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-lg' : 'max-w-sm'}`}>
        <div className="mb-6 flex items-center justify-center gap-3">
          <Logo className="size-10 shrink-0" />
          <span className="text-xl font-bold tracking-tight">{companyName}</span>
        </div>
        <div className="grid gap-5 rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
