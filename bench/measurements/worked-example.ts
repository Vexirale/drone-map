/*
 * Reference implementation of the measurement methods in docs/measurements.md (algorithm version
 * measure-1, SPEC "Phase 2: how every measurement is calculated"). It produces the worked example
 * and checks every uncertainty formula by Monte Carlo. Not part of the app: M4 ports the methods
 * to packages/shared with the same tests.
 *
 * Run: node bench/measurements/worked-example.ts   (Node >= 22.18: type stripping, no dependencies)
 *
 * Everything is deterministic: the synthetic meshes, the noise and every Monte Carlo run use
 * seeded generators, so two runs print the same numbers.
 *
 * Frame: job-local metres east, north, up (ENU, Z up). Nothing here knows about three.js.
 */

// ---------------------------------------------------------------------------------------------
// Parameters (stored per revision in the app; a change is a new algorithm version)
// ---------------------------------------------------------------------------------------------

const PARAMS = {
  algorithmVersion: 'measure-1',
  sigmaFactor: 2, // sigma (per axis) = 2 x effective resolution
  coverage: 2, // shown +- = 2 sigma, rounded up
  displayStep: { length: 0.01, area: 0.1, angle: 0.1 }, // rounding-up steps of the shown +-
  planeBand: 0.3, // m: vertices within this distance of the (provisional / fitted) plane
  edgeMargin: 0.25, // m: vertices closer than this to the polygon edge (in-plane) are not used for the fit
  minPlaneVertices: 10, // fewer selected vertices -> error, no plane fit
  flatnessRmsMax: 0.05, // m: above this the roof face is "not flat" and the clipped mesh area is used
  groundSlab: { below: 1.0, above: 1.0 }, // m: ground area counts mesh between min(pick U)-below and max(pick U)+above
  steepAngleDeg: 60, // clipped pieces whose normal is more than this from the prism axis are reported as "steep"
  reprojectFlagMin: 0.1, // m: flag a pick when |final - picked| > max(0.10 m, 2 sigma)
  // Pitch sigma is at least sqrt2 x sigma / (the polygon's extent along the dip): what two picked
  // points at the ends of the face would give. The many-vertex fit formula assumes independent
  // vertex errors; photogrammetric meshes warp in correlated patches, so on its own it is too
  // optimistic to show to a customer.
  pitchFloor: true,
};

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

type V2 = [number, number];
type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => mul(a, 1 / len(a));
const dist = (a: V3, b: V3): number => len(sub(a, b));
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------------------------
// Seeded PRNG: splitmix32 seeding + xoshiro128**, 53-bit uniforms, Box-Muller normals
// ---------------------------------------------------------------------------------------------

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

interface Rng {
  uniform: () => number; // [0, 1)
  gauss: () => number; // N(0, 1)
}

function makeRng(seed: number): Rng {
  const sm = splitmix32(seed);
  let a = sm() | 0;
  let b = sm() | 0;
  let c = sm() | 0;
  let d = sm() | 0;
  const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));
  const next = (): number => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return r;
  };
  const uniform = (): number => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992;
  let spare: number | null = null;
  const gauss = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = 1 - uniform(); // (0, 1]
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
  return { uniform, gauss };
}

function hashKey(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// Dutch number formatting
// ---------------------------------------------------------------------------------------------

const nlFormats = new Map<string, Intl.NumberFormat>();
function nl(x: number, decimals: number, grouping = true): string {
  const key = `${decimals}|${grouping}`;
  let f = nlFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat('nl-NL', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    });
    nlFormats.set(key, f);
  }
  return f.format(Math.abs(x) < 0.5 * 10 ** -decimals ? 0 : x);
}

const decimalsOf = (step: number): number => {
  let d = 0;
  while (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-9 && d < 10) d++;
  return d;
};

/** Round up to a multiple of step, ignoring floating-point dust (0.06000000000000001 -> 0.06). */
function ceilToStep(x: number, step: number): number {
  const q = x / step;
  const r = Math.round(q);
  const k = Math.abs(q - r) <= 1e-9 * Math.max(1, Math.abs(q)) ? r : Math.ceil(q);
  return Number((k * step).toFixed(decimalsOf(step)));
}

const f = (x: number, d = 4): string => (Math.abs(x) < 0.5 * 10 ** -d ? (0).toFixed(d) : x.toFixed(d));
const fe = (x: number): string => x.toExponential(1);
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const fv = (p: V3, d = 4): string => `(${f(p[0], d)}, ${f(p[1], d)}, ${f(p[2], d)})`;

// ---------------------------------------------------------------------------------------------
// Meshes and the synthetic property
// ---------------------------------------------------------------------------------------------

interface Mesh {
  name: string;
  pos: Float64Array; // xyz per vertex (with noise)
  tri: Uint32Array; // three vertex indices per triangle
}

function createBuilder(noiseSigma: number, noiseSeed: number) {
  const pos: number[] = [];
  const tri: number[] = [];
  const index = new Map<string, number>();
  // Vertices are welded on their nominal position (1 micrometre key). The noise is a function of
  // that key, so the light and the full mesh get identical noise where their vertices coincide,
  // like a decimated mesh that keeps a subset of the original vertices.
  const vertex = (p: V3): number => {
    const key = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = pos.length / 3;
      index.set(key, i);
      if (noiseSigma > 0) {
        const r = makeRng(hashKey(key, noiseSeed));
        pos.push(p[0] + noiseSigma * r.gauss(), p[1] + noiseSigma * r.gauss(), p[2] + noiseSigma * r.gauss());
      } else pos.push(p[0], p[1], p[2]);
    }
    return i;
  };
  const triangle = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  };
  /** Bilinear patch p00-p10-p11-p01 (planar quads, trapezoids, or a triangle with p11 = p01). */
  const quad = (p00: V3, p10: V3, p11: V3, p01: V3, spacing: number): void => {
    const nu = Math.max(1, Math.ceil(Math.max(dist(p00, p10), dist(p01, p11)) / spacing - 1e-9));
    const nv = Math.max(1, Math.ceil(Math.max(dist(p00, p01), dist(p10, p11)) / spacing - 1e-9));
    const rows: number[][] = [];
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      const a = add(mul(p00, 1 - t), mul(p01, t));
      const b = add(mul(p10, 1 - t), mul(p11, t));
      const row: number[] = [];
      for (let i = 0; i <= nu; i++) row.push(vertex(add(mul(a, 1 - i / nu), mul(b, i / nu))));
      rows.push(row);
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        triangle(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1]);
        triangle(rows[j][i], rows[j + 1][i + 1], rows[j + 1][i]);
      }
  };
  const finish = (name: string): Mesh => ({ name, pos: Float64Array.from(pos), tri: Uint32Array.from(tri) });
  return { vertex, triangle, quad, finish };
}

// Known geometry (job-local metres). Every rectangle is aligned to both mesh spacings.
const HOUSE = { e0: 0, e1: 10, n0: 0, n1: 8, eave: 6, ridge: 10 };
const SHED = { e0: 20, e1: 24, n0: 0, n1: 3, low: 2.5, high: 2.5 + 3 * Math.tan(Math.PI / 6) }; // 30 deg lean-to
const TERRACE = { e0: 13, e1: 18, n0: 10, n1: 14, top: 0.3 }; // raised terrace, 0.30 m kerb all round
const LAWN = { e0: -12, e1: -4, n0: 2, n1: 8, amp: 0.12, period: 3 }; // mole hills, 8 x 6 m
const GROUND = { e0: -14, e1: 26, n0: -10, n1: 16 };

function lawnZ(x: number, y: number): number {
  const z =
    LAWN.amp *
    Math.sin((2 * Math.PI * (x - LAWN.e0)) / LAWN.period) *
    Math.sin((2 * Math.PI * (y - LAWN.n0)) / LAWN.period);
  return Math.abs(z) < 1e-12 ? 0 : z;
}
const inLawn = (x: number, y: number): boolean =>
  x >= LAWN.e0 - 1e-9 && x <= LAWN.e1 + 1e-9 && y >= LAWN.n0 - 1e-9 && y <= LAWN.n1 + 1e-9;
const groundZ = (x: number, y: number): number => (inLawn(x, y) ? lawnZ(x, y) : 0);

function buildScene(name: string, spacing: number, noiseSigma: number, noiseSeed: number): Mesh {
  const b = createBuilder(noiseSigma, noiseSeed);
  const s = spacing;
  // Ground: height field (flat, mole hills inside the lawn), without the building footprints.
  const holes = [HOUSE, SHED, TERRACE];
  const nx = Math.round((GROUND.e1 - GROUND.e0) / s);
  const ny = Math.round((GROUND.n1 - GROUND.n0) / s);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const x0 = GROUND.e0 + i * s;
      const y0 = GROUND.n0 + j * s;
      const cx = x0 + s / 2;
      const cy = y0 + s / 2;
      if (holes.some((r) => cx > r.e0 && cx < r.e1 && cy > r.n0 && cy < r.n1)) continue;
      const v00 = b.vertex([x0, y0, groundZ(x0, y0)]);
      const v10 = b.vertex([x0 + s, y0, groundZ(x0 + s, y0)]);
      const v11 = b.vertex([x0 + s, y0 + s, groundZ(x0 + s, y0 + s)]);
      const v01 = b.vertex([x0, y0 + s, groundZ(x0, y0 + s)]);
      b.triangle(v00, v10, v11);
      b.triangle(v00, v11, v01);
    }
  // House: walls, gables, 45 degree gable roof with the ridge along east.
  const { e0, e1, n0, n1, eave, ridge } = HOUSE;
  const nm = (n0 + n1) / 2;
  b.quad([e0, n0, 0], [e1, n0, 0], [e1, n0, eave], [e0, n0, eave], s);
  b.quad([e1, n1, 0], [e0, n1, 0], [e0, n1, eave], [e1, n1, eave], s);
  b.quad([e0, n1, 0], [e0, n0, 0], [e0, n0, eave], [e0, n1, eave], s);
  b.quad([e1, n0, 0], [e1, n1, 0], [e1, n1, eave], [e1, n0, eave], s);
  b.quad([e0, n1, eave], [e0, n0, eave], [e0, nm, ridge], [e0, nm, ridge], s);
  b.quad([e1, n0, eave], [e1, n1, eave], [e1, nm, ridge], [e1, nm, ridge], s);
  b.quad([e0, n0, eave], [e1, n0, eave], [e1, nm, ridge], [e0, nm, ridge], s); // south face
  b.quad([e1, n1, eave], [e0, n1, eave], [e0, nm, ridge], [e1, nm, ridge], s); // north face
  // Shed with a 30 degree lean-to roof rising to the north.
  {
    const { e0, e1, n0, n1, low, high } = SHED;
    b.quad([e0, n0, 0], [e1, n0, 0], [e1, n0, low], [e0, n0, low], s);
    b.quad([e1, n1, 0], [e0, n1, 0], [e0, n1, high], [e1, n1, high], s);
    b.quad([e0, n1, 0], [e0, n0, 0], [e0, n0, low], [e0, n1, high], s);
    b.quad([e1, n0, 0], [e1, n1, 0], [e1, n1, high], [e1, n0, low], s);
    b.quad([e0, n0, low], [e1, n0, low], [e1, n1, high], [e0, n1, high], s);
  }
  // Raised terrace: top at 0.30 m and four vertical kerb faces.
  {
    const { e0, e1, n0, n1, top } = TERRACE;
    b.quad([e0, n0, top], [e1, n0, top], [e1, n1, top], [e0, n1, top], s);
    b.quad([e0, n0, 0], [e1, n0, 0], [e1, n0, top], [e0, n0, top], s);
    b.quad([e1, n0, 0], [e1, n1, 0], [e1, n1, top], [e1, n0, top], s);
    b.quad([e1, n1, 0], [e0, n1, 0], [e0, n1, top], [e1, n1, top], s);
    b.quad([e0, n1, 0], [e0, n0, 0], [e0, n0, top], [e0, n1, top], s);
  }
  return b.finish(name);
}

