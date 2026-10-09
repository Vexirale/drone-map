import { useId, type ComponentProps } from 'react';
import { errorMessage } from '../api.ts';
import { nl } from '../nl.ts';

/** Small shared building blocks. Styling lives here so pages stay about content. */

type ButtonVariant = 'primary' | 'secondary';

const buttonBase =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary/85',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2',
};

/** Classes for a button, also for a router <Link> that should look like one. */
export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return `${buttonBase} ${buttonVariants[variant]} ${extra}`.trim();
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return <button type="button" className={buttonClass(variant, className)} {...props} />;
}

const inputClass =
  'block w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base text-ink placeholder:text-muted aria-[invalid=true]:border-voor';

/** Text input with a visible label (and optional hint), wired up for screen readers. */
export function TextField({
  label,
  hint,
  className = '',
  ...inputProps
}: Omit<ComponentProps<'input'>, 'id'> & { label: string; hint?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`grid gap-1.5 ${className}`.trim()}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input id={id} aria-describedby={hint ? hintId : undefined} className={inputClass} {...inputProps} />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Field for a 6-digit TOTP code. Numeric keyboard on phones, and the phone may offer the code
 * itself (autocomplete one-time-code). Spaces and other non-digits are dropped while typing, so a
 * pasted "123 456" works.
 */
export function CodeField({
  label,
  value,
  onChange,
  invalid,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  invalid: boolean;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      label={label}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      autoFocus={autoFocus}
      aria-invalid={invalid || undefined}
      className="max-w-48"
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

/** Error text that screen readers announce as soon as it appears. */
export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-voor/40 bg-voor-soft px-3 py-2 text-sm text-ink">
      {message}
    </p>
  );
}

/** Whole-screen state while the session loads, or when it could not be loaded at all. */
export function PageStatus({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      {error ? (
        <div className="grid max-w-sm gap-4 text-center">
          <ErrorAlert message={errorMessage(error)} />
          {onRetry ? <Button onClick={onRetry}>{nl.common.retry}</Button> : null}
        </div>
      ) : (
        <p role="status" className="text-muted">
          {nl.common.loading}
        </p>
      )}
    </div>
  );
}
