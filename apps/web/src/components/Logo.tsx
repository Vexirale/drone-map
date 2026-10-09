/**
 * Placeholder logo, the same mark as public/favicon.svg and the preview (symbol id="logo" in
 * preview/src/page.html): a roof whose left half is red (voor, problems) and right half green
 * (na, solutions), over a house body in the current text colour. Replaceable in M2 via branding.
 *
 * Decorative by default (aria-hidden). Pass `label` when the logo stands on its own.
 */
export function Logo({ className, onDark = false, label }: { className?: string; onDark?: boolean; label?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path
        d="M6 25.5 24 9"
        fill="none"
        strokeWidth={6.5}
        strokeLinecap="round"
        className={onDark ? 'stroke-voor-bright' : 'stroke-voor'}
      />
      <path
        d="M24 9 42 25.5"
        fill="none"
        strokeWidth={6.5}
        strokeLinecap="round"
        className={onDark ? 'stroke-na-bright' : 'stroke-na'}
      />
      <path
        d="M13.5 26v11.5a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V26"
        fill="none"
        stroke="currentColor"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