const vtx = (m: Mesh, i: number): V3 => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];

function triArea(m: Mesh, t: number): number {
  const a = vtx(m, m.tri[3 * t]);
  return 0.5 * len(cross(sub(vtx(m, m.tri[3 * t + 1]), a), sub(vtx(m, m.tri[3 * t + 2]), a)));
}

// ---------------------------------------------------------------------------------------------
// Ray casting: Moller-Trumbore, first hit
// ---------------------------------------------------------------------------------------------

interface Hit {
  t: number;
  p: V3;
  tri: number;
}

function raycast(m: Mesh, o: V3, d: V3): Hit | null {
  const P = m.pos;
  const T = m.tri;
  let best = Infinity;
  let bestTri = -1;
  const eps = 1e-12;
  for (let k = 0; k < T.length; k += 3) {
    const i0 = 3 * T[k];
    const i1 = 3 * T[k + 1];
    const i2 = 3 * T[k + 2];
    const e1x = P[i1] - P[i0];
    const e1y = P[i1 + 1] - P[i0 + 1];
    const e1z = P[i1 + 2] - P[i0 + 2];
    const e2x = P[i2] - P[i0];
    const e2y = P[i2 + 1] - P[i0 + 1];
    const e2z = P[i2 + 2] - P[i0 + 2];
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-14 && det < 1e-14) continue; // ray parallel to the triangle
    const inv = 1 / det;
    const tx = o[0] - P[i0];
    const ty = o[1] - P[i0 + 1];
    const tz = o[2] - P[i0 + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -eps || u > 1 + eps) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -eps || u + v > 1 + eps) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-9 && t < best) {
      best = t;
      bestTri = k / 3;
    }
  }
  return bestTri < 0 ? null : { t: best, p: add(o, mul(d, best)), tri: bestTri };
}

// ---------------------------------------------------------------------------------------------
// Jacobi eigen solver (symmetric 3x3) and total-least-squares plane fit
// ---------------------------------------------------------------------------------------------

function jacobiEigenSym3(m: number[][]): { values: number[]; vectors: V3[] } {
  const A = m.map((r) => r.slice());
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs: V2[] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
    const diag = A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2;
    if (off === 0 || off <= 1e-32 * diag) break;
    for (const [p, q] of pairs) {
      const apq = A[p][q];
      if (apq === 0) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * apq);
      const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k][p];
        const akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p][k];
        const aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p];
        const vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const values = [A[0][0], A[1][1], A[2][2]];
  const vectors: V3[] = [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]] as V3);
  return { values, vectors };
}

interface Plane {
  c: V3; // centroid
  n: V3; // unit normal, oriented up (n_z >= 0)
  eig: number[]; // covariance eigenvalues, ascending
}

function fitPlane(pts: V3[]): Plane {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const p of pts) {
    const x = p[0] - cx;
    const y = p[1] - cy;
    const z = p[2] - cz;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  const { values, vectors } = jacobiEigenSym3([
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ]);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  let nrm = unit(vectors[order[0]]);
  if (nrm[2] < 0) nrm = mul(nrm, -1);
  return { c: [cx, cy, cz], n: nrm, eig: order.map((i) => values[i]) };
}

/** Orthonormal in-plane basis: e1 horizontal (strike), e2 = n x e1 (up the slope); e1 x e2 = n. */
function planeBasis(n: V3): [V3, V3] {
  let e1 = cross([0, 0, 1], n);
  if (len(e1) < 1e-9) e1 = [1, 0, 0];
  e1 = unit(sub(e1, mul(n, dot(e1, n))));
  return [e1, cross(n, e1)];
}

const pitchDeg = (n: V3): number => Math.atan2(Math.hypot(n[0], n[1]), Math.abs(n[2])) * DEG;

// ---------------------------------------------------------------------------------------------
// 2D polygons: shoelace, point in polygon, simplicity, ear clipping
// ---------------------------------------------------------------------------------------------

function shoelace(p: V2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2; // signed: > 0 counter-clockwise
}

function pointInPolygon(q: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToBoundary(q: V2, poly: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
  }
  return best;
}

const orient = (a: V2, b: V2, c: V2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function segmentsIntersect(a: V2, b: V2, c: V2, d: V2): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: V2, q: V2, r: V2): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

function assertSimplePolygon(p: V2[]): void {
  const n = p.length;
  if (n < 3) throw new Error('polygon_too_few_points');
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
      if (segmentsIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) throw new Error('polygon_self_intersecting');
    }
  if (Math.abs(shoelace(p)) < 1e-12) throw new Error('polygon_zero_area');
}

/** Ear clipping. Returns counter-clockwise triangles (indices into p). Works for either winding. */
function earClip(p: V2[]): [number, number, number][] {
  assertSimplePolygon(p);
  let idx = p.map((_, i) => i);
  if (shoelace(p) < 0) idx.reverse();
  const tris: [number, number, number][] = [];
  const scale = Math.max(...p.map((q) => Math.max(Math.abs(q[0]), Math.abs(q[1]))), 1);
  const eps = 1e-12 * scale * scale;
  const inTri = (q: V2, a: V2, b: V2, c: V2): boolean =>
    orient(a, b, q) >= -eps && orient(b, c, q) >= -eps && orient(c, a, q) >= -eps;
  while (idx.length > 3) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = p[ia];
      const b = p[ib];
      const c = p[ic];
      const o = orient(a, b, c);
      if (Math.abs(o) <= eps) {
        // collinear (straight-through) vertex: drop it, it carries no area
        idx = idx.filter((_, j) => j !== k);
        clipped = true;
        break;
      }
      if (o < 0) continue; // reflex vertex
      let empty = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const q = p[j];
        if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1]) || (q[0] === c[0] && q[1] === c[1])) continue;
        if (inTri(q, a, b, c)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      tris.push([ia, ib, ic]);
      idx = idx.filter((_, j) => j !== k);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('ear_clipping_failed');
  }
  if (Math.abs(orient(p[idx[0]], p[idx[1]], p[idx[2]])) > eps) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// ---------------------------------------------------------------------------------------------
// Mesh area clipped to a polygon prism (3D Sutherland-Hodgman per convex ear)
// ---------------------------------------------------------------------------------------------

interface ClipResult {
  area: number; // m2, 3D area of the mesh inside the prism (and the slab)
  steepArea: number; // m2, part of it on triangles more than steepAngleDeg from the prism axis
  ears: number;
}

type Plane4 = [number, number, number, number]; // inside: a*u + b*v + c*w + d >= 0

function clipPolygon(poly: V3[], pl: Plane4): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i];
    const Q = poly[(i + 1) % poly.length];
    const dp = pl[0] * P[0] + pl[1] * P[1] + pl[2] * P[2] + pl[3];
    const dq = pl[0] * Q[0] + pl[1] * Q[1] + pl[2] * Q[2] + pl[3];
    if (dp >= 0) out.push(P);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1]), P[2] + t * (Q[2] - P[2])]);
    }
  }
  return out;
}

function polygonArea3(poly: V3[]): number {
  let s: V3 = [0, 0, 0];
  for (let i = 1; i + 1 < poly.length; i++) s = add(s, cross(sub(poly[i], poly[0]), sub(poly[i + 1], poly[0])));
  return 0.5 * len(s);
}

/**
 * Area of the mesh inside the prism over `poly3` along `axis` (unit), optionally limited to
 * slab[0] <= p.axis <= slab[1]. The polygon is ear-clipped in the plane perpendicular to the axis;
 * each mesh triangle is clipped in 3D against the three side planes of each ear (and the slab).
 * Working in the orthonormal frame (e1, e2, axis) keeps 3D areas unchanged.
 */
interface PreparedTris {
  e1: V3;
  e2: V3;
  n: number;
  uvw: Float64Array; // 9 per triangle: the three vertices in the (e1, e2, axis) frame
  box: Float64Array; // 4 per triangle: umin, umax, vmin, vmax
  area: Float64Array;
  steep: Uint8Array;
}

const prepCache = new WeakMap<object, Map<string, PreparedTris>>();

function prepareTris(m: Mesh, cand: Uint32Array | null, axis: V3): PreparedTris {
  const owner: object = cand ?? m;
  const key = axis.join(',');
  let byAxis = prepCache.get(owner);
  if (!byAxis) {
    byAxis = new Map();
    prepCache.set(owner, byAxis);
  }
  const hit = byAxis.get(key);
  if (hit) return hit;
  const [e1, e2] = planeBasis(axis);
  const n = cand ? cand.length : m.tri.length / 3;
  const uvw = new Float64Array(9 * n);
  const box = new Float64Array(4 * n);
  const area = new Float64Array(n);
  const steep = new Uint8Array(n);
  const cosSteep = Math.cos(PARAMS.steepAngleDeg / DEG);
  for (let k = 0; k < n; k++) {
    const t = cand ? cand[k] : k;
    const tv: V3[] = [0, 1, 2].map((j) => {
      const p = vtx(m, m.tri[3 * t + j]);
      return [dot(p, e1), dot(p, e2), dot(p, axis)] as V3;
    });
    for (let j = 0; j < 3; j++) for (let c = 0; c < 3; c++) uvw[9 * k + 3 * j + c] = tv[j][c];
    const nrm = cross(sub(tv[1], tv[0]), sub(tv[2], tv[0]));
    area[k] = 0.5 * len(nrm);
    steep[k] = Math.abs(nrm[2]) < cosSteep * 2 * area[k] ? 1 : 0;
    box[4 * k] = Math.min(tv[0][0], tv[1][0], tv[2][0]);
    box[4 * k + 1] = Math.max(tv[0][0], tv[1][0], tv[2][0]);
    box[4 * k + 2] = Math.min(tv[0][1], tv[1][1], tv[2][1]);
    box[4 * k + 3] = Math.max(tv[0][1], tv[1][1], tv[2][1]);
  }
  const prep = { e1, e2, n, uvw, box, area, steep };
  byAxis.set(key, prep);
  return prep;
}

