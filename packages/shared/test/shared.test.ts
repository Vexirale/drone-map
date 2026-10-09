import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, Branding, LoginRequest, enuToThree, threeToEnu, totpRequired } from '../src/index.ts';

describe('coordinate convention', () => {
  it('maps east/north/up to three.js x/y/z and back', () => {
    expect(enuToThree([1, 2, 3])).toEqual([1, 3, -2]);
    expect(threeToEnu([1, 3, -2])).toEqual([1, 2, 3]);
  });

  it('is a proper rotation, so the frame stays right-handed', () => {
    const cross = (a: readonly number[], b: readonly number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ].map((v) => v + 0); // + 0 turns -0 into 0
    // east x north = up must hold after the mapping as well.
    expect(cross(enuToThree([1, 0, 0]), enuToThree([0, 1, 0]))).toEqual([...enuToThree([0, 0, 1])]);
  });

  it('round-trips arbitrary points', () => {
    for (const p of [
      [0, 0, 0],
      [-12.5, 40.25, 7],
      [1e5, -3e4, 2],
    ] as const) {
      expect(threeToEnu(enuToThree(p))).toEqual(p);
    }
  });
});

describe('contract', () => {
  it('normalises the login email', () => {
    expect(LoginRequest.parse({ email: '  Admin@Example.NL ', password: 'x' }).email).toBe('admin@example.nl');
  });

  it('rejects an empty password', () => {
    expect(LoginRequest.safeParse({ email: 'a@b.nl', password: '' }).success).toBe(false);
  });

  it('requires TOTP for admins only', () => {
    expect(totpRequired('admin')).toBe(true);
    expect(totpRequired('operator')).toBe(false);
  });

  it('has valid default branding', () => {
    expect(Branding.parse(DEFAULT_BRANDING)).toEqual(DEFAULT_BRANDING);
  });
});
