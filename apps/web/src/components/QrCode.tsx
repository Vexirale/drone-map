import { create } from 'qrcode';
import { useMemo } from 'react';

/** Modules of white border around the code; scanners need it. */
const QUIET_ZONE = 4;

/**
 * QR code drawn as one SVG path, generated in the browser with the 'qrcode' package, so the TOTP
 * secret never goes to a third-party service. Always black on white (also in dark mode): that is
 * what authenticator apps scan most reliably.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

function qrPath(value: string): { path: string; size: number } {
  const { modules } = create(value, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { path, size: modules.size + 2 * QUIET_ZONE };
}