function clipMeshToPrism(m: Mesh, poly3: V3[], axis: V3, slab: V2 | null, cand: Uint32Array | null): ClipResult {
  const prep = prepareTris(m, cand, axis);
  const { e1, e2 } = prep;
  const poly2: V2[] = poly3.map((p) => [dot(p, e1), dot(p, e2)]);
  const ears = earClip(poly2);
  const earPlanes: Plane4[][] = [];
  const earBox: number[][] = [];
  for (const [ia, ib, ic] of ears) {
    const pts = [poly2[ia], poly2[ib], poly2[ic]];
    const planes: Plane4[] = [];
    for (let k = 0; k < 3; k++) {
      const A = pts[k];
      const B = pts[(k + 1) % 3];
      const a = -(B[1] - A[1]);
      const b = B[0] - A[0];
      const l = Math.hypot(a, b);
      planes.push([a / l, b / l, 0, -(a * A[0] + b * A[1]) / l]);
    }
    if (slab) {
      planes.push([0, 0, 1, -slab[0]]);
      planes.push([0, 0, -1, slab[1]]);
    }
    earPlanes.push(planes);
    earBox.push([
      Math.min(pts[0][0], pts[1][0], pts[2][0]),
      Math.max(pts[0][0], pts[1][0], pts[2][0]),
      Math.min(pts[0][1], pts[1][1], pts[2][1]),
      Math.max(pts[0][1], pts[1][1], pts[2][1]),
    ]);
  }
  let area = 0;
  let steepArea = 0;
  const U = prep.uvw;
  for (let k = 0; k < prep.n; k++) {
    const full = prep.area[k];
    if (full === 0) continue;
    const umin = prep.box[4 * k];
    const umax = prep.box[4 * k + 1];
    const vmin = prep.box[4 * k + 2];
    const vmax = prep.box[4 * k + 3];
    for (let e = 0; e < ears.length; e++) {
      const bx = earBox[e];
      if (umax < bx[0] || umin > bx[1] || vmax < bx[2] || vmin > bx[3]) continue;
      const planes = earPlanes[e];
      let allIn = true;
      let allOut = false;
      for (let pi = 0; pi < planes.length && !allOut; pi++) {
        const pl = planes[pi];
        let outside = 0;
        for (let j = 0; j < 3; j++) {
          const o = 9 * k + 3 * j;
          if (pl[0] * U[o] + pl[1] * U[o + 1] + pl[2] * U[o + 2] + pl[3] < 0) outside++;
        }
        if (outside > 0) allIn = false;
        if (outside === 3) allOut = true; // entirely outside one plane: nothing of it is inside this ear
      }
      if (allOut) continue;
      let a: number;
      if (allIn) a = full;
      else {
        let poly: V3[] = [0, 1, 2].map((j) => [U[9 * k + 3 * j], U[9 * k + 3 * j + 1], U[9 * k + 3 * j + 2]] as V3);
        for (const pl of planes) {
          poly = clipPolygon(poly, pl);
          if (poly.length < 3) break;
        }
        a = poly.length < 3 ? 0 : polygonArea3(poly);
      }
      area += a;
      if (prep.steep[k]) steepArea += a;
    }
  }
  return { area, steepArea, ears: ears.length };
}

/** Triangles with a vertex inside the box (for speed in loops; a superset of what can matter). */
function trianglesNear(m: Mesh, lo: V3, hi: V3): Uint32Array {
  const out: number[] = [];
  for (let t = 0; t < m.tri.length / 3; t++) {
    for (let j = 0; j < 3; j++) {
      const p = vtx(m, m.tri[3 * t + j]);
      if (p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2]) {
        out.push(t);
        break;
      }
    }
  }
  return Uint32Array.from(out);
}

function verticesNear(m: Mesh, lo: V3, hi: V3): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < m.pos.length / 3; i++) {
    const p = vtx(m, i);
    if (p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2]) out.push(i);
  }
  return Uint32Array.from(out);
}

function bbox(pts: V3[], margin: number): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k] - margin);
      hi[k] = Math.max(hi[k], p[k] + margin);
    }
  return [lo, hi];
}

// ---------------------------------------------------------------------------------------------
// Measurement methods
// ---------------------------------------------------------------------------------------------

const distance3d = (a: V3, b: V3): number => dist(a, b);
const polylineLength = (pts: V3[]): number => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
const heightDiff = (a: V3, b: V3): number => Math.abs(b[2] - a[2]);

interface FaceOptions {
  band: number;
  margin: number;
  flatRms: number;
  minVertices: number;
}

interface FaceResult {
  provisional: Plane;
  plane: Plane;
  counts: number[]; // selected vertices in pass 1 and pass 2
  selected: V3[];
  rms: number;
  poly2: V2[]; // polygon in plane coordinates (e1, e2)
  polyOnPlane: V3[]; // picked polygon projected onto the fitted plane
  areaSlope: number;
  areaPlan: number;
  pitch: number; // degrees
  sumS2: number; // sum of squared along-dip offsets of the selected vertices
  flat: boolean;
  clip: ClipResult | null; // mesh area clipped to the polygon (prism along the plane normal), when not flat
  area: number; // the value used: areaSlope when flat, clip.area otherwise
  method: 'plane_fit' | 'mesh_clip';
}

function selectForPlane(m: Mesh, cand: Uint32Array | null, plane: Plane, poly: V3[], opt: FaceOptions): V3[] {
  const [e1, e2] = planeBasis(plane.n);
  const poly2: V2[] = poly.map((p) => [dot(sub(p, plane.c), e1), dot(sub(p, plane.c), e2)]);
  const out: V3[] = [];
  const n = cand ? cand.length : m.pos.length / 3;
  const [cx, cy, cz] = plane.c;
  const [nx, ny, nz] = plane.n;
  for (let k = 0; k < n; k++) {
    const i = 3 * (cand ? cand[k] : k);
    const rx = m.pos[i] - cx;
    const ry = m.pos[i + 1] - cy;
    const rz = m.pos[i + 2] - cz;
    if (Math.abs(rx * nx + ry * ny + rz * nz) > opt.band) continue;
    const q: V2 = [rx * e1[0] + ry * e1[1] + rz * e1[2], rx * e2[0] + ry * e2[1] + rz * e2[2]];
    if (!pointInPolygon(q, poly2)) continue;
    if (opt.margin > 0 && distToBoundary(q, poly2) < opt.margin) continue;
    out.push([m.pos[i], m.pos[i + 1], m.pos[i + 2]]);
  }
  return out;
}

function measureFace(m: Mesh, picks: V3[], opt: FaceOptions, cand: Uint32Array | null = null, clipCand: Uint32Array | null = null): FaceResult {
  const provisional = fitPlane(picks);
  let plane = provisional;
  let selected: V3[] = [];
  const counts: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    selected = selectForPlane(m, cand, plane, picks, opt);
    counts.push(selected.length);
    if (selected.length < opt.minVertices) throw new Error('plane_too_few_vertices');
    plane = fitPlane(selected);
  }
  const [e1, e2] = planeBasis(plane.n);
  let ss = 0;
  let s2 = 0;
  for (const p of selected) {
    const r = sub(p, plane.c);
    ss += dot(r, plane.n) ** 2;
    s2 += dot(r, e2) ** 2; // e2 is the up-dip unit vector, so this is ((p - c) . u_dip)^2
  }
  const rms = Math.sqrt(ss / selected.length);
  const poly2: V2[] = picks.map((p) => [dot(sub(p, plane.c), e1), dot(sub(p, plane.c), e2)]);
  const polyOnPlane: V3[] = poly2.map((q) => add(plane.c, add(mul(e1, q[0]), mul(e2, q[1]))));
  const areaSlope = Math.abs(shoelace(poly2));
  const areaPlan = Math.abs(shoelace(polyOnPlane.map((p) => [p[0], p[1]] as V2)));
  const flat = rms <= opt.flatRms;
  let clip: ClipResult | null = null;
  if (!flat) {
    const w = dot(plane.c, plane.n);
    clip = clipMeshToPrism(m, polyOnPlane, plane.n, [w - opt.band, w + opt.band], clipCand);
  }
  return {
    provisional,
    plane,
    counts,
    selected,
    rms,
    poly2,
    polyOnPlane,
    areaSlope,
    areaPlan,
    pitch: pitchDeg(plane.n),
    sumS2: s2,
    flat,
    clip,
    area: flat ? areaSlope : (clip as ClipResult).area,
    method: flat ? 'plane_fit' : 'mesh_clip',
  };
}

interface GroundResult {
  surface: ClipResult;
  areaPlan: number;
  slab: V2 | null;
}

function measureGround(m: Mesh, picks: V3[], useSlab = true, cand: Uint32Array | null = null): GroundResult {
  const us = picks.map((p) => p[2]);
  const slab: V2 | null = useSlab
    ? [Math.min(...us) - PARAMS.groundSlab.below, Math.max(...us) + PARAMS.groundSlab.above]
    : null;
  return {
    surface: clipMeshToPrism(m, picks, [0, 0, 1], slab, cand),
    areaPlan: Math.abs(shoelace(picks.map((p) => [p[0], p[1]] as V2))),
    slab,
  };
}

// ---------------------------------------------------------------------------------------------
// Uncertainty
// ---------------------------------------------------------------------------------------------

const sigmaFromResolution = (res: number): number => PARAMS.sigmaFactor * res;
const sigmaDistance = (s: number): number => s * Math.SQRT2;
const sigmaHeight = (s: number): number => s * Math.SQRT2;

function sigmaPolyline(pts: V3[], s: number): number {
  const u: V3[] = [];
  for (let i = 0; i + 1 < pts.length; i++) u.push(unit(sub(pts[i + 1], pts[i])));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    let g: V3 = [0, 0, 0];
    if (i > 0) g = add(g, u[i - 1]);
    if (i < u.length) g = sub(g, u[i]);
    sum += dot(g, g);
  }
  return s * Math.sqrt(sum);
}

function sigmaPolygonArea(p: V2[], s: number): number {
  let sum = 0;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[(i + 1) % n];
    const b = p[(i - 1 + n) % n];
    sum += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  }
  return (s / 2) * Math.sqrt(sum);
}

const sigmaPitchRad = (sigmaV: number, sumS2: number): number => sigmaV / Math.sqrt(sumS2);

/** Extent of the polygon along the dip (its second in-plane coordinate, up the slope), in m. */
const dipExtent = (poly2: V2[]): number => Math.max(...poly2.map((q) => q[1])) - Math.min(...poly2.map((q) => q[1]));

/** Floor for the pitch sigma (PARAMS.pitchFloor): two points sigma apart over the dip extent. */
const sigmaPitchFloorRad = (s: number, poly2: V2[]): number => (Math.SQRT2 * s) / dipExtent(poly2);

/** The pitch sigma used for the shown +-: the fit formula, but never below the floor. */
const sigmaPitchShownRad = (sigmaV: number, sumS2: number, s: number, poly2: V2[]): number =>
  PARAMS.pitchFloor ? Math.max(sigmaPitchRad(sigmaV, sumS2), sigmaPitchFloorRad(s, poly2)) : sigmaPitchRad(sigmaV, sumS2);

/**
 * sigma of a mesh area clipped to a polygon prism: linear propagation of independent polygon-vertex
 * errors (sigma per in-plane axis) through the numerical gradient of the clipped area
 * (central differences, h = 1 mm, along both in-plane axes of every vertex; the slab stays fixed).
 * On a flat surface this equals the polygon formula; on kerbs, walls and bumps it follows the surface.
 */
function sigmaClippedArea(m: Mesh, poly3: V3[], axis: V3, slab: V2 | null, cand: Uint32Array | null, s: number, h = 1e-3): number {
  const [e1, e2] = planeBasis(axis);
  let sum = 0;
  for (let i = 0; i < poly3.length; i++)
    for (const e of [e1, e2]) {
      const plus = poly3.slice();
      const minus = poly3.slice();
      plus[i] = add(poly3[i], mul(e, h));
      minus[i] = sub(poly3[i], mul(e, h));
      const g = (clipMeshToPrism(m, plus, axis, slab, cand).area - clipMeshToPrism(m, minus, axis, slab, cand).area) / (2 * h);
      sum += g * g;
    }
  return s * Math.sqrt(sum);
}

