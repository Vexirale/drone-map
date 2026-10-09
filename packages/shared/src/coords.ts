/**
 * Coordinate convention (PLAN.md decision 9).
 *
 * Everything stored (scan offsets, boundary, markers, camera keyframes, measurements) is in
 * job-local metres: east, north, up (ENU), relative to the job origin. three.js is Y-up, so the
 * conversion lives here and nowhere else:
 *   three.x = east, three.y = up, three.z = -north
 * Both frames are right-handed.
 */
export type Enu = readonly [east: number, north: number, up: number];
export type ThreeXyz = readonly [x: number, y: number, z: number];

export const enuToThree = ([e, n, u]: Enu): ThreeXyz => [e, u, n === 0 ? 0 : -n];
export const threeToEnu = ([x, y, z]: ThreeXyz): Enu => [x, z === 0 ? 0 : -z, y];