function shown(sigma: number, step: number): number {
  return ceilToStep(PARAMS.coverage * sigma, step);
}

// ---------------------------------------------------------------------------------------------
// Effective resolution: area-weighted median texel size of a textured mesh
// ---------------------------------------------------------------------------------------------

interface TexMesh {
  pos: V3[];
  uv: V2[];
  tri: { v: [number, number, number]; page: number; patch: string }[];
  pages: { w: number; h: number }[];
}

function texPatch(tm: TexMesh, name: string, origin: V3, du: V3, dv: V3, uv0: V2, uvSize: V2, page: number, nu: number, nv: number): void {
  const base = tm.pos.length;
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      tm.pos.push(add(origin, add(mul(du, i / nu), mul(dv, j / nv))));
      tm.uv.push([uv0[0] + (uvSize[0] * i) / nu, uv0[1] + (uvSize[1] * j) / nv]);
    }
  const id = (i: number, j: number): number => base + j * (nu + 1) + i;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      tm.tri.push({ v: [id(i, j), id(i + 1, j), id(i + 1, j + 1)], page, patch: name });
      tm.tri.push({ v: [id(i, j), id(i + 1, j + 1), id(i, j + 1)], page, patch: name });
    }
}

function texelSizes(tm: TexMesh): { size: number; area: number; patch: string }[] {
  const out: { size: number; area: number; patch: string }[] = [];
  for (const t of tm.tri) {
    const [a, b, c] = t.v;
    const area3 = 0.5 * len(cross(sub(tm.pos[b], tm.pos[a]), sub(tm.pos[c], tm.pos[a])));
    const ua = tm.uv[a];
    const ub = tm.uv[b];
    const uc = tm.uv[c];
    const areaUv = 0.5 * Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1]));
    const pg = tm.pages[t.page];
    const texels = areaUv * pg.w * pg.h;
    if (area3 <= 0 || texels <= 0) continue; // degenerate in 3D or in UV: no information
    out.push({ size: Math.sqrt(area3 / texels), area: area3, patch: t.patch });
  }
  return out;
}

/** Smallest value v such that the triangles with size <= v hold at least half the total area. */
function weightedMedian(items: { size: number; area: number }[]): number {
  const s = items.slice().sort((a, b) => a.size - b.size);
  const total = s.reduce((acc, x) => acc + x.area, 0);
  let cum = 0;
  for (const x of s) {
    cum += x.area;
    if (cum >= total / 2) return x.size;
  }
  return s[s.length - 1].size;
}

// ---------------------------------------------------------------------------------------------
// Quote lines: measured value -> quantity, exact decimal arithmetic (BigInt micro-units)
// ---------------------------------------------------------------------------------------------

type RoundingRule = 'up' | 'nearest' | 'none';

interface QuoteMapping {
  label: string;
  unit: string;
  extraPercent: number; // up to 2 decimals
  extraLabel: string;
  rounding: RoundingRule;
  step: number; // 1, 0.5 or 0.1
  min: number;
  decimals: number; // display decimals of the measured value and of the intermediate result (1 for m2, 2 for m)
}

const MICRO = 1000000n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b; // a, b > 0
const roundHalfUpDiv = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b); // a >= 0, b > 0

function microToNl(x: bigint, decimals: number, trimZeros = false): string {
  let d = decimals;
  if (trimZeros) while (d > 0 && x % 10n ** BigInt(6 - d + 1) === 0n) d--;
  return nl(Number(x) / 1e6, d);
}

function quoteLine(measuredRaw: number, q: QuoteMapping) {
  const md = q.decimals;
  const unitMicro = 10n ** BigInt(6 - md);
  const measured = BigInt(Math.round(measuredRaw * 10 ** md)) * unitMicro; // value as displayed
  const bp = BigInt(Math.round(q.extraPercent * 100)); // basis points
  const raw = measured * (10000n + bp);
  if (raw % 10000n !== 0n) throw new Error('inexact');
  const product = raw / 10000n; // exact
  const shownProduct = roundHalfUpDiv(product, unitMicro) * unitMicro; // as displayed, rule applies to this
  const stepMicro = BigInt(Math.round(q.step * 1e6));
  let rounded = shownProduct;
  if (q.rounding === 'up') rounded = ceilDiv(shownProduct, stepMicro) * stepMicro;
  else if (q.rounding === 'nearest') rounded = roundHalfUpDiv(shownProduct, stepMicro) * stepMicro;
  const minMicro = BigInt(Math.round(q.min * 1e6));
  const minApplied = rounded < minMicro;
  const quantity = minApplied ? minMicro : rounded;
  const stepDec = decimalsOf(q.step);
  const parts = [`${q.label}: ${microToNl(measured, md)} ${q.unit} gemeten`];
  if (bp !== 0n) parts[0] += ` + ${nl(q.extraPercent, decimalsOf(q.extraPercent))}% ${q.extraLabel} = ${microToNl(shownProduct, md)} ${q.unit}`;
  if (q.rounding !== 'none') parts.push(`afgerond ${microToNl(rounded, stepDec, true)} ${q.unit}`);
  if (minApplied) parts.push(`minimum ${microToNl(minMicro, decimalsOf(q.min), true)} ${q.unit}`);
  return { text: parts.join(', '), quantity: Number(quantity) / 1e6, product: Number(product) / 1e6 };
}

function naiveQuantity(measured: number, q: QuoteMapping): number {
  const x = measured * (1 + q.extraPercent / 100);
  const v = q.rounding === 'up' ? Math.ceil(x / q.step) * q.step : q.rounding === 'nearest' ? Math.round(x / q.step) * q.step : x;
  return Math.max(v, q.min);
}

// ---------------------------------------------------------------------------------------------
// Monte Carlo helper (Welford)
// ---------------------------------------------------------------------------------------------

function monteCarlo(trials: number, seed: number, fn: (rng: Rng) => number[]): { mean: number[]; std: number[] } {
  const rng = makeRng(seed);
  let mean: number[] = [];
  let m2: number[] = [];
  for (let i = 1; i <= trials; i++) {
    const x = fn(rng);
    if (i === 1) {
      mean = x.map(() => 0);
      m2 = x.map(() => 0);
    }
    for (let k = 0; k < x.length; k++) {
      const d = x[k] - mean[k];
      mean[k] += d / i;
      m2[k] += d * (x[k] - mean[k]);
    }
  }
  return { mean, std: m2.map((v) => Math.sqrt(v / (trials - 1))) };
}

const jitter3 = (p: V3, s: number, r: Rng): V3 => [p[0] + s * r.gauss(), p[1] + s * r.gauss(), p[2] + s * r.gauss()];
const jitter2 = (p: V2, s: number, r: Rng): V2 => [p[0] + s * r.gauss(), p[1] + s * r.gauss()];
const jitterEN = (p: V3, s: number, r: Rng): V3 => [p[0] + s * r.gauss(), p[1] + s * r.gauss(), p[2]];

// =============================================================================================
// Main
// =============================================================================================

const out: string[] = [];
const log = (s = ''): void => {
  out.push(s);
};
let failures = 0;
const check = (ok: boolean): string => {
  if (!ok) failures++;
  return ok ? 'ok' : 'FAIL';
};

const t0 = Date.now();
log('Measurement methods: reference prototype, algorithm version ' + PARAMS.algorithmVersion);
log('Parameters: ' + JSON.stringify(PARAMS));
log();

// --- Scene ------------------------------------------------------------------------------------
const NOISE = 0.003;
const NOISE_SEED = 20261009;
const FULL_SPACING = 0.25;
const LIGHT_SPACING = 1.0;
const fullClean = buildScene('full, noise-free', FULL_SPACING, 0, NOISE_SEED);
const full = buildScene('full (work.glb stand-in)', FULL_SPACING, NOISE, NOISE_SEED);
const light = buildScene('light (web.glb stand-in)', LIGHT_SPACING, NOISE, NOISE_SEED);
log('== 0. Synthetic property ==');
for (const m of [full, light])
  log(`  ${pad(m.name, 26)} ${padL(String(m.pos.length / 3), 6)} vertices ${padL(String(m.tri.length / 3), 6)} triangles`);
log(`  grid spacing full ${FULL_SPACING} m, light ${LIGHT_SPACING} m; vertex noise ${NOISE * 1000} mm per axis (seed ${NOISE_SEED}),`);
log('  identical where light and full vertices coincide (the light mesh keeps a subset of the full vertices).');
log('  house 10 x 8 m, eaves 6 m, ridge 10 m along east (45 deg); shed 4 x 3 m, 30 deg lean-to;');
log('  terrace 5 x 4 m raised 0.30 m; lawn 8 x 6 m z = 0.12 sin(2 pi x/3) sin(2 pi y/3); flat ground elsewhere.');
log();

// --- Effective resolution -----------------------------------------------------------------------
const tm: TexMesh = { pos: [], uv: [], tri: [], pages: [{ w: 8192, h: 8192 }, { w: 4096, h: 4096 }, { w: 2048, h: 2048 }] };
// roof: 6 x 5 m at 0.8 cm/texel on an 8192 page; ground: 6 x 5 m at 0.8 x 1.25 cm (anisotropic) on a
// 4096 page; wall: 8 x 5 m (vertical) at 2.0 cm on a 2048 page.
texPatch(tm, 'roof', [0, 0, 6], [6, 0, 0], [0, 5 * Math.SQRT1_2, 5 * Math.SQRT1_2], [0.01, 0.01], [6 / 0.008 / 8192, 5 / 0.008 / 8192], 0, 24, 20);
texPatch(tm, 'ground', [0, -10, 0], [6, 0, 0], [0, 5, 0], [0.02, 0.02], [6 / 0.008 / 4096, 5 / 0.0125 / 4096], 1, 12, 10);
texPatch(tm, 'wall', [10, 0, 0], [0, 8, 0], [0, 0, 5], [0.05, 0.05], [8 / 0.02 / 2048, 5 / 0.02 / 2048], 2, 4, 2);
const texels = texelSizes(tm);
const resolution = weightedMedian(texels);
const totalTexArea = texels.reduce((a, x) => a + x.area, 0);
const meanTexel = texels.reduce((a, x) => a + x.size * x.area, 0) / totalTexArea;
const triSorted = texels.map((x) => x.size).sort((a, b) => a - b);
const triMedian = triSorted[Math.floor((triSorted.length - 1) / 2)];
log('== 1. Effective resolution (synthetic textured mesh) ==');
for (const name of ['roof', 'ground', 'wall']) {
  const items = texels.filter((x) => x.patch === name);
  const a = items.reduce((s, x) => s + x.area, 0);
  log(`  ${pad(name, 7)} ${padL(String(items.length), 4)} triangles, ${f(a, 1)} m2 (${f((100 * a) / totalTexArea, 0)} %), texel ${f(items[0].size * 100, 3)} cm`);
}
log(`  per triangle: sqrt(area3D / (areaUV * texW * texH)); area-weighted median = ${f(resolution * 100, 4)} cm (expected 1.0000) ${check(Math.abs(resolution - 0.01) < 1e-12)}`);
log(`  for comparison: area-weighted mean ${f(meanTexel * 100, 4)} cm, unweighted median over triangles ${f(triMedian * 100, 4)} cm`);
const sigma = sigmaFromResolution(resolution);
const flagThreshold = Math.max(PARAMS.reprojectFlagMin, PARAMS.coverage * sigma);
log(`  sigma = ${PARAMS.sigmaFactor} x ${f(resolution * 100, 2)} cm = ${f(sigma * 100, 2)} cm per axis; shown +- per point = 2 sigma = ${f(2 * sigma * 100, 2)} cm`);
log(`  re-projection flag threshold = max(${PARAMS.reprojectFlagMin * 100} cm, 2 sigma) = ${f(flagThreshold * 100, 1)} cm (see section 5)`);
log();

// --- Picks: light mesh -> full mesh along the same ray -------------------------------------------
interface PickSpec {
  id: string;
  what: string;
  target: V3;
  view: V3; // direction from the target towards the camera
}
interface Pick extends PickSpec {
  camera: V3;
  dir: V3;
  light: V3;
  final: V3;
  delta: number;
  flagged: boolean;
}

const CAMERA_DISTANCE = 20;
const shedHigh = SHED.high;
const specs: PickSpec[] = [
  { id: 'P1', what: 'eave corner SW', target: [0, 0, 6], view: [-1, -1, 1] },
  { id: 'P2', what: 'eave corner SE', target: [10, 0, 6], view: [1, -1, 1] },
  { id: 'P3', what: 'ridge end E', target: [10, 4, 10], view: [0.4, 0, 1] },
  { id: 'P4', what: 'ridge end W', target: [0, 4, 10], view: [-0.4, 0, 1] },
  { id: 'P5', what: 'eave corner NW', target: [0, 8, 6], view: [-1, 1, 1] },
  { id: 'P6', what: 'eave corner NE', target: [10, 8, 6], view: [1, 1, 1] },
  { id: 'D1', what: 'driveway', target: [11, -4, 0], view: [0.3, -0.4, 1] },
  { id: 'D2', what: 'driveway', target: [17, -4, 0], view: [0.3, -0.4, 1] },
  { id: 'D3', what: 'driveway', target: [17, -1, 0], view: [0.3, -0.4, 1] },
  { id: 'D4', what: 'driveway', target: [11, -1, 0], view: [0.3, -0.4, 1] },
  { id: 'L1', what: 'lawn', target: [-12, 2, 0], view: [-0.3, -0.4, 1] },
  { id: 'L2', what: 'lawn', target: [-4, 2, 0], view: [-0.3, -0.4, 1] },
  { id: 'L3', what: 'lawn', target: [-4, 8, 0], view: [-0.3, -0.4, 1] },
  { id: 'L4', what: 'lawn', target: [-12, 8, 0], view: [-0.3, -0.4, 1] },
  { id: 'S1', what: 'shed eave SW', target: [20, 0, 2.5], view: [-1, -1, 1] },
  { id: 'S2', what: 'shed eave SE', target: [24, 0, 2.5], view: [1, -1, 1] },
  { id: 'S3', what: 'shed top NE', target: [24, 3, shedHigh], view: [1, 1, 1] },
  { id: 'S4', what: 'shed top NW', target: [20, 3, shedHigh], view: [-1, 1, 1] },
  { id: 'K1', what: 'kerb polygon', target: [14, 8, 0], view: [0.3, -0.4, 1] },
  { id: 'K2', what: 'kerb polygon', target: [17, 8, 0], view: [0.3, -0.4, 1] },
  { id: 'K3', what: 'kerb polygon', target: [17, 11, TERRACE.top], view: [0.3, -0.4, 1] },
  { id: 'K4', what: 'kerb polygon', target: [14, 11, TERRACE.top], view: [0.3, -0.4, 1] },
];
const L_SHAPE: V2[] = [
  [-10, -8],
  [-3, -8],
  [-3, -6],
  [-7, -6],
  [-7, -2],
  [-10, -2],
];
L_SHAPE.forEach((q, i) => specs.push({ id: `C${i + 1}`, what: 'L-shape', target: [q[0], q[1], 0], view: [0.2, 0.3, 1] }));

function pick(s: PickSpec): Pick {
  const camera = add(s.target, mul(unit(s.view), CAMERA_DISTANCE));
  const aim = unit(sub(s.target, camera));
  const hl = raycast(light, camera, aim); // browser: first hit on the light mesh
  if (!hl) throw new Error(`no light hit for ${s.id}`);
  const dir = unit(sub(hl.p, camera)); // stored view ray: camera -> picked point
  const hf = raycast(full, camera, dir); // server: same ray on the full mesh
  if (!hf) throw new Error(`no full hit for ${s.id}`);
  const delta = dist(hf.p, hl.p);
  return { ...s, camera, dir, light: hl.p, final: hf.p, delta, flagged: delta > flagThreshold };
}
const picks = new Map<string, Pick>();
for (const s of specs) picks.set(s.id, pick(s));
const P = (id: string): V3 => (picks.get(id) as Pick).final;
const T = (id: string): V3 => (specs.find((s) => s.id === id) as PickSpec).target;
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// --- Exact checks ------------------------------------------------------------------------------
const faceOpt: FaceOptions = {
  band: PARAMS.planeBand,
  margin: PARAMS.edgeMargin,
  flatRms: PARAMS.flatnessRmsMax,
  minVertices: PARAMS.minPlaneVertices,
};
log('== 2. Exact checks against known geometry ==');
log('  A = method on the noise-free full mesh with the exact points (must match to ~1e-9);');
log('  B = method on the noisy full mesh (3 mm) with the re-projected picks (light mesh -> full mesh along the view ray),');
log('      exactly as in the worked example; B must lie within the shown +-2 sigma of that value (sigma = 2 cm per point).');
log(`  ${pad('test', 46)} ${padL('expected', 9)} ${padL('A', 9)} ${padL('|A-exp|', 7)} ${padL('B', 9)} ${padL('|B-exp|', 7)} ${padL('+-2sigma', 8)}`);
const row = (name: string, exp: number, a: number, b: number, pm: number | null, tolA = 1e-9): void => {
  const okA = Math.abs(a - exp) <= tolA;
  const okB = pm === null || Math.abs(b - exp) <= pm;
  log(
    `  ${pad(name, 46)} ${padL(f(exp), 9)} ${padL(f(a), 9)} ${padL(fe(Math.abs(a - exp)), 7)} ${padL(f(b), 9)} ${padL(fe(Math.abs(b - exp)), 7)} ${padL(pm === null ? '-' : f(pm), 8)} ${check(okA && okB)}`,
  );
};
const EN = (pts: V3[]): V2[] => pts.map((p) => [p[0], p[1]]);
const UP: V3 = [0, 0, 1];
row('distance eave P1-P2 (m)', 10, distance3d(T('P1'), T('P2')), distance3d(P('P1'), P('P2')), 2 * sigmaDistance(sigma));
const eavePts = ['P5', 'P1', 'P2', 'P6'];
row('polyline eaves P5-P1-P2-P6, 3 edges (m)', 26, polylineLength(eavePts.map(T)), polylineLength(eavePts.map(P)), 2 * sigmaPolyline(eavePts.map(P), sigma));
row('height eave P1 to ridge P4 (m)', 4, heightDiff(T('P1'), T('P4')), heightDiff(P('P1'), P('P4')), 2 * sigmaHeight(sigma));
const roofA = measureFace(fullClean, ids('P', 4).map(T), faceOpt);
const roofB = measureFace(full, ids('P', 4).map(P), faceOpt);
const pmPitch = (fr: FaceResult): number => 2 * sigmaPitchShownRad(Math.max(fr.rms, sigma), fr.sumS2, sigma, fr.poly2) * DEG;
row('roof face 45: area along the slope (m2)', 40 * Math.SQRT2, roofA.areaSlope, roofB.areaSlope, 2 * sigmaPolygonArea(roofB.poly2, sigma));
row('roof face 45: area from above (m2)', 40, roofA.areaPlan, roofB.areaPlan, 2 * sigmaPolygonArea(EN(roofB.polyOnPlane), sigma));
row('roof face 45: ratio slope / above', Math.SQRT2, roofA.areaSlope / roofA.areaPlan, roofB.areaSlope / roofB.areaPlan, null);
row('roof face 45: pitch (deg)', 45, roofA.pitch, roofB.pitch, pmPitch(roofB));
row('roof face 45: flatness RMS (m)', 0, roofA.rms, roofB.rms, null);
const shedA = measureFace(fullClean, ids('S', 4).map(T), faceOpt);
const shedB = measureFace(full, ids('S', 4).map(P), faceOpt);
row('shed face 30: area along the slope (m2)', 8 * Math.sqrt(3), shedA.areaSlope, shedB.areaSlope, 2 * sigmaPolygonArea(shedB.poly2, sigma));
row('shed face 30: area from above (m2)', 12, shedA.areaPlan, shedB.areaPlan, 2 * sigmaPolygonArea(EN(shedB.polyOnPlane), sigma));
row('shed face 30: ratio slope / above', 2 / Math.sqrt(3), shedA.areaSlope / shedA.areaPlan, shedB.areaSlope / shedB.areaPlan, null);
row('shed face 30: pitch (deg)', 30, shedA.pitch, shedB.pitch, pmPitch(shedB));
const groundRows = (label: string, picksB: V3[], resA: GroundResult, resB: GroundResult, expSurface: number, expPlan: number, expSteep: number | null): void => {
  row(`${label}: mesh area (m2)`, expSurface, resA.surface.area, resB.surface.area, 2 * sigmaClippedArea(full, picksB, UP, resB.slab, null, sigma));
  if (expSteep !== null) row(`${label}: of which steep (m2)`, expSteep, resA.surface.steepArea, resB.surface.steepArea, null);
  row(`${label}: area from above (m2)`, expPlan, resA.areaPlan, resB.areaPlan, 2 * sigmaPolygonArea(EN(picksB), sigma));
};
const drvA = measureGround(fullClean, ids('D', 4).map(T));
const drvB = measureGround(full, ids('D', 4).map(P));
groundRows('driveway 6x3', ids('D', 4).map(P), drvA, drvB, 18, 18, null);
const lA = measureGround(fullClean, L_SHAPE.map((q) => [q[0], q[1], 0] as V3));
const lB = measureGround(full, ids('C', 6).map(P));
groundRows('L-shape (concave)', ids('C', 6).map(P), lA, lB, 26, 26, null);
const lRev = measureGround(fullClean, L_SHAPE.slice().reverse().map((q) => [q[0], q[1], 0] as V3));
row('L-shape, clockwise: mesh area (m2)', 26, lRev.surface.area, lRev.surface.area, null);
const kA = measureGround(fullClean, ids('K', 4).map(T));
const kB = measureGround(full, ids('K', 4).map(P));
groundRows('kerb polygon 3x3', ids('K', 4).map(P), kA, kB, 9.9, 9, 0.9);

// Lawn: independent references.
let lawnMeshRef = 0;
for (let t = 0; t < fullClean.tri.length / 3; t++) {
  const c = mul(add(add(vtx(fullClean, fullClean.tri[3 * t]), vtx(fullClean, fullClean.tri[3 * t + 1])), vtx(fullClean, fullClean.tri[3 * t + 2])), 1 / 3);
  if (c[0] > LAWN.e0 && c[0] < LAWN.e1 && c[1] > LAWN.n0 && c[1] < LAWN.n1 && Math.abs(c[2]) < 0.2) lawnMeshRef += triArea(fullClean, t);
}
function lawnSurfaceIntegral(): number {
  // composite Simpson on sqrt(1 + zx^2 + zy^2) over the 8 x 6 m rectangle
  const nx = 1600;
  const ny = 1200;
  const hx = (LAWN.e1 - LAWN.e0) / nx;
  const hy = (LAWN.n1 - LAWN.n0) / ny;
  const k = (2 * Math.PI) / LAWN.period;
  let s = 0;
  for (let i = 0; i <= nx; i++) {
    const wx = i === 0 || i === nx ? 1 : i % 2 ? 4 : 2;
    const x = i * hx;
    for (let j = 0; j <= ny; j++) {
      const wy = j === 0 || j === ny ? 1 : j % 2 ? 4 : 2;
      const y = j * hy;
      const zx = LAWN.amp * k * Math.cos(k * x) * Math.sin(k * y);
      const zy = LAWN.amp * k * Math.sin(k * x) * Math.cos(k * y);
      s += wx * wy * Math.sqrt(1 + zx * zx + zy * zy);
    }
  }
  return (s * hx * hy) / 9;
}
const lawnTrue = lawnSurfaceIntegral();
const lawnPicksExact = ids('L', 4).map(T);
const lawnFaceA = measureFace(fullClean, lawnPicksExact, faceOpt);
const lawnFaceB = measureFace(full, ids('L', 4).map(P), faceOpt);
const lawnGA = measureGround(fullClean, lawnPicksExact);
const lawnGB = measureGround(full, ids('L', 4).map(P));
groundRows('lawn 8x6', ids('L', 4).map(P), lawnGA, lawnGB, lawnMeshRef, 48, null);
log(
  `  lawn as a face: plane-fit RMS A ${f(lawnFaceA.rms)} m, B ${f(lawnFaceB.rms)} m > ${PARAMS.flatnessRmsMax} m -> not flat, clipped mesh area used: ` +
    `A ${f(lawnFaceA.area)}, B ${f(lawnFaceB.area)} (${lawnFaceB.method}) ${check(!lawnFaceA.flat && !lawnFaceB.flat)}`,
);
log('  (kerb polygon: 3x3 m crossing the 0.30 m kerb over 3.00 m, so the mesh area includes the 0.90 m2 kerb face;');
log('   lawn: the expected mesh area is the sum of the noise-free triangles inside, an independent reference)');
log(`  lawn: true surface (Simpson integral) ${f(lawnTrue)} m2; the 0.25 m mesh has ${f(lawnMeshRef)} m2 (${f((100 * (lawnMeshRef - lawnTrue)) / lawnTrue, 3)} %);`);
log(`        surface / from above = ${f(lawnGB.surface.area / lawnGB.areaPlan)} (worked example)`);

// Ear clipping on its own: several concave polygons, both windings, a collinear vertex.
{
  const polys: [string, V2[]][] = [
    ['L-shape', L_SHAPE],
    ['L-shape + collinear vertex', [[-10, -8], [-6, -8], [-3, -8], [-3, -6], [-7, -6], [-7, -2], [-10, -2]]],
    ['comb (3 teeth)', [[0, 0], [7, 0], [7, 3], [6, 3], [6, 1], [4, 1], [4, 3], [3, 3], [3, 1], [1, 1], [1, 3], [0, 3]]],
    ['star (10 points)', Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 1 : 3; const a = (i * Math.PI) / 5; return [r * Math.cos(a), r * Math.sin(a)] as V2; })],
  ];
  for (const [name, poly] of polys)
    for (const wind of ['ccw', 'cw']) {
      const p = wind === 'cw' ? poly.slice().reverse() : poly;
      const tris = earClip(p);
      const sum = tris.reduce((s, [a, b, c]) => s + shoelace([p[a], p[b], p[c]]), 0);
      const okAll = tris.every(([a, b, c]) => shoelace([p[a], p[b], p[c]]) > 0);
      log(`  ear clipping ${pad(name + ' ' + wind, 34)} ${String(tris.length).padStart(2)} ears, sum ${f(sum)} = |shoelace| ${f(Math.abs(shoelace(p)))} ${check(okAll && Math.abs(sum - Math.abs(shoelace(p))) < 1e-9)}`);
    }
  let caught = '';
  try {
    earClip([[0, 0], [4, 0], [0, 4], [4, 4]]);
  } catch (e) {
    caught = (e as Error).message;
  }
  log(`  self-intersecting bow tie rejected: ${caught} ${check(caught === 'polygon_self_intersecting')}`);
}

// Jacobi self-test.
{
  const r = makeRng(7);
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const a = [r.gauss(), r.gauss(), r.gauss(), r.gauss(), r.gauss(), r.gauss()];
    const M = [[a[0], a[1], a[2]], [a[1], a[3], a[4]], [a[2], a[4], a[5]]];
    const { values, vectors } = jacobiEigenSym3(M);
    for (let j = 0; j < 3; j++) {
      const v = vectors[j];
      const Mv: V3 = [dot(M[0] as V3, v), dot(M[1] as V3, v), dot(M[2] as V3, v)];
      worst = Math.max(worst, len(sub(Mv, mul(v, values[j]))));
    }
  }
  log(`  Jacobi: max |M v - lambda v| over 200 random symmetric 3x3 matrices = ${fe(worst)} ${check(worst < 1e-12)}`);
}

// Why the edge margin: same roof face, margin 0 (vertex selection exactly as the bare method).
{
  const exactOnNoisy = measureFace(full, ids('P', 4).map(T), faceOpt);
  const m0 = measureFace(full, ids('P', 4).map(T), { ...faceOpt, margin: 0 });
  log('  edge margin (noisy mesh, exact corner points): margin 0 vs 0.25 m');
  for (const [name, r] of [['margin 0.00', m0], ['margin 0.25', exactOnNoisy]] as [string, FaceResult][])
    log(`    ${name}: vertices ${r.counts.join(' -> ')}, RMS ${f(r.rms)} m, pitch ${f(r.pitch, 3)} deg, slope area ${f(r.areaSlope)} m2`);
  log('    (with margin 0, vertices of the north face and the gable walls project onto the ridge and rake edges');
  log('     and lie within the 0.30 m band, so they leak into the fit)');
}

// Drawn 2 cm into the facade: why the slab and the steep-area readout.
{
  const poly: V3[] = [[2, -3, 0], [8, -3, 0], [8, 0.02, 0], [2, 0.02, 0]];
  const noSlab = measureGround(full, poly, false);
  const slab = measureGround(full, poly, true);
  log('  ground polygon drawn 2 cm into the house facade (6 x 3.02 m, from above 18.12 m2):');
  log(`    no slab:   mesh area ${f(noSlab.surface.area, 3)} m2, of which steep ${f(noSlab.surface.steepArea, 3)} m2 (facade 6 m high + roof strip)`);
  log(`    with slab: mesh area ${f(slab.surface.area, 3)} m2, of which steep ${f(slab.surface.steepArea, 3)} m2 (slab ${f(slab.slab![0], 2)} .. ${f(slab.slab![1], 2)} m)`);
}
log();

// --- Worked example ----------------------------------------------------------------------------
// Fictional job origin in UTM zone 31N (EPSG:32631) in Eindhoven; Terra-style SRSOrigin (full doubles).
const ORIGIN: V3 = [671842.3164090217, 5702113.884057588, 63.71899999957532];
const toCrs = (p: V3): V3 => add(ORIGIN, p);
log('== 3. Worked example ==');
log('  metadata.xml (Terra style; vertices in the OBJ are offsets from SRSOrigin):');
log('    <SRS>EPSG:32631</SRS>');
log(`    <SRSOrigin>${ORIGIN.join(',')}</SRSOrigin>`);
log('  The first scan fixes the job origin = SRSOrigin, so job-local = OBJ coordinates; original = local + origin.');
log('  Vertical datum of the origin: unknown in this example, so only relative heights are shown.');
log(`  Resolution ${f(resolution * 100, 2)} cm -> sigma ${f(sigma * 100, 2)} cm; flag threshold ${f(flagThreshold * 100, 1)} cm.`);
log();
log('  3.1 Picks: camera -> light mesh hit (browser) -> same ray on the full mesh (server)');
log(`  ${pad('id', 3)} ${pad('what', 15)} ${pad('camera E,N,U', 26)} ${pad('ray direction', 25)} ${pad('light hit E,N,U', 26)} ${pad('final E,N,U', 26)} ${padL('diff mm', 7)} flag`);
const wanted = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'D1', 'D2', 'D3', 'D4', 'L1', 'L2', 'L3', 'L4'];
for (const id of wanted) {
  const p = picks.get(id) as Pick;
  log(`  ${pad(id, 3)} ${pad(p.what, 15)} ${pad(fv(p.camera, 3), 26)} ${pad(fv(p.dir, 4), 25)} ${pad(fv(p.light, 4), 26)} ${pad(fv(p.final, 4), 26)} ${padL(f(p.delta * 1000, 1), 7)} ${p.flagged ? 'YES' : 'no'}`);
}
log();
log('  3.2 Final points in the original CRS (EPSG:32631, E / N / h = local + SRSOrigin)');
for (const id of wanted) {
  const p = picks.get(id) as Pick;
  const c = toCrs(p.final);
  log(`  ${pad(id, 3)} local ${pad(fv(p.final, 4), 28)} UTM31N E ${f(c[0], 4)}  N ${f(c[1], 4)}  h ${f(c[2], 4)}`);
}
log();

log('  3.3 Values, uncertainty and what people see');
const dEave = distance3d(P('P1'), P('P2'));
const sD = sigmaDistance(sigma);
log(`  Distance P1-P2: |P2 - P1| = ${f(dEave)} m (exact 10.0000); sigma_d = sigma*sqrt2 = ${f(sD)} m; 2 sigma = ${f(2 * sD)} -> +- ${f(shown(sD, PARAMS.displayStep.length), 2)} m`);
log(`    shown: "${nl(dEave, 2)} m ± ${nl(shown(sD, 0.01) * 100, 0)} cm"`);
const polyPts = eavePts.map(P);
const Lval = polylineLength(polyPts);
const sL = sigmaPolyline(polyPts, sigma);
log(`  Length P5-P1-P2-P6: ${polyPts.slice(1).map((p, i) => f(dist(polyPts[i], p))).join(' + ')} = ${f(Lval)} m (exact 26.0000)`);
log(`    sigma_L = sigma*sqrt(sum |u_(i-1) - u_i|^2) = ${f(sigma, 3)} * sqrt(${f((sL / sigma) ** 2, 4)}) = ${f(sL)} m -> +- ${f(shown(sL, 0.01), 2)} m; shown: "${nl(Lval, 2)} m ± ${nl(shown(sL, 0.01) * 100, 0)} cm"`);
const hVal = heightDiff(P('P1'), P('P4'));
const sH = sigmaHeight(sigma);
log(`  Height P1 -> P4: U4 - U1 = ${f(P('P4')[2])} - ${f(P('P1')[2])} = ${f(hVal)} m (exact 4.0000); sigma_h = ${f(sH)} -> +- ${f(shown(sH, 0.01), 2)} m; shown: "${nl(hVal, 2)} m ± ${nl(shown(sH, 0.01) * 100, 0)} cm"`);
log();
const r = roofB;
log('  Roof face P1-P2-P3-P4 (plane fit):');
log(`    provisional plane through the 4 picks: n = ${fv(r.provisional.n, 5)}, c = ${fv(r.provisional.c, 4)}`);
log(`    pass 1: ${r.counts[0]} vertices (|d| <= ${PARAMS.planeBand} m, inside the polygon, >= ${PARAMS.edgeMargin} m from its edges); pass 2 with the fitted plane: ${r.counts[1]} vertices`);
log(`    fitted plane: c = ${fv(r.plane.c, 4)}, n = ${fv(r.plane.n, 6)}, eigenvalues ${r.plane.eig.map((x) => x.toExponential(4)).join(', ')}`);
log(`    flatness RMS = ${f(r.rms * 1000, 2)} mm (<= ${PARAMS.flatnessRmsMax * 1000} mm: flat, plane method)`);
log(`    in-plane basis e1 = ${fv(planeBasis(r.plane.n)[0], 6)}, e2 (up the slope) = ${fv(planeBasis(r.plane.n)[1], 6)}`);
log(`    polygon in plane coordinates: ${r.poly2.map((q) => `(${f(q[0])}, ${f(q[1])})`).join(' ')}`);
log(`    area along the slope = |shoelace| = ${f(r.areaSlope)} m2 (exact ${f(40 * Math.SQRT2)})`);
log(`    projected polygon E/N: ${r.polyOnPlane.map((p) => `(${f(p[0])}, ${f(p[1])})`).join(' ')}`);
log(`    area from above = ${f(r.areaPlan)} m2 (exact 40.0000); ratio ${f(r.areaSlope / r.areaPlan, 5)} (sqrt2 = ${f(Math.SQRT2, 5)})`);
log(`    pitch = atan2(sqrt(nx^2+ny^2), nz) = ${f(r.pitch, 4)} deg (exact 45)`);
const sAs = sigmaPolygonArea(r.poly2, sigma);
const sAp = sigmaPolygonArea(r.polyOnPlane.map((p) => [p[0], p[1]] as V2), sigma);
const sigmaV = Math.max(r.rms, sigma);
const sThFit = sigmaPitchRad(sigmaV, r.sumS2) * DEG;
const sThFloor = sigmaPitchFloorRad(sigma, r.poly2) * DEG;
const sTh = sigmaPitchShownRad(sigmaV, r.sumS2, sigma, r.poly2) * DEG;
log(`    sigma(area slope) = sigma/2 * sqrt(sum |v(i+1)-v(i-1)|^2) = ${f(sAs)} m2 -> +- ${f(shown(sAs, 0.1), 1)} m2`);
log(`    sigma(area above) (E/N) = ${f(sAp)} m2 -> +- ${f(shown(sAp, 0.1), 1)} m2`);
log(`    sigma_v = max(RMS ${f(r.rms, 4)}, sigma ${f(sigma, 4)}) = ${f(sigmaV, 4)} m; sum ((p_i - c).u_dip)^2 = ${f(r.sumS2, 1)} m2 over ${r.selected.length} vertices`);
log(`    sigma(pitch), fit = sigma_v / sqrt(sum) = ${f(sThFit, 5)} deg (independent vertex errors)`);
log(`    sigma(pitch), floor = sqrt2 * sigma / dip extent ${f(dipExtent(r.poly2), 4)} m = ${f(sThFloor, 5)} deg (two points at the ends of the face)`);
log(`    sigma(pitch) = max(fit, floor) = ${f(sTh, 5)} deg -> +- ${f(shown(sTh, 0.1), 1)} deg`);
log(`    shown: "Oppervlakte langs de helling: ${nl(r.areaSlope, 1)} m² ± ${nl(shown(sAs, 0.1), 1)} m²", "Oppervlakte van boven gezien: ${nl(r.areaPlan, 1)} m² ± ${nl(shown(sAp, 0.1), 1)} m²", "Hellingshoek: ${nl(r.pitch, 1)}° ± ${nl(shown(sTh, 0.1), 1)}°"`);
log();
const g = drvB;
const sGp = sigmaPolygonArea(EN(ids('D', 4).map(P)), sigma);
const sGs = sigmaClippedArea(full, ids('D', 4).map(P), UP, g.slab, null, sigma);
log('  Driveway D1-D4 (ground area, vertical prism):');
log(`    slab U ${f(g.slab![0], 3)} .. ${f(g.slab![1], 3)} m; ${g.surface.ears} ears; mesh area ${f(g.surface.area)} m2 (steep ${f(g.surface.steepArea)}), from above ${f(g.areaPlan)} m2 (exact 18)`);
log(`    sigma(from above) = ${f(sGp)} m2 -> +- ${f(shown(sGp, 0.1), 1)} m2; sigma(mesh area), numerical gradient = ${f(sGs)} m2 -> +- ${f(shown(sGs, 0.1), 1)} m2`);
log(`    shown: "Oppervlakte over het terrein: ${nl(g.surface.area, 1)} m² ± ${nl(shown(sGs, 0.1), 1)} m²", "van boven gezien: ${nl(g.areaPlan, 1)} m² ± ${nl(shown(sGp, 0.1), 1)} m²"`);
log();
const kk = kB;
const sKp = sigmaPolygonArea(EN(ids('K', 4).map(P)), sigma);
const sKs = sigmaClippedArea(full, ids('K', 4).map(P), UP, kk.slab, null, sigma);
log('  Kerb polygon K1-K4 (ground area across a 0.30 m kerb):');
log(`    mesh area ${f(kk.surface.area)} m2, of which steep ${f(kk.surface.steepArea)} m2 (kerb face), from above ${f(kk.areaPlan)} m2`);
log(`    sigma(mesh area), numerical gradient = ${f(sKs)} m2 -> +- ${f(shown(sKs, 0.1), 1)}; sigma(from above) = ${f(sKp)} -> +- ${f(shown(sKp, 0.1), 1)}`);
log(`    shown: "Oppervlakte over het terrein: ${nl(kk.surface.area, 1)} m² ± ${nl(shown(sKs, 0.1), 1)} m² (waarvan ${nl(kk.surface.steepArea, 1)} m² steile vlakken)", "van boven gezien: ${nl(kk.areaPlan, 1)} m² ± ${nl(shown(sKp, 0.1), 1)} m²"`);
log();
const lf = lawnFaceB;
const lg = lawnGB;
const sLp = sigmaPolygonArea(EN(ids('L', 4).map(P)), sigma);
const sLs = sigmaClippedArea(full, ids('L', 4).map(P), UP, lg.slab, null, sigma);
const lfW = dot(lf.plane.c, lf.plane.n);
const sLf = sigmaClippedArea(full, lf.polyOnPlane, lf.plane.n, [lfW - PARAMS.planeBand, lfW + PARAMS.planeBand], null, sigma);
log('  Lawn L1-L4, measured as a face (plane fit) and as ground:');
log(`    as a face: ${lf.counts.join(' -> ')} vertices, RMS ${f(lf.rms * 1000, 1)} mm > ${PARAMS.flatnessRmsMax * 1000} mm -> not flat; area = mesh clipped along the plane normal (slab +-${PARAMS.planeBand} m) = ${f(lf.area)} m2`);
log(`               (the polygon on the plane would give ${f(lf.areaSlope)} m2); sigma(mesh area) = ${f(sLf)} m2; pitch ${f(lf.pitch, 3)} deg`);
log(`    as ground: mesh area ${f(lg.surface.area)} m2, from above ${f(lg.areaPlan)} m2, ratio ${f(lg.surface.area / lg.areaPlan, 4)}; sigma(mesh) = ${f(sLs)} -> +- ${f(shown(sLs, 0.1), 1)} m2, sigma(above) = ${f(sLp)} -> +- ${f(shown(sLp, 0.1), 1)} m2`);
log(`    shown: "Oppervlakte over het terrein: ${nl(lg.surface.area, 1)} m² ± ${nl(shown(sLs, 0.1), 1)} m² (niet vlak: oppervlakte van het 3D-model binnen de vorm)", "van boven gezien: ${nl(lg.areaPlan, 1)} m² ± ${nl(shown(sLp, 0.1), 1)} m²"`);
log();

// --- Monte Carlo -------------------------------------------------------------------------------
log('== 4. Monte Carlo validation of the propagation formulas ==');
log(`  sigma = ${f(sigma, 4)} m per axis unless stated; Gaussian noise; empirical std vs predicted sigma.`);
log(`  ${pad('quantity', 70)} ${padL('trials', 6)} ${padL('predicted', 10)} ${padL('empirical', 10)} ${padL('ratio', 7)}`);
interface McRow {
  quantity: string;
  trials: number;
  predicted: number;
  empirical: number;
  ratio: number;
  isFormulaCheck: boolean;
}
const mcRows: McRow[] = [];
const mcLog = (quantity: string, trials: number, predicted: number, empirical: number, formulaCheck = true, tol = 0.03): void => {
  const ratio = empirical / predicted;
  mcRows.push({ quantity, trials, predicted, empirical, ratio, isFormulaCheck: formulaCheck });
  log(`  ${pad(quantity, 70)} ${padL(String(trials), 6)} ${padL(f(predicted, 5), 10)} ${padL(f(empirical, 5), 10)} ${padL(f(ratio, 4), 7)} ${formulaCheck ? check(Math.abs(ratio - 1) <= tol) : '(info)'}`);
};
const N_FAST = 50000;
const N_SLOW = 20000;
{
  const a = P('P1');
  const b = P('P2');
  const mc = monteCarlo(N_FAST, 101, (rg) => [distance3d(jitter3(a, sigma, rg), jitter3(b, sigma, rg))]);
  mcLog('distance P1-P2 (m), 3D noise', N_FAST, sigmaDistance(sigma), mc.std[0]);
}
{
  const mc = monteCarlo(N_FAST, 102, (rg) => [polylineLength(polyPts.map((p) => jitter3(p, sigma, rg)))]);
  mcLog('polyline eaves P5-P1-P2-P6 (m), 3D noise', N_FAST, sigmaPolyline(polyPts, sigma), mc.std[0]);
  const zig: V3[] = [[0, 0, 0], [3, 1, 0.5], [4, 4, 1.5], [7, 3, 1], [8, 6, 3], [6, 7, 2]];
  const mc2 = monteCarlo(N_FAST, 103, (rg) => [polylineLength(zig.map((p) => jitter3(p, sigma, rg)))]);
  mcLog('polyline 3D zigzag, 5 edges, mixed angles (m), 3D noise', N_FAST, sigmaPolyline(zig, sigma), mc2.std[0]);
}
{
  const a = P('P1');
  const b = P('P4');
  const mc = monteCarlo(N_FAST, 104, (rg) => [heightDiff(jitter3(a, sigma, rg), jitter3(b, sigma, rg))]);
  mcLog('height P1 -> P4 (m), 3D noise', N_FAST, sigmaHeight(sigma), mc.std[0]);
}
{
  const mc = monteCarlo(N_FAST, 105, (rg) => [Math.abs(shoelace(r.poly2.map((q) => jitter2(q, sigma, rg))))]);
  mcLog('roof area along the slope (m2), in-plane noise', N_FAST, sAs, mc.std[0]);
  const en: V2[] = r.polyOnPlane.map((p) => [p[0], p[1]]);
  const mc2 = monteCarlo(N_FAST, 106, (rg) => [Math.abs(shoelace(en.map((q) => jitter2(q, sigma, rg))))]);
  mcLog('roof area from above (m2), E/N noise', N_FAST, sAp, mc2.std[0]);
  const lEN: V2[] = ids('C', 6).map((id) => [P(id)[0], P(id)[1]]);
  const mc3 = monteCarlo(N_FAST, 107, (rg) => [Math.abs(shoelace(lEN.map((q) => jitter2(q, sigma, rg))))]);
  mcLog('L-shape (concave) area from above (m2), E/N noise', N_FAST, sigmaPolygonArea(lEN, sigma), mc3.std[0]);
}
{
  const base = ids('P', 4).map(P);
  const [lo, hi] = bbox(base, PARAMS.planeBand + 0.3);
  const cand = verticesNear(full, lo, hi);
  const mc = monteCarlo(N_SLOW, 108, (rg) => {
    const res = measureFace(full, base.map((p) => jitter3(p, sigma, rg)), faceOpt, cand);
    return [res.areaSlope, res.areaPlan, res.pitch];
  });
  mcLog('roof area along the slope (m2), full 3D noise, whole method', N_SLOW, sAs, mc.std[0]);
  mcLog('roof area from above (m2), full 3D noise, whole method', N_SLOW, sAp, mc.std[1], false);
  mcLog(`  same, vs |n_z| * sigma(slope) = ${f(Math.abs(r.plane.n[2]), 4)} * ${f(sAs, 4)}`, N_SLOW, Math.abs(r.plane.n[2]) * sAs, mc.std[1], false);
  log(`  ${pad('  (pitch spread from moving the picks only: ' + f(mc.std[2], 5) + ' deg; the picks only steer the vertex selection)', 64)}`);
}
for (const [name, face] of [['45 deg roof face', r], ['30 deg shed face', shedB]] as [string, FaceResult][]) {
  const sv = Math.max(face.rms, sigma);
  const mc = monteCarlo(N_SLOW, 109, (rg) => [pitchDeg(fitPlane(face.selected.map((p) => jitter3(p, sv, rg))).n)]);
  mcLog(`pitch ${name} (deg), ${face.selected.length} vertices, 3D noise sigma_v`, N_SLOW, sigmaPitchRad(sv, face.sumS2) * DEG, mc.std[0]);
}
for (const [name, idsG, res] of [
  ['driveway', ids('D', 4), drvB],
  ['lawn (mole hills)', ids('L', 4), lawnGB],
  ['kerb polygon (with kerb face)', ids('K', 4), kB],
] as [string, string[], GroundResult][]) {
  const base = idsG.map(P);
  const [lo, hi] = bbox(base, 0.5);
  const cand = trianglesNear(full, lo, hi);
  const pred = sigmaClippedArea(full, base, UP, res.slab, cand, sigma);
  const mc = monteCarlo(N_SLOW, 110, (rg) => [measureGround(full, base.map((p) => jitterEN(p, sigma, rg)), true, cand).surface.area]);
  mcLog(`mesh area ${name} (m2), E/N noise, gradient`, N_SLOW, pred, mc.std[0]);
  if (name.startsWith('kerb')) {
    const scaled = (res.surface.area / res.areaPlan) * sigmaPolygonArea(EN(base), sigma);
    mcLog('  same, vs shortcut (mesh/above) * polygon formula', N_SLOW, scaled, mc.std[0], false);
  }
}
{
  // Lawn measured as a face: not flat, so the mesh area clipped along the fitted plane normal is used.
  // Formula check with the plane fixed: perturb the polygon in the plane (e1, e2).
  const lf = lawnFaceB;
  const [e1, e2] = planeBasis(lf.plane.n);
  const w = dot(lf.plane.c, lf.plane.n);
  const slab: V2 = [w - PARAMS.planeBand, w + PARAMS.planeBand];
  const [lo, hi] = bbox(lf.polyOnPlane, 0.5);
  const cand = trianglesNear(full, lo, hi);
  const pred = sigmaClippedArea(full, lf.polyOnPlane, lf.plane.n, slab, cand, sigma);
  const mc = monteCarlo(N_SLOW, 111, (rg) => {
    const poly = lf.polyOnPlane.map((p) => add(p, add(mul(e1, sigma * rg.gauss()), mul(e2, sigma * rg.gauss()))));
    return [clipMeshToPrism(full, poly, lf.plane.n, slab, cand).area];
  });
  mcLog('lawn as a face (not flat): mesh area along normal (m2), in-plane', N_SLOW, pred, mc.std[0]);
}
log();

// --- Re-projection study -------------------------------------------------------------------------
log('== 5. Light vs full mesh along the view ray (flag threshold) ==');
{
  const rg = makeRng(202);
  const nT = light.tri.length / 3;
  const cum = new Float64Array(nT);
  let acc = 0;
  for (let t = 0; t < nT; t++) {
    acc += triArea(light, t);
    cum[t] = acc;
  }
  const deltas: { d: number; cat: string; light: V3; final: V3 | null; cam: V3 }[] = [];
  const N_RAYS = 3000;
  for (let k = 0; k < N_RAYS; k++) {
    const x = rg.uniform() * acc;
    let lo = 0;
    let hi = nT - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = rg.uniform();
    let v = rg.uniform();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const a = vtx(light, light.tri[3 * lo]);
    const target = add(a, add(mul(sub(vtx(light, light.tri[3 * lo + 1]), a), u), mul(sub(vtx(light, light.tri[3 * lo + 2]), a), v)));
    const az = rg.uniform() * 2 * Math.PI;
    const el = (30 + 50 * rg.uniform()) / DEG;
    const range = 15 + 25 * rg.uniform();
    const cam = add(target, mul([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)], range));
    const hl = raycast(light, cam, unit(sub(target, cam)));
    if (!hl) continue;
    const dir = unit(sub(hl.p, cam));
    const hf = raycast(full, cam, dir);
    const p = hl.p;
    const cat = inLawn(p[0], p[1]) && Math.abs(p[2]) < 0.5 ? 'lawn (curved)' : 'planar surfaces';
    deltas.push({ d: hf ? dist(hf.p, p) : Infinity, cat, light: p, final: hf ? hf.p : null, cam });
  }
  const pct = (xs: number[], q: number): number => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  log(`  ${deltas.length} random picks: target sampled by area on the light mesh, camera 15-40 m away at 30-80 deg elevation.`);
  log('  diff = |full-mesh hit - light-mesh hit| along the same ray (both points lie on the ray, so it is a depth difference).');
  const limits = [0.05, 0.1, 0.15, 0.25, 0.5];
  log(`  ${pad('surface', 16)} ${padL('n', 5)} ${padL('median', 8)} ${padL('p95', 8)} ${padL('p99', 8)} ${padL('max', 9)}   share above ${limits.map((x) => `${x * 100} cm`).join(' / ')}`);
  for (const cat of ['planar surfaces', 'lawn (curved)', 'all']) {
    const xs = deltas.filter((x) => cat === 'all' || x.cat === cat).map((x) => x.d).sort((a, b) => a - b);
    const shares = limits.map((lim) => `${f((100 * xs.filter((x) => x > lim).length) / xs.length, 1)} %`);
    log(`  ${pad(cat, 16)} ${padL(String(xs.length), 5)} ${padL(f(pct(xs, 0.5) * 1000, 1) + ' mm', 8)} ${padL(f(pct(xs, 0.95) * 1000, 1) + ' mm', 8)} ${padL(f(pct(xs, 0.99) * 1000, 1) + ' mm', 8)} ${padL(f(xs[xs.length - 1], 3) + ' m', 9)}   ${shares.join(' / ')}`);
  }
  const flagged = deltas.filter((x) => x.d > flagThreshold).length;
  log(`  with the proposed threshold (${f(flagThreshold * 100, 0)} cm): ${flagged} of ${deltas.length} picks flagged (${f((100 * flagged) / deltas.length, 2)} %)`);
  const worst = deltas.reduce((a, b) => (b.d > a.d ? b : a));
  log(`  largest difference: light hit ${fv(worst.light, 3)}, full hit ${worst.final ? fv(worst.final, 3) : 'none'} (camera ${fv(worst.cam, 1)}): the ray grazes an edge and the two meshes disagree about which surface it meets -> flagged`);
}
log();

// --- Quote lines ---------------------------------------------------------------------------------
log('== 6. Quote lines (exact decimal arithmetic) ==');
const vogelnet: QuoteMapping = { label: 'Vogelnet', unit: 'm²', extraPercent: 10, extraLabel: 'overlap', rounding: 'up', step: 1, min: 5, decimals: 1 };
const cases: [number, Partial<QuoteMapping>, number, string | null][] = [
  [48.6, {}, 54, 'Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²'],
  [50, {}, 55, null],
  [48.6, { step: 0.5 }, 53.5, null],
  [48.6, { step: 0.1 }, 53.5, null],
  [48.6, { rounding: 'nearest' }, 54, null],
  [48.6, { rounding: 'nearest', step: 0.5 }, 53.5, null],
  [48.6, { rounding: 'none' }, 53.5, null],
  [48.5, { rounding: 'none' }, 53.4, null],
  [3.2, {}, 5, null],
  [12, { extraPercent: 0 }, 12, null],
  [20.1, { extraPercent: 15, step: 0.5 }, 23.5, null],
  [63.6, { extraPercent: 7.5, step: 0.5 }, 68.5, null],
  [40, { extraPercent: 15 }, 46, null],
  [r.areaSlope, {}, 63, null],
];
for (const [measured, over, expected, expectedText] of cases) {
  const map = { ...vogelnet, ...over };
  const ql = quoteLine(measured, map);
  const naive = naiveQuantity(measured, map);
  const ok = Math.abs(ql.quantity - expected) < 1e-9 && (expectedText === null || ql.text === expectedText);
  const rule = `${map.rounding}${map.rounding === 'none' ? '' : ' ' + map.step}`;
  log(`  ${pad(String(measured === r.areaSlope ? f(measured, 4) : measured), 8)} +${pad(String(map.extraPercent) + '%', 5)} ${pad(rule, 10)} min ${map.min}: qty ${padL(String(ql.quantity), 5)} (expected ${expected}) ${check(ok)} | naive float: ${naive}${Math.abs(naive - expected) > 1e-9 ? '  <- wrong' : ''}`);
  log(`      "${ql.text}"`);
}
log(`  float facts: 48.6*1.1 = ${48.6 * 1.1}; 50*1.1 = ${50 * 1.1}; Math.ceil(50*1.1) = ${Math.ceil(50 * 1.1)}; 48.5*1.1 = ${48.5 * 1.1}; Math.round(48.5*1.1*10)/10 = ${Math.round(48.5 * 1.1 * 10) / 10}`);
log(`  shown +- rounding: ceilToStep(0.06000000000000001, 0.01) = ${ceilToStep(0.06000000000000001, 0.01)}; ceilToStep(0.0566, 0.01) = ${ceilToStep(0.0566, 0.01)}; ceilToStep(0.4596, 0.1) = ${ceilToStep(0.4596, 0.1)}`);
log(`  Dutch formatting: ${nl(12.4, 1)} m², ${nl(3.25, 2)} m, ${nl(35, 0)}°, ${nl(1234.5, 1)} m²`);
log();
log(`Checks failed: ${failures}. Run time ${((Date.now() - t0) / 1000).toFixed(1)} s.`);

console.log(out.join('\n'));

export {};
