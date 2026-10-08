import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* Procedural modern cars (hatchback / estate / SUV) for an archviz-style street scene.
   Body = lofted cross-sections with superelliptic end caps, greenhouse = parametric surface tiled into
   glass / pillar / roof regions, details (lamps, grilles, seams, plates) projected onto the body by ray casting.
   Geometry is cached per style + wheel design; only the paint and plate materials are per car. */

/* ------------------------------------------------------------------ helpers */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const se = (w, n) => Math.pow(Math.max(0, 1 - Math.pow(clamp(w, 0, 1), n)), 1 / n);

/* monotone cubic interpolation through [[x, y], ...], clamped outside the range */
function curve(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length, X = p.map((q) => q[0]), Y = p.map((q) => q[1]);
  if (n === 1) return () => Y[0];
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / (X[i + 1] - X[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= X[0]) return Y[0];
    if (x >= X[n - 1]) return Y[n - 1];
    let i = 0; while (x > X[i + 1]) i++;
    const h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * Y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * Y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/* simple indexed geometry builder */
class GB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  v(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, w = 0) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, w); return this.p.length / 3 - 1; }
  t(a, b, c) { this.i.push(a, b, c); }
  get count() { return this.p.length / 3; }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i);
    return g;
  }
}
/* keep only position/normal/uv, indexed, so everything merges */
function norm(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.index) { const a = []; for (let i = 0; i < g.attributes.position.count; i++) a.push(i); g.setIndex(a); }
  if (!g.attributes.normal) g.computeVertexNormals();
  g.groups = [];
  return g;
}
/* triangle winding check: make each triangle face along its vertex normals */
function orientTris(gb) {
  const P = gb.p, N = gb.n, I = gb.i;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const sx = N[a] + N[b] + N[c], sy = N[a + 1] + N[b + 1] + N[c + 1], sz = N[a + 2] + N[b + 2] + N[c + 2];
    if (nx * sx + ny * sy + nz * sz < 0) { const k = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = k; }
  }
}

/* ------------------------------------------------------------------ styles */
const SA = 0.44, SB = 0.62; // greenhouse section parameter: side band [0,SA], roof rail [SA,SB], top [SB,1]

function defineStyles() {
  const P = 'paint', G = 'glass', K = 'gloss', C = 'chrome';
  const hatch = {
    name: 'hatchback', halfL: 2.14, wheelR: 0.316, tyreW: 0.215, rimR: 0.205, track: 0.765, axleF: 1.25, axleR: -1.38, archR: 0.375,
    capF: 0.44, capR: 0.26,
    front: { lo: 0.34, hi: 0.71, nUp: 3.5, nLo: 2.4, nPlan: 2.0, hwEnd: 0.4, bulge: 0.08, lean: 1.0, yMax: 0.48 },
    rear: { lo: 0.42, hi: 0.93, nUp: 2.8, nLo: 2.6, nPlan: 2.2, hwEnd: 0.5, bulge: 0.06, lean: 0.45, yMax: 0.56 },
    top: [[1.7, 0.81], [1.55, 0.84], [1.2, 0.89], [0.95, 0.935], [0.78, 0.962], [0.5, 0.98], [-0.5, 0.995], [-1.3, 1.012], [-1.94, 1.03]],
    bot: [[-1.94, 0.42], [-1.76, 0.32], [-1.55, 0.27], [1.45, 0.27], [1.64, 0.29], [1.82, 0.33]],
    hw: [[-1.94, 0.86], [-1.65, 0.885], [-1.38, 0.893], [-0.9, 0.884], [0.3, 0.879], [1.25, 0.89], [1.6, 0.882], [1.82, 0.862]],
    shoulder: [[-1.94, 0.92], [-1.0, 0.9], [0.0, 0.875], [1.0, 0.835], [1.82, 0.75]],
    trim: [[-2.3, 0.47], [-1.96, 0.46], [-1.8, 0.3], [1.72, 0.3], [1.88, 0.36], [2.3, 0.36]],
    crown: 0.022, rb: 0.06, rt: 0.062, tumble: 0.22, tumble2: 0.8, lean: 0.05, tuck: 0.6, tuckY: 0.46,
    gh: {
      roof: [[0.95, 0.86], [0.85, 0.93], [0.65, 1.03], [0.35, 1.175], [0.1, 1.3], [-0.12, 1.377], [-0.35, 1.413], [-0.8, 1.427], [-1.2, 1.42], [-1.42, 1.403], [-1.56, 1.372], [-1.7, 1.29], [-1.84, 1.19], [-1.96, 1.085], [-2.02, 1.02], [-2.07, 0.93]],
      x0: [[0.95, 0.78], [0.5, 0.8], [-0.5, 0.81], [-1.5, 0.8], [-1.85, 0.78], [-1.97, 0.745], [-2.07, 0.6]],
      xc: [[0.95, 0.77], [0.77, 0.755], [0.35, 0.722], [-0.12, 0.68], [-0.5, 0.668], [-1.2, 0.662], [-1.6, 0.64], [-1.9, 0.615], [-1.97, 0.595], [-2.07, 0.5]],
      rc: 0.075, crown: 0.032, seal: 0.006, frame: 0.016,
      keys: [[0.95, 0.95], [0.77, 0.818], [0.44, -0.125], [-0.3, -0.17], [-0.42, -0.5], [[-1.38, -1.08], -1.42], [[-1.405, -1.105], -1.47], [-2.07, -2.07]],
      nU: [2, 6, 10, 2, 10, 1, 12],
      nV: [2, 6, 1, 4, 7],
      mats: [
        [K, K, K, K, K, K, P],
        [K, K, G, K, G, K, P],
        [K, K, K, K, K, K, P],
        [P, P, P, P, P, P, P],
        [K, G, K, P, P, P, G],
      ],
    },
    mirrorZ: 0.59,
    interior: { dash: [0.81, 0.43, 0.1], frontSeat: -0.45, rearSeat: -1.33, seatTop: 0.34, floorEnd: -1.96 },
    head: { x0: 0.33, x1: 0.85, yb0: 0.665, yb1: 0.655, yt0: 0.78, yt1: 0.775 },
    grille: { x: 0.335, y0: 0.675, y1: 0.77 },
    intake: { xb: 0.47, xt: 0.43, y0: 0.36, y1: 0.55 },
    vent: { x0: 0.55, x1: 0.76, y0: 0.37, y1: 0.52 },
    plateF: 0.44, plateR: 0.665, badgeF: 0.722, badgeR: 0.86,
    tail: { x0: 0.36, x1: 0.85, yb0: 0.81, yb1: 0.8, yt0: 0.975, yt1: 0.985 },
    refl: { x0: 0.6, x1: 0.8, y: 0.47 },
    seamsSide: [
      [[0.81, 0.29], [0.825, 0.5], [0.81, 0.75], [0.78, 0.92], [0.76, 0.97]],
      [[-0.37, 0.28], [-0.36, 0.6], [-0.345, 0.99]],
      [[-0.985, 0.28], [-0.975, 0.52], [-1.0, 0.68], [-1.09, 0.8], [-1.2, 0.9], [-1.29, 1.0]],
    ],
    seamsTop: [[[0.64, 1.85], [0.69, 1.5], [0.715, 1.1], [0.73, 0.86]]],
    seamsRear: [[[-0.47, 0.97], [-0.49, 0.62], [-0.44, 0.585], [0.44, 0.585], [0.49, 0.62], [0.47, 0.97]]],
    seamsFront: [[[-0.82, 0.792], [-0.4, 0.8], [0, 0.802], [0.4, 0.8], [0.82, 0.792]]],
    handles: [[-0.24, 0.875], [-0.86, 0.9]],
    spoiler: true,
  };

  const estate = JSON.parse(JSON.stringify(hatch));
  Object.assign(estate, {
    name: 'estate', halfL: 2.35, axleF: 1.44, axleR: -1.26, track: 0.775, archR: 0.375,
    capF: 0.44, capR: 0.24,
    front: { lo: 0.34, hi: 0.71, nUp: 3.5, nLo: 2.4, nPlan: 2.0, hwEnd: 0.4, bulge: 0.08, lean: 1.0, yMax: 0.48 },
    rear: { lo: 0.42, hi: 0.94, nUp: 3.2, nLo: 2.6, nPlan: 2.4, hwEnd: 0.56, bulge: 0.05, lean: 0.3, yMax: 0.56 },
    top: [[2.03, 0.81], [1.75, 0.845], [1.4, 0.89], [1.12, 0.935], [0.95, 0.962], [0.7, 0.98], [-0.5, 0.993], [-1.5, 1.006], [-2.15, 1.015]],
    bot: [[-2.15, 0.43], [-1.95, 0.32], [-1.72, 0.27], [1.64, 0.27], [1.84, 0.29], [2.03, 0.33]],
    hw: [[-2.15, 0.87], [-1.8, 0.895], [-1.26, 0.9], [-0.7, 0.892], [0.4, 0.887], [1.44, 0.898], [1.8, 0.89], [2.03, 0.866]],
    shoulder: [[-2.15, 0.93], [-1.0, 0.905], [0.2, 0.88], [1.2, 0.84], [2.03, 0.75]],
    trim: [[-2.5, 0.47], [-2.17, 0.46], [-2.0, 0.3], [1.92, 0.3], [2.08, 0.36], [2.5, 0.36]],
    gh: {
      roof: [[1.12, 0.86], [1.02, 0.93], [0.82, 1.03], [0.52, 1.175], [0.27, 1.3], [0.07, 1.37], [-0.18, 1.405], [-0.8, 1.42], [-1.4, 1.418], [-1.85, 1.41], [-2.0, 1.4], [-2.08, 1.375], [-2.13, 1.3], [-2.18, 1.15], [-2.21, 1.04], [-2.23, 0.96]],
      x0: [[1.12, 0.78], [0.6, 0.805], [-0.5, 0.815], [-1.6, 0.81], [-2.23, 0.78]],
      xc: [[1.12, 0.77], [0.94, 0.758], [0.52, 0.725], [0.07, 0.685], [-0.4, 0.672], [-1.5, 0.668], [-2.0, 0.655], [-2.23, 0.64]],
      rc: 0.075, crown: 0.03, seal: 0.006, frame: 0.016,
      keys: [[1.12, 1.12], [0.94, 0.985], [0.6, 0.065], [-0.1, 0.025], [-0.22, -0.4], [-1.04, -0.9], [-1.12, -1.4], [[-1.95, -1.78], -1.9], [[-1.975, -1.805], -1.98], [-2.23, -2.23]],
      nU: [2, 6, 10, 2, 11, 2, 11, 1, 8],
      nV: [2, 6, 1, 4, 7],
      mats: [
        [K, C, C, C, C, C, C, C, P],
        [K, K, G, K, G, K, G, K, P],
        [K, C, C, C, C, C, C, C, P],
        [P, P, P, P, P, P, P, P, P],
        [K, G, K, P, P, P, P, P, G],
      ],
    },
    mirrorZ: 0.75,
    interior: { dash: [0.98, 0.6, 0.1], frontSeat: -0.27, rearSeat: -1.15, seatTop: 0.34, floorEnd: -2.18 },
    tail: { x0: 0.5, x1: 0.885, yb0: 0.83, yb1: 0.85, yt0: 0.97, yt1: 0.985 },
    seamsSide: [
      [[0.98, 0.29], [0.995, 0.5], [0.98, 0.75], [0.95, 0.92], [0.92, 0.97]],
      [[-0.17, 0.28], [-0.16, 0.6], [-0.15, 0.99]],
      [[-0.84, 0.28], [-0.835, 0.52], [-0.86, 0.68], [-0.93, 0.8], [-1.02, 0.92], [-1.07, 0.995]],
    ],
    seamsTop: [[[0.64, 2.06], [0.69, 1.7], [0.715, 1.3], [0.73, 1.02]]],
    seamsRear: [[[-0.56, 0.98], [-0.58, 0.62], [-0.52, 0.58], [0.52, 0.58], [0.58, 0.62], [0.56, 0.98]]],
    handles: [[-0.03, 0.88], [-0.7, 0.9]],
    spoiler: false, rails: { z0: -0.15, z1: -1.95, color: C },
  });

  const suv = JSON.parse(JSON.stringify(hatch));
  Object.assign(suv, {
    name: 'suv', halfL: 2.2, wheelR: 0.345, tyreW: 0.225, rimR: 0.222, track: 0.79, axleF: 1.32, axleR: -1.34, archR: 0.405,
    capF: 0.42, capR: 0.24,
    front: { lo: 0.47, hi: 0.87, nUp: 3.4, nLo: 2.4, nPlan: 2.0, hwEnd: 0.44, bulge: 0.08, lean: 0.8, yMax: 0.62 },
    rear: { lo: 0.52, hi: 1.08, nUp: 3.0, nLo: 2.6, nPlan: 2.3, hwEnd: 0.56, bulge: 0.05, lean: 0.4, yMax: 0.68 },
    top: [[1.88, 0.97], [1.6, 1.01], [1.25, 1.05], [0.95, 1.085], [0.74, 1.105], [0.45, 1.115], [-0.5, 1.13], [-1.4, 1.145], [-2.0, 1.16]],
    bot: [[-2.0, 0.53], [-1.82, 0.42], [-1.62, 0.37], [1.55, 0.37], [1.72, 0.41], [1.88, 0.46]],
    hw: [[-2.0, 0.88], [-1.7, 0.91], [-1.34, 0.92], [-0.8, 0.905], [0.4, 0.9], [1.32, 0.917], [1.65, 0.905], [1.88, 0.88]],
    shoulder: [[-2.0, 1.05], [-1.0, 1.02], [0.0, 0.99], [1.0, 0.95], [1.88, 0.87]],
    trim: [[-2.5, 0.64], [-2.0, 0.62], [-1.84, 0.53], [1.76, 0.53], [1.9, 0.56], [2.5, 0.56]],
    crown: 0.02, rb: 0.07, rt: 0.065, tuckY: 0.6,
    gh: {
      roof: [[0.88, 0.99], [0.76, 1.07], [0.55, 1.18], [0.25, 1.34], [0.0, 1.46], [-0.18, 1.52], [-0.4, 1.548], [-0.9, 1.56], [-1.4, 1.552], [-1.68, 1.535], [-1.82, 1.5], [-1.95, 1.38], [-2.04, 1.25], [-2.1, 1.16], [-2.14, 1.08]],
      x0: [[0.88, 0.8], [0.5, 0.82], [-0.5, 0.83], [-1.6, 0.82], [-2.14, 0.77]],
      xc: [[0.88, 0.79], [0.72, 0.775], [0.3, 0.74], [-0.12, 0.7], [-0.5, 0.69], [-1.4, 0.685], [-1.8, 0.67], [-2.14, 0.63]],
      rc: 0.08, crown: 0.03, seal: 0.006, frame: 0.016,
      keys: [[0.88, 0.88], [0.72, 0.8], [0.4, -0.13], [-0.25, -0.17], [-0.37, -0.6], [[-1.32, -1.1], -1.64], [[-1.345, -1.125], -1.7], [-2.14, -2.14]],
      nU: [2, 6, 10, 2, 10, 1, 12],
      nV: [2, 6, 1, 4, 7],
      mats: [
        [K, K, K, K, K, K, K],
        [K, K, G, K, G, K, K],
        [K, K, K, K, K, K, K],
        [P, P, P, P, P, P, P],
        [K, G, K, P, P, P, G],
      ],
    },
    mirrorZ: 0.53,
    interior: { dash: [0.76, 0.38, 0.11], frontSeat: -0.42, rearSeat: -1.3, seatTop: 0.36, floorEnd: -2.08 },
    head: { x0: 0.36, x1: 0.84, yb0: 0.83, yb1: 0.82, yt0: 0.945, yt1: 0.94 },
    grille: { x: 0.365, y0: 0.76, y1: 0.935 },
    intake: { xb: 0.5, xt: 0.46, y0: 0.49, y1: 0.69 },
    vent: { x0: 0.58, x1: 0.78, y0: 0.5, y1: 0.65 },
    plateF: 0.58, plateR: 0.79, badgeF: 0.82, badgeR: 0.99,
    tail: { x0: 0.4, x1: 0.88, yb0: 0.94, yb1: 0.93, yt0: 1.1, yt1: 1.115 },
    refl: { x0: 0.62, x1: 0.82, y: 0.64 },
    seamsSide: [
      [[0.81, 0.4], [0.825, 0.6], [0.81, 0.85], [0.77, 1.05], [0.73, 1.11]],
      [[-0.31, 0.39], [-0.3, 0.7], [-0.29, 1.125]],
      [[-0.92, 0.39], [-0.91, 0.62], [-0.94, 0.8], [-1.03, 0.92], [-1.13, 1.03], [-1.2, 1.13]],
    ],
    seamsTop: [[[0.66, 1.9], [0.71, 1.55], [0.735, 1.15], [0.75, 0.82]]],
    seamsRear: [[[-0.5, 1.1], [-0.52, 0.76], [-0.46, 0.72], [0.46, 0.72], [0.52, 0.76], [0.5, 1.1]]],
    seamsFront: [[[-0.8, 0.955], [-0.4, 0.962], [0, 0.965], [0.4, 0.962], [0.8, 0.955]]],
    handles: [[-0.17, 1.0], [-0.83, 1.02]],
    spoiler: true, rails: { z0: -0.25, z1: -1.6, color: 'gloss' }, cladding: true,
  });
  for (const S of [hatch, estate, suv]) prepStyle(S);
  return { hatchback: hatch, estate, suv };
}

function prepStyle(S) {
  S.zFA = S.halfL - S.capF; S.zRA = -S.halfL + S.capR;
  S.fTop = curve(S.top); S.fBot = curve(S.bot); S.fHw = curve(S.hw); S.fSh = curve(S.shoulder); S.fTrim = curve(S.trim);
  const G = S.gh;
  G.fRoof = curve(G.roof); G.fX0 = curve(G.x0); G.fXc = curve(G.xc);
}

let STYLES = null;
const styles = () => STYLES || (STYLES = defineStyles());

/* ------------------------------------------------------------------ body loft */
function archY(S, z) {
  let y = -1;
  for (const a of [S.axleF, S.axleR]) {
    const dz = Math.abs(z - a);
    if (dz <= S.archR + 1e-6) y = Math.max(y, S.wheelR + 0.012 + Math.sqrt(Math.max(0, S.archR * S.archR - dz * dz)));
  }
  return y;
}

function bodyStations(S) {
  const st = [];
  const K = 14;
  for (let k = K; k >= 1; k--) st.push({ cap: -1, w: Math.pow(Math.sin(k / K * Math.PI / 2), 0.66) });
  const zs = [];
  const step = 0.08, n = Math.ceil((S.zFA - S.zRA) / step);
  for (let i = 0; i <= n; i++) {
    const z = lerp(S.zRA, S.zFA, i / n);
    if ([S.axleF, S.axleR].some((a) => Math.abs(z - a) < S.archR + 0.035) && i > 0 && i < n) continue;
    zs.push(z);
  }
  for (const a of [S.axleF, S.axleR]) {
    for (let k = 0; k <= 14; k++) zs.push(a + S.archR * Math.cos(k / 14 * Math.PI) * (k === 0 || k === 14 ? 0.9999 : 1));
    zs.push(a + S.archR + 0.006, a - S.archR - 0.006);
  }
  zs.sort((a, b) => a - b);
  for (let i = 0; i < zs.length; i++) if (i === 0 || zs[i] - zs[i - 1] > 0.003) st.push({ cap: 0, z: zs[i] });
  for (let k = 1; k <= K; k++) st.push({ cap: 1, w: Math.pow(Math.sin(k / K * Math.PI / 2), 0.66) });
  return st;
}

/* half cross-section from bottom centre to top centre, x >= 0 */
const H_ROWS = 24, PLASTIC_ROW = 7;
function bodyHalf(S, st) {
  let yB, yT, hw, ySh, yTr, crown, z, wt = 0, c = null, hw0 = 1;
  if (st.cap) {
    c = st.cap > 0 ? S.front : S.rear;
    const zA = st.cap > 0 ? S.zFA : S.zRA, len = st.cap > 0 ? S.capF : S.capR;
    z = zA + st.cap * len * st.w;
    const yB0 = S.fBot(zA), yT0 = S.fTop(zA); hw0 = S.fHw(zA);
    yT = c.hi + (yT0 - c.hi) * se(st.w, c.nUp);
    yB = c.lo - (c.lo - yB0) * se(st.w, c.nLo);
    hw = c.hwEnd + (hw0 - c.hwEnd) * se(st.w, c.nPlan);
    ySh = S.fSh(zA); yTr = S.fTrim(z); crown = S.crown * se(st.w, c.nUp);
    wt = st.w * st.w;
  } else {
    z = st.z; const ay = archY(S, z); yB = Math.max(S.fBot(z), ay); yT = S.fTop(z); if (ay > 0) wt = -1; hw = S.fHw(z); ySh = S.fSh(z); yTr = S.fTrim(z); crown = S.crown;
  }
  const xs = (y) => {
    if (y >= ySh) { const d = y - ySh; return hw - (S.tumble * d + S.tumble2 * d * d); }
    const d = ySh - y, tk = Math.max(0, S.tuckY - y); return hw - (S.lean * d + S.tuck * tk * tk);
  };
  const h = yT - yB, rb = Math.min(wt < 0 ? 0.02 : S.rb, h * 0.3), rt = Math.min(S.rt, h * 0.3);
  if (wt < 0) wt = 0;
  const yTs = yT - crown, xTop = xs(yTs), xb = xs(yB + rb);
  const topY = (x) => yT - crown * (x / xTop) * (x / xTop);
  const pts = [];
  pts.push([0, yB], [(xb - rb) * 0.5, yB], [xb - rb, yB]);
  const bz = (p0, p1, p2, t) => [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];
  for (const t of [1 / 3, 2 / 3]) pts.push(bz([xb - rb, yB], [xs(yB), yB], [xb, yB + rb], t));
  const y0s = yB + rb, y1s = yTs - rt;
  const yTrC = clamp(yTr, y0s, y1s);
  for (let k = 0; k <= 2; k++) { const y = lerp(y0s, yTrC, k / 2); pts.push([xs(y), y]); }
  const ySC = clamp(ySh, yTrC + 0.002, y1s - 0.002);
  for (let k = 1; k <= 5; k++) { const y = lerp(yTrC, ySC, k / 5); pts.push([xs(y), y]); }
  for (let k = 1; k <= 3; k++) { const y = lerp(ySC, y1s, k / 3); pts.push([xs(y), y]); }
  const p0 = [xs(y1s), y1s], p1 = [xTop, yTs], p2 = [xTop - rt, topY(xTop - rt)];
  for (const t of [0.25, 0.5, 0.75, 1]) pts.push(bz(p0, p1, p2, t));
  for (let k = 1; k <= 4; k++) { const x = p2[0] * (1 - k / 4); pts.push([x, topY(x)]); }
  // z with end-cap bulge / lean
  const out = pts.map(([x, y]) => {
    let zz = z;
    if (st.cap) zz = z - st.cap * wt * (c.bulge * (x / hw0) * (x / hw0) + c.lean * (y - c.yMax) * (y - c.yMax));
    return [x, y, zz];
  });
  return { pts: out, z, c, hw0, end: st.cap && st.w >= 1 };
}

function buildBody(S) {
  const gb = new GB(); const tmat = []; // per triangle: 0 paint, 1 plastic
  const st = bodyStations(S);
  const RING = H_ROWS * 2 - 2;
  const rings = [];
  for (const s of st) {
    const hb = bodyHalf(S, s);
    const idx = [];
    for (let j = 0; j < H_ROWS; j++) { const [x, y, z] = hb.pts[j]; idx.push(gb.v(x, y, z)); }
    for (let j = H_ROWS - 2; j >= 1; j--) { const [x, y, z] = hb.pts[j]; idx.push(gb.v(-x, y, z)); }
    rings.push({ idx, hb });
  }
  const rowOf = (j) => (j < H_ROWS ? j : RING - j);
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i].idx, B = rings[i + 1].idx;
    for (let j = 0; j < RING; j++) {
      const j1 = (j + 1) % RING;
      const a = A[j], b = B[j], c = A[j1], d = B[j1];
      gb.t(a, c, b); gb.t(c, d, b);
      const r = Math.min(rowOf(j), rowOf(j1));
      const m = r < PLASTIC_ROW ? 1 : 0; tmat.push(m, m);
    }
  }
  // flat-ish end faces, zipped row by row across the width
  for (const end of [0, rings.length - 1]) {
    const R = rings[end], hb = R.hb, c = hb.c, sgn = end === 0 ? -1 : 1;
    const M = 6; const rows = [];
    for (let j = 0; j < H_ROWS; j++) {
      const [x, y] = hb.pts[j];
      const row = [];
      for (let m = 0; m <= M; m++) {
        if (m === 0) { row.push(R.idx[j]); continue; }
        if (m === M) { row.push(j === 0 || j === H_ROWS - 1 ? R.idx[j] : R.idx[RING - j]); continue; }
        const xx = lerp(x, -x, m / M);
        const zz = hb.z - sgn * (c.bulge * (xx / hb.hw0) ** 2 + c.lean * (y - c.yMax) * (y - c.yMax));
        row.push(gb.v(xx, y, zz));
      }
      rows.push(row);
    }
    for (let j = 0; j < H_ROWS - 1; j++) for (let m = 0; m < M; m++) {
      const a = rows[j][m], b = rows[j][m + 1], cc = rows[j + 1][m], d = rows[j + 1][m + 1];
      if (sgn > 0) { gb.t(a, cc, b); gb.t(b, cc, d); } else { gb.t(a, b, cc); gb.t(b, d, cc); }
      const mm = j < PLASTIC_ROW ? 1 : 0; tmat.push(mm, mm);
    }
  }
  // normals
  const g = gb.geo(); g.computeVertexNormals();
  gb.n = Array.from(g.attributes.normal.array);
  return { gb, tmat };
}

/* split an indexed builder into compact geometries by per-triangle tag */
function splitByTag(gb, tags, wanted, offset = 0) {
  const out = new GB(); const map = new Map();
  for (let t = 0; t < gb.i.length / 3; t++) {
    if (tags[t] !== wanted) continue;
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const vi = gb.i[t * 3 + k];
      let ni = map.get(vi);
      if (ni === undefined) {
        const p = vi * 3;
        ni = out.v(gb.p[p] + gb.n[p] * offset, gb.p[p + 1] + gb.n[p + 1] * offset, gb.p[p + 2] + gb.n[p + 2] * offset, gb.n[p], gb.n[p + 1], gb.n[p + 2], gb.uv[vi * 2], gb.uv[vi * 2 + 1]);
        map.set(vi, ni);
      }
      tri.push(ni);
    }
    out.t(tri[0], tri[1], tri[2]);
  }
  return out;
}

/* ------------------------------------------------------------------ ray projection onto the body */
function makeProjector(gb, dir, U, V) {
  const P = gb.p, N = gb.n, I = gb.i, nt = I.length / 3;
  const box = new Float32Array(nt * 4);
  const pa = (k) => P[k * 3] * U.x + P[k * 3 + 1] * U.y + P[k * 3 + 2] * U.z;
  const pb = (k) => P[k * 3] * V.x + P[k * 3 + 1] * V.y + P[k * 3 + 2] * V.z;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const A = [pa(a), pa(b), pa(c)], B = [pb(a), pb(b), pb(c)];
    box[t * 4] = Math.min(...A) - 1e-5; box[t * 4 + 1] = Math.max(...A) + 1e-5; box[t * 4 + 2] = Math.min(...B) - 1e-5; box[t * 4 + 3] = Math.max(...B) + 1e-5;
  }
  const D = dir.clone().normalize();
  return (a, b) => {
    const ox = U.x * a + V.x * b - D.x * 6, oy = U.y * a + V.y * b - D.y * 6, oz = U.z * a + V.z * b - D.z * 6;
    let best = Infinity, hit = null;
    for (let t = 0; t < nt; t++) {
      if (a < box[t * 4] || a > box[t * 4 + 1] || b < box[t * 4 + 2] || b > box[t * 4 + 3]) continue;
      const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
      const e1x = P[i1] - P[i0], e1y = P[i1 + 1] - P[i0 + 1], e1z = P[i1 + 2] - P[i0 + 2];
      const e2x = P[i2] - P[i0], e2y = P[i2 + 1] - P[i0 + 1], e2z = P[i2 + 2] - P[i0 + 2];
      const px = D.y * e2z - D.z * e2y, py = D.z * e2x - D.x * e2z, pz = D.x * e2y - D.y * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - P[i0], ty = oy - P[i0 + 1], tz = oz - P[i0 + 2];
      const u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-6 || u > 1 + 1e-6) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (D.x * qx + D.y * qy + D.z * qz) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 0 && tt < best) {
        best = tt;
        const w0 = 1 - u - v;
        const nx = N[i0] * w0 + N[i1] * u + N[i2] * v, ny = N[i0 + 1] * w0 + N[i1 + 1] * u + N[i2 + 1] * v, nz = N[i0 + 2] * w0 + N[i1 + 2] * u + N[i2 + 2] * v;
        const l = Math.hypot(nx, ny, nz) || 1;
        hit = { p: new THREE.Vector3(ox + D.x * tt, oy + D.y * tt, oz + D.z * tt), n: new THREE.Vector3(nx / l, ny / l, nz / l) };
      }
    }
    return hit;
  };
}

/* projected grid decal: fn(u,v) -> [a,b] in projector plane, uv rect [u0,v0,u1,v1] */
function decal(out, proj, nu, nv, fn, offset, rect = [0, 0, 1, 1], flipU = false, accept = null) {
  const ids = [];
  for (let j = 0; j <= nv; j++) {
    const row = [];
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      const [a, b] = fn(u, v);
      const h = proj(a, b);
      if (!h || (accept && !accept(h))) { row.push(-1); continue; }
      const uu = flipU ? 1 - u : u;
      row.push(out.v(h.p.x + h.n.x * offset, h.p.y + h.n.y * offset, h.p.z + h.n.z * offset, h.n.x, h.n.y, h.n.z, lerp(rect[0], rect[2], uu), lerp(rect[1], rect[3], v)));
    }
    ids.push(row);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = ids[j][i], b = ids[j][i + 1], c = ids[j + 1][i], d = ids[j + 1][i + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    out.t(a, b, c); out.t(b, d, c);
  }
}

/* thin ribbon following a polyline projected onto the body */
function ribbon(out, proj, pts, width, offset, step = 0.03) {
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, b0] = pts[i], [a1, b1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, b1 - b0) / step));
    for (let k = 0; k < n; k++) dense.push([lerp(a0, a1, k / n), lerp(b0, b1, k / n)]);
  }
  dense.push(pts[pts.length - 1]);
  const hits = dense.map(([a, b]) => proj(a, b));
  let prev = null;
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k]; if (!h) { prev = null; continue; }
    const hp = hits[Math.max(0, k - 1)] || h, hn = hits[Math.min(hits.length - 1, k + 1)] || h;
    const t = hn.p.clone().sub(hp.p); if (t.lengthSq() < 1e-12) { prev = null; continue; }
    const s = t.cross(h.n).normalize().multiplyScalar(width / 2);
    const base = h.p.clone().addScaledVector(h.n, offset);
    const i0 = out.v(base.x + s.x, base.y + s.y, base.z + s.z, h.n.x, h.n.y, h.n.z);
    const i1 = out.v(base.x - s.x, base.y - s.y, base.z - s.z, h.n.x, h.n.y, h.n.z);
    if (prev) { out.t(prev[0], prev[1], i0); out.t(prev[1], i1, i0); }
    prev = [i0, i1];
  }
}

/* ------------------------------------------------------------------ greenhouse */
function ghSec(S, z) {
  const G = S.gh;
  const yR = G.fRoof(z), belt = S.fTop(z);
  let xc = G.fXc(z), x0 = G.fX0(z);
  if (z < S.zRA) { // keep the buried tail of the greenhouse inside the narrowing rear end of the body
    const c = S.rear, w = Math.min(1, (S.zRA - z) / S.capR + 0.22);
    const hwB = c.hwEnd + (S.fHw(S.zRA) - c.hwEnd) * se(w, c.nPlan);
    x0 = Math.min(x0, hwB - 0.1); xc = Math.min(xc, x0 - 0.07);
  }
  x0 = Math.max(x0, xc + 0.012);
  const y0 = Math.min(belt - 0.035, yR - G.rc - 0.03);
  const dx = x0 - xc, dy = y0 - yR, len = Math.hypot(dx, dy);
  const rc = Math.min(G.rc, len * 0.8);
  const p1 = [xc + dx / len * rc, yR + dy / len * rc];
  const x2 = xc - rc;
  const topY = (x) => yR + G.crown * (1 - (x / xc) * (x / xc));
  return { z, yR, xc, x0, y0, rc, p1, x2, topY, belt, ctl: [xc, yR] };
}
function ghPt(g, s) {
  if (s <= SA) { const t = s / SA; return [lerp(g.x0, g.p1[0], t), lerp(g.y0, g.p1[1], t)]; }
  if (s <= SB) {
    const t = (s - SA) / (SB - SA), p0 = g.p1, p1 = g.ctl, p2 = [g.x2, g.topY(g.x2)];
    return [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];
  }
  const t = (s - SB) / (1 - SB), x = g.x2 * (1 - t);
  return [x, g.topY(x)];
}
function ghP(S, z, s) { const [x, y] = ghPt(ghSec(S, z), s); return new THREE.Vector3(x, y, z); }
function ghN(S, z, s) {
  const h = 0.002;
  const dz = ghP(S, z + h, s).sub(ghP(S, z - h, s));
  const s0 = Math.max(0, s - h), s1 = Math.min(1, s + h);
  const ds = ghP(S, z, s1).sub(ghP(S, z, s0));
  const n = ds.cross(dz);
  if (n.lengthSq() < 1e-14) return new THREE.Vector3(0, 1, 0);
  return n.normalize();
}
function keyZ(G, k, s) {
  const [sd, tp] = G.keys[k];
  const sv = Array.isArray(sd) ? lerp(sd[0], sd[1], clamp(s / SA, 0, 1)) : sd;
  if (s <= SA) return sv;
  if (s >= SB) return tp;
  return lerp(sv, tp, sstep(SA, SB, s));
}
function rowS(S, b, g) {
  const G = S.gh;
  if (b === 0) return 0;
  if (b === 3) return SA;
  if (b === 4) return SB;
  if (b === 5) return 1;
  const yy = (y) => SA * clamp((y - g.y0) / Math.max(1e-4, g.p1[1] - g.y0), 0, 1);
  const r1 = Math.min(yy(g.belt + G.seal), SA * 0.97);
  if (b === 1) return r1;
  return Math.max(r1 + 1e-4, yy(g.p1[1] - G.frame));
}

function buildGreenhouse(S) {
  const G = S.gh;
  const cols = []; G.nU.forEach((n, k) => { for (let i = (k === 0 ? 0 : 1); i <= n; i++) cols.push([k, i / n]); });
  const rows = []; G.nV.forEach((n, b) => { for (let i = (b === 0 ? 0 : 1); i <= n; i++) rows.push([b, i / n]); });
  const grid = [];
  for (let ci = 0; ci < cols.length; ci++) {
    const [k, tu] = cols[ci];
    const col = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const [b, tv] = rows[ri];
      let z = lerp(keyZ(G, k, 0.5), keyZ(G, k + 1, 0.5), tu), s = 0.5;
      for (let it = 0; it < 4; it++) {
        const g = ghSec(S, z);
        s = lerp(rowS(S, b, g), rowS(S, b + 1, g), tv);
        z = lerp(keyZ(G, k, s), keyZ(G, k + 1, s), tu);
      }
      const p = ghP(S, z, s), n = ghN(S, z, s);
      col.push({ p, n });
    }
    grid.push(col);
  }
  const byMat = {};
  for (const side of [1, -1]) {
    const maps = {};
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const k = cols[ci + 1][0];
      for (let ri = 0; ri < rows.length - 1; ri++) {
        const b = rows[ri + 1][0];
        const m = G.mats[b][k];
        if (!m) continue;
        const gb = byMat[m] || (byMat[m] = new GB());
        const mp = maps[m] || (maps[m] = new Map());
        const off = m === 'glass' ? -0.004 : 0;
        const vid = (c, r) => {
          const key = c * 1000 + r;
          let id = mp.get(key);
          if (id === undefined) {
            const { p, n } = grid[c][r];
            id = gb.v(side * (p.x + n.x * off), p.y + n.y * off, p.z + n.z * off, side * n.x, n.y, n.z);
            mp.set(key, id);
          }
          return id;
        };
        const a = vid(ci, ri), bb = vid(ci + 1, ri), c = vid(ci, ri + 1), d = vid(ci + 1, ri + 1);
        gb.t(a, bb, c); gb.t(bb, d, c);
      }
    }
  }
  for (const m in byMat) orientTris(byMat[m]);
  return byMat;
}

/* ------------------------------------------------------------------ textures */
let ATLAS = null;
const AT = 1024;
const R_HEAD = [0, 0, 512, 192], R_TAIL = [512, 0, 512, 192], R_GRILLE = [0, 192, 1024, 128], R_INTAKE = [0, 320, 1024, 256],
  R_VENT = [0, 576, 256, 128], R_REFL = [256, 576, 256, 64], R_BADGE = [512, 576, 128, 128];
const uvRect = (r) => [r[0] / AT, 1 - (r[1] + r[3]) / AT, (r[0] + r[2]) / AT, 1 - r[1] / AT];

function roundPoly(g, pts, R) { // pts in px, rounded corners via quadratic curves
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  g.beginPath();
  const m0 = mid(pts[n - 1], pts[0]); g.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) { const p = pts[i], q = mid(p, pts[(i + 1) % n]); g.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
  g.closePath();
}

function getAtlas() {
  if (ATLAS) return ATLAS;
  const c = document.createElement('canvas'); c.width = c.height = AT;
  const g = c.getContext('2d');
  g.clearRect(0, 0, AT, AT);
  const e = document.createElement('canvas'); e.width = e.height = 256;
  const ge = e.getContext('2d'); ge.fillStyle = '#000'; ge.fillRect(0, 0, 256, 256);
  const R = (r, u, v) => [r[0] + u * r[2], r[1] + (1 - v) * r[3]];
  const rng = mulberry32(77);

  /* headlight: u inner->outer, v bottom->top */
  {
    const r = R_HEAD;
    const shape = [[0.0, 0.6], [0.015, 0.95], [0.97, 0.97], [1.0, 0.72], [0.96, 0.28], [0.6, 0.06], [0.1, 0.16]].map(([u, v]) => R(r, u, v));
    g.save(); roundPoly(g, shape); g.clip();
    let gr = g.createLinearGradient(0, r[1], 0, r[1] + r[3]);
    gr.addColorStop(0, '#5a616b'); gr.addColorStop(0.35, '#1c2026'); gr.addColorStop(0.7, '#0c0e12'); gr.addColorStop(1, '#2a2f36');
    g.fillStyle = gr; g.fillRect(r[0], r[1], r[2], r[3]);
    // reflector bowl band (soft chrome), LED projector modules, top chrome strip
    let gb2 = g.createLinearGradient(0, R(r, 0, 0.85)[1], 0, R(r, 0, 0.3)[1]);
    gb2.addColorStop(0, '#2c3138'); gb2.addColorStop(0.45, '#7b838e'); gb2.addColorStop(0.6, '#3a4048'); gb2.addColorStop(1, '#121418');
    g.fillStyle = gb2; { const p0 = R(r, 0.08, 0.84), p1 = R(r, 0.92, 0.32); g.fillRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]); }
    for (const [cu, cv, rr] of [[0.24, 0.57, 0.15], [0.42, 0.58, 0.13], [0.7, 0.6, 0.15]]) {
      const [x, y] = R(r, cu, cv); const ry = rr * r[3], rx = ry * 0.75;
      g.fillStyle = '#aeb5bf'; g.beginPath(); g.ellipse(x, y, rx * 1.18, ry * 1.18, 0, 0, Math.PI * 2); g.fill();
      const rg = g.createRadialGradient(x - rx * 0.2, y - ry * 0.25, ry * 0.1, x, y, ry);
      rg.addColorStop(0, '#3d4652'); rg.addColorStop(0.6, '#151a21'); rg.addColorStop(1, '#0a0c10');
      g.fillStyle = rg; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#1b1f25';
    for (let k = 0; k < 7; k++) { const p0 = R(r, 0.5 + k * 0.022, 0.5); g.fillRect(p0[0], p0[1], 7, 0.18 * r[3]); }
    g.strokeStyle = '#d4d9df'; g.lineWidth = 4;
    g.beginPath(); let p = R(r, 0.05, 0.87); g.moveTo(p[0], p[1]); p = R(r, 0.95, 0.89); g.lineTo(p[0], p[1]); g.stroke();
    // DRL strip along the bottom and up the outside
    const drl = [[0.12, 0.25], [0.58, 0.15], [0.9, 0.32], [0.93, 0.62]];
    for (const [ctx, sc, col, lw] of [[g, 1, 'rgba(255,255,255,1)', 9], [ge, 0.25, '#ffffff', 2.6]]) {
      ctx.save(); ctx.scale(sc, sc); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); drl.forEach(([u, v], i) => { const q = R(r, u, v); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke(); ctx.restore();
    }
    g.restore();
    g.strokeStyle = '#15181c'; g.lineWidth = 6; roundPoly(g, shape); g.stroke();
  }
  /* tail light: u inner->outer, v bottom->top */
  {
    const r = R_TAIL;
    const shape = [[0.0, 0.3], [0.0, 0.92], [0.97, 0.98], [1.0, 0.6], [0.94, 0.05], [0.35, 0.18]].map(([u, v]) => R(r, u, v));
    g.save(); roundPoly(g, shape); g.clip();
    let gr = g.createLinearGradient(0, r[1], 0, r[1] + r[3]);
    gr.addColorStop(0, '#5a0d12'); gr.addColorStop(0.5, '#3a0509'); gr.addColorStop(1, '#22030500');
    g.fillStyle = '#2a0406'; g.fillRect(r[0], r[1], r[2], r[3]);
    g.fillStyle = gr; g.fillRect(r[0], r[1], r[2], r[3]);
    // red lens bands
    g.strokeStyle = '#d0202a'; g.lineWidth = 11; g.lineCap = 'round';
    for (const [v0, v1] of [[0.66, 0.7], [0.42, 0.5]]) { g.beginPath(); let p = R(r, 0.12, v0); g.moveTo(p[0], p[1]); p = R(r, 0.92, v1); g.lineTo(p[0], p[1]); g.stroke(); }
    g.strokeStyle = '#ff5a5a'; g.lineWidth = 3;
    for (const [v0, v1] of [[0.66, 0.7], [0.42, 0.5]]) { g.beginPath(); let p = R(r, 0.14, v0); g.moveTo(p[0], p[1]); p = R(r, 0.9, v1); g.lineTo(p[0], p[1]); g.stroke(); }
    // reverse light (clear)
    g.fillStyle = '#c9ccd0'; { const p = R(r, 0.08, 0.36); g.fillRect(p[0], p[1], 0.22 * r[2], 0.12 * r[3]); }
    // smoked top band
    gr = g.createLinearGradient(0, r[1], 0, r[1] + r[3] * 0.35); gr.addColorStop(0, 'rgba(10,0,0,0.85)'); gr.addColorStop(1, 'rgba(10,0,0,0)');
    g.fillStyle = gr; g.fillRect(r[0], r[1], r[2], r[3] * 0.35);
    g.restore();
    g.strokeStyle = '#140506'; g.lineWidth = 6; roundPoly(g, shape); g.stroke();
  }
  /* upper grille: gloss black slats with a chrome bottom strip */
  {
    const r = R_GRILLE;
    const shape = [[0, 0.02], [0, 0.98], [1, 0.98], [1, 0.02]].map(([u, v]) => R(r, u, v));
    g.save(); roundPoly(g, shape); g.clip();
    g.fillStyle = '#0b0c0e'; g.fillRect(r[0], r[1], r[2], r[3]);
    g.fillStyle = '#23262b';
    for (let k = 0; k < 4; k++) { const p = R(r, 0, 0.82 - k * 0.2); g.fillRect(r[0], p[1], r[2], 6); }
    g.fillStyle = '#d7dbe0'; { const p = R(r, 0, 0.14); g.fillRect(r[0], p[1], r[2], 7); }
    g.restore();
  }
  /* lower intake: honeycomb */
  {
    const r = R_INTAKE;
    const shape = [[0.0, 0.0], [0.06, 1.0], [0.94, 1.0], [1.0, 0.0]].map(([u, v]) => R(r, u, v));
    g.save(); roundPoly(g, shape); g.clip();
    g.fillStyle = '#060607'; g.fillRect(r[0], r[1], r[2], r[3]);
    g.strokeStyle = '#2b2d31'; g.lineWidth = 3;
    const s = 15;
    for (let y = r[1] - s; y < r[1] + r[3] + s; y += s * 0.87) {
      const row = Math.round((y - r[1]) / (s * 0.87));
      for (let x = r[0] - s + (row % 2) * s * 0.5; x < r[0] + r[2] + s; x += s) {
        g.beginPath();
        for (let k = 0; k < 6; k++) { const an = Math.PI / 6 + k * Math.PI / 3; const px = x + Math.cos(an) * s * 0.5, py = y + Math.sin(an) * s * 0.5; if (k) g.lineTo(px, py); else g.moveTo(px, py); }
        g.closePath(); g.stroke();
      }
    }
    const gr = g.createLinearGradient(0, r[1], 0, r[1] + r[3]); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(r[0], r[1], r[2], r[3]);
    g.restore();
    g.strokeStyle = '#1a1b1e'; g.lineWidth = 10; roundPoly(g, shape); g.stroke();
  }
  /* corner vents */
  {
    const r = R_VENT;
    const shape = [[0.0, 0.15], [0.05, 0.95], [0.95, 0.85], [1.0, 0.1]].map(([u, v]) => R(r, u, v));
    g.save(); roundPoly(g, shape); g.clip();
    g.fillStyle = '#08090a'; g.fillRect(r[0], r[1], r[2], r[3]);
    g.fillStyle = '#26282c'; for (let k = 0; k < 5; k++) g.fillRect(r[0], r[1] + 18 + k * 22, r[2], 4);
    g.restore();
    g.strokeStyle = '#1a1b1e'; g.lineWidth = 8; roundPoly(g, shape); g.stroke();
  }
  /* reflector */
  {
    const r = R_REFL;
    const shape = [[0, 0.1], [0, 0.9], [1, 0.9], [1, 0.1]].map(([u, v]) => R(r, u, v));
    g.fillStyle = '#7a0a10'; roundPoly(g, shape); g.fill();
    g.fillStyle = '#b3141c'; g.fillRect(r[0] + 10, r[1] + 18, r[2] - 20, r[3] - 36);
  }
  /* badge: generic rounded emblem (no real brand) */
  {
    const r = R_BADGE, cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
    const rg = g.createLinearGradient(0, r[1], 0, r[1] + r[3]); rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.5, '#8d949d'); rg.addColorStop(1, '#e3e6ea');
    g.fillStyle = rg; roundPoly(g, [[cx - 58, cy - 30], [cx + 58, cy - 30], [cx + 58, cy + 30], [cx - 58, cy + 30]]); g.fill();
    g.fillStyle = '#1d2229'; roundPoly(g, [[cx - 48, cy - 21], [cx + 48, cy - 21], [cx + 48, cy + 21], [cx - 48, cy + 21]]); g.fill();
    g.fillStyle = rg; g.fillRect(cx - 30, cy - 4, 60, 8);
  }
  rng();
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const emis = new THREE.CanvasTexture(e); emis.colorSpace = THREE.SRGBColorSpace;
  ATLAS = { map, emis };
  return ATLAS;
}

const PLATES = new Map();
function plateMaterial(text) {
  if (PLATES.has(text)) return PLATES.get(text);
  const W = 512, H = 112;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  g.fillStyle = '#16181b'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#f2c300'; rr(3, 3, W - 6, H - 6, 9); g.fill();
  g.strokeStyle = '#111'; g.lineWidth = 3; rr(9, 9, W - 18, H - 18, 6); g.stroke();
  g.fillStyle = '#0d3a96'; rr(11, 11, 48, H - 22, 4); g.fill();
  g.fillStyle = '#f2c300';
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.beginPath(); g.arc(35 + Math.cos(a) * 14, 40 + Math.sin(a) * 14, 2.4, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#ffffff'; g.font = 'bold 25px Arial, Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('NL', 35, 82);
  g.fillStyle = '#141414'; g.font = 'bold 86px "DIN Condensed", "Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif';
  const avail = W - 59 - 30, tw = g.measureText(text).width, sx = Math.min(1, avail / tw);
  g.save(); g.translate(59 + (W - 59) / 2, H / 2 + 4); g.scale(sx, 1.0); g.fillText(text, 0, 0); g.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.42, metalness: 0.0 });
  PLATES.set(text, m);
  return m;
}

/* ------------------------------------------------------------------ materials */
/* Reflections: the page's environment is a sky dome only, so mirror-like car surfaces would reflect sky
   everywhere. Darken reflected directions below the horizon (ground) and add a soft distant treeline band,
   which gives paint, glass and chrome the horizon line that makes a car read as a car. */
const ENV_FN = `
vec3 carEnvShade( vec3 d, float rough ) {
  float az = atan( d.z, d.x );
  float h = 0.05 + 0.028 * sin( az * 5.0 + 0.7 ) + 0.016 * sin( az * 13.0 + 2.1 ) + 0.009 * sin( az * 31.0 + 0.3 );
  float soft = 0.012 + rough * 0.3;
  float tree = 1.0 - smoothstep( h - soft, h + soft, d.y );
  float ground = 1.0 - smoothstep( -0.035 - soft, 0.005 + soft, d.y );
  vec3 c = mix( vec3( 1.0 ), vec3( 0.42, 0.46, 0.42 ), tree * 0.9 );
  return mix( c, vec3( 0.22, 0.225, 0.2 ), ground );
}
`;
function envPatch(m) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <envmap_physical_pars_fragment>', ENV_FN + THREE.ShaderChunk.envmap_physical_pars_fragment.replace('return envMapColor.rgb * envMapIntensity;', 'return envMapColor.rgb * envMapIntensity * carEnvShade( reflectVec, roughness );'));
  };
  m.customProgramCacheKey = () => 'car-env-v1';
  return m;
}
let M = null;
function mats() {
  if (M) return M;
  const A = getAtlas();
  M = {
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0e12, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.9, side: THREE.DoubleSide, ior: 1.52, envMapIntensity: 2.0 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.74, metalness: 0 }),
    gloss: new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.9, metalness: 0 }),
    rim0: new THREE.MeshStandardMaterial({ color: 0xa9aeb5, roughness: 0.3, metalness: 1 }),
    rim1: new THREE.MeshStandardMaterial({ color: 0x3d4045, roughness: 0.3, metalness: 0.85 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x2e3034, roughness: 0.55, metalness: 0.8, side: THREE.DoubleSide }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.1, metalness: 1 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.95, metalness: 0 }),
    lamps: new THREE.MeshPhysicalMaterial({ map: A.map, emissiveMap: A.emis, emissive: 0xffffff, emissiveIntensity: 2.0, roughness: 0.2, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, alphaTest: 0.5, alphaToCoverage: true }),
  };
  M.glass.forceSinglePass = true;
  for (const k of ['glass', 'gloss', 'rim0', 'rim1', 'chrome', 'lamps', 'plastic']) envPatch(M[k]);
  return M;
}
const PAINTS = new Map();
function paintMaterial(color) {
  const key = String(color);
  if (PAINTS.has(key)) return PAINTS.get(key);
  const c = new THREE.Color(color); const hsl = {}; c.getHSL(hsl);
  const solid = hsl.l > 0.8;
  const m = envPatch(new THREE.MeshPhysicalMaterial({ color: c, metalness: solid ? 0.0 : 0.55, roughness: solid ? 0.3 : 0.38, clearcoat: 1, clearcoatRoughness: 0.07 }));
  PAINTS.set(key, m);
  return m;
}

/* ------------------------------------------------------------------ wheels */
function chaikin(pts, it) {
  let p = pts;
  for (let k = 0; k < it; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    p = q;
  }
  return p;
}

function buildWheel(S, design) {
  const out = { tyre: [], rim: [], metal: [], chrome: [] };
  const R = S.wheelR, W = S.tyreW, rimR = S.rimR, half = W / 2;
  // tyre (lathe around Y, then axis -> X)
  const prof = [[rimR + 0.004, half * 0.82], [rimR + 0.03, half * 0.93], [lerp(rimR, R, 0.55), half], [R - 0.022, half * 0.95], [R - 0.006, half * 0.8], [R, half * 0.45], [R, -half * 0.45], [R - 0.006, -half * 0.8], [R - 0.022, -half * 0.95], [lerp(rimR, R, 0.55), -half], [rimR + 0.03, -half * 0.93], [rimR + 0.004, -half * 0.82]];
  const tyre = new THREE.LatheGeometry(prof.map(([r, a]) => new THREE.Vector2(r, a)), 40);
  tyre.rotateZ(-Math.PI / 2);
  out.tyre.push(norm(tyre));
  // rim face: shape with spoke windows, dished
  const Rf = rimR - 0.004, r1 = 0.062, r2 = Rf - 0.022, dish = 0.03, faceX = half - 0.022;
  const outer = []; const NO = 48;
  for (let i = 0; i < NO; i++) { const a = i / NO * Math.PI * 2; outer.push([Math.cos(a) * Rf, Math.sin(a) * Rf]); }
  const holes = [];
  const spokes = design === 1 ? 10 : 5;
  const addWindow = (a0, a1, w1, w2) => {
    const pts = [];
    const ang = (r, a, w, s) => a + s * w / r;
    for (let k = 0; k <= 2; k++) { const r = lerp(r1, r2, k / 2), w = lerp(w1, w2, k / 2); const a = ang(r, a0, w, 1); pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
    const aa0 = ang(r2, a0, w2, 1), aa1 = ang(r2, a1, w2, -1);
    for (let k = 1; k < 5; k++) { const a = lerp(aa0, aa1, k / 5); pts.push([Math.cos(a) * r2, Math.sin(a) * r2]); }
    for (let k = 2; k >= 0; k--) { const r = lerp(r1, r2, k / 2), w = lerp(w1, w2, k / 2); const a = ang(r, a1, w, -1); pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
    const b0 = ang(r1, a1, w1, -1), b1 = ang(r1, a0, w1, 1);
    for (let k = 1; k < 2; k++) { const a = lerp(b0, b1, k / 2); pts.push([Math.cos(a) * r1, Math.sin(a) * r1]); }
    holes.push(chaikin(pts, 1));
  };
  const step = Math.PI * 2 / spokes;
  for (let i = 0; i < spokes; i++) {
    const a0 = i * step + Math.PI / 2, a1 = a0 + step;
    if (design === 0) { // twin spokes: narrow slot between the pair, wide window between pairs
      const mid = a0 + step * 0.22;
      addWindow(a0, mid, 0.011, 0.012);
      addWindow(mid, a1, 0.011, 0.012);
    } else if (design === 1) addWindow(a0, a1, 0.011, 0.012);
    else addWindow(a0, a1, 0.017, 0.024);
  }
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const face = new THREE.ShapeGeometry(shape, 1);
  const dz = (x, y) => { const r = Math.hypot(x, y) / Rf; return -dish * (1 - Math.pow(r, 1.6)); };
  {
    const p = face.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, dz(p.getX(i), p.getY(i)));
    face.computeVertexNormals();
  }
  const walls = new GB();
  const depth = 0.028;
  for (const h of holes) {
    const n = h.length; let cx = 0, cy = 0; for (const [x, y] of h) { cx += x; cy += y; } cx /= n; cy /= n;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = h[i], [xp, yp] = h[(i - 1 + n) % n], [xn, yn] = h[(i + 1) % n];
      let nx = -(yn - yp), ny = xn - xp; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      if (nx * (cx - x) + ny * (cy - y) < 0) { nx = -nx; ny = -ny; }
      const z0 = dz(x, y);
      ids.push([walls.v(x, y, z0, nx, ny, 0), walls.v(x, y, z0 - depth, nx, ny, 0)]);
    }
    for (let i = 0; i < n; i++) { const a = ids[i], b = ids[(i + 1) % n]; walls.t(a[0], b[0], a[1]); walls.t(b[0], b[1], a[1]); }
  }
  orientTris(walls);
  const toWheel = (g) => { g.rotateY(Math.PI / 2); g.translate(faceX, 0, 0); return g; };
  out.rim.push(norm(toWheel(face)), norm(toWheel(walls.geo())));
  // rim lip
  const lip = new THREE.LatheGeometry([[Rf - 0.004, 0.002], [Rf + 0.004, 0.006], [rimR + 0.01, 0.0], [rimR + 0.012, -0.012], [rimR + 0.006, -0.03]].map(([r, a]) => new THREE.Vector2(r, a)), 40);
  lip.rotateZ(-Math.PI / 2); lip.translate(faceX, 0, 0);
  out.rim.push(norm(lip));
  // hub cap
  const cap = new THREE.CylinderGeometry(0.05, 0.056, 0.012, 20, 1, false);
  cap.rotateZ(-Math.PI / 2); cap.translate(faceX + dz(0, 0) + 0.004, 0, 0);
  out.chrome.push(norm(cap));
  // barrel + disc + caliper
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W * 0.9, 32, 1, true);
  barrel.rotateZ(-Math.PI / 2); barrel.translate(-0.01, 0, 0);
  out.metal.push(norm(barrel));
  const hubD = new THREE.CylinderGeometry(0.075, 0.075, 0.03, 18, 1, false); hubD.rotateZ(-Math.PI / 2); hubD.translate(faceX - dish - 0.02, 0, 0);
  out.metal.push(norm(hubD));
  const disc = new THREE.CylinderGeometry(rimR - 0.045, rimR - 0.045, 0.024, 32, 1, false);
  disc.rotateZ(-Math.PI / 2); disc.translate(faceX - dish - 0.045, 0, 0);
  out.metal.push(norm(disc));
  const cal = new THREE.BoxGeometry(0.045, 0.1, 0.06); cal.translate(faceX - dish - 0.05, rimR - 0.05, -0.04); cal.rotateX(-0.5);
  out.metal.push(norm(cal));
  return out;
}

/* superellipsoid 'soft box' (exponent < 1 = boxier) */
function roundedBox(w, h, d, e = 0.45, ws = 10, hs = 8) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const p = g.attributes.position;
  const f = (v) => Math.sign(v) * Math.pow(Math.abs(v), e);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i)) * w / 2, f(p.getY(i)) * h / 2, f(p.getZ(i)) * d / 2);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ assembly per style */
const CACHE = new Map();

function buildStyle(S, design) {
  const key = S.name + ':' + design;
  if (CACHE.has(key)) return CACHE.get(key);
  const B = { paint: [], plastic: [], gloss: [], glass: [], chrome: [], lamps: [], interior: [], tyre: [], rim: [], metal: [], plate: [] };
  // body
  const { gb, tmat } = buildBody(S);
  B.paint.push(splitByTag(gb, tmat, 0).geo());
  B.plastic.push(splitByTag(gb, tmat, 1).geo());
  // greenhouse
  const gh = buildGreenhouse(S);
  for (const m in gh) B[m].push(gh[m].geo());
  // projectors
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const pF = makeProjector(gb, new THREE.Vector3(0, 0, -1), X, Y);
  const pR = makeProjector(gb, new THREE.Vector3(0, 0, 1), X, Y);
  const pS = [makeProjector(gb, new THREE.Vector3(-1, 0, 0), Z, Y), makeProjector(gb, new THREE.Vector3(1, 0, 0), Z, Y)];
  const pT = makeProjector(gb, new THREE.Vector3(0, -1, 0), X, Z);
  const lamps = new GB(), gloss = new GB(), plastic = new GB(), chrome = new GB(), paint = new GB();
  // front
  const okF = (h) => h.p.z > S.zFA - 0.4, okR = (h) => h.p.z < S.zRA + 0.4;
  const faceF = (h) => h.n.z > 0.25, faceR = (h) => h.n.z < -0.25;
  const hd = S.head;
  for (const sg of [1, -1]) {
    // head / tail lights are projected diagonally from their corner so the wrap-around part is not smeared
    const diag = (front, k) => {
      const d = new THREE.Vector3(-sg * k, 0, front ? -1 : 1).normalize();
      const U = new THREE.Vector3(-d.z, 0, d.x); if (U.x * sg < 0) U.negate();
      return { proj: makeProjector(gb, d, U, Y), at: (x, y, z) => [U.x * x + U.z * z, y] };
    };
    const dh = diag(true, 0.45);
    decal(lamps, dh.proj, 12, 6, (u, v) => dh.at(sg * lerp(hd.x0, hd.x1, u), lerp(lerp(hd.yb0, hd.yb1, u), lerp(hd.yt0, hd.yt1, u), v), S.halfL - 0.03 - 0.25 * u * u), 0.003, uvRect(R_HEAD), false, okF);
    const vt = S.vent;
    decal(lamps, pF, 6, 4, (u, v) => [sg * lerp(vt.x0, vt.x1, u), lerp(vt.y0, vt.y1, v)], 0.002, uvRect(R_VENT), sg < 0, faceF);
    const tl = S.tail;
    const dt = diag(false, 0.55);
    decal(lamps, dt.proj, 12, 6, (u, v) => dt.at(sg * lerp(tl.x0, tl.x1, u), lerp(lerp(tl.yb0, tl.yb1, u), lerp(tl.yt0, tl.yt1, u), v), -S.halfL + 0.03 + 0.2 * u * u), 0.003, uvRect(R_TAIL), false, okR);
    const rf = S.refl;
    decal(lamps, pR, 3, 1, (u, v) => [sg * lerp(rf.x0, rf.x1, u), lerp(rf.y - 0.018, rf.y + 0.018, v)], 0.002, uvRect(R_REFL), false, faceR);
  }
  const gr = S.grille;
  decal(lamps, pF, 12, 3, (u, v) => [lerp(-gr.x, gr.x, u), lerp(gr.y0, gr.y1, v)], 0.0025, uvRect(R_GRILLE));
  const it = S.intake;
  decal(lamps, pF, 12, 4, (u, v) => [lerp(-lerp(it.xb, it.xt, v), lerp(it.xb, it.xt, v), u), lerp(it.y0, it.y1, v)], 0.002, uvRect(R_INTAKE), false, faceF);
  for (const [proj, y, sz] of [[pF, S.badgeF, 0.06], [pR, S.badgeR, 0.065]]) decal(lamps, proj, 2, 2, (u, v) => [lerp(-sz, sz, u) * (proj === pR ? -1 : 1), lerp(y - sz * 0.6, y + sz * 0.6, v)], 0.006, uvRect(R_BADGE));
  // seams
  const SW = 0.005;
  for (const sg of [0, 1]) {
    for (const s of S.seamsSide) ribbon(gloss, pS[sg], s, SW, 0.0015);
    for (const s of S.seamsTop) ribbon(gloss, pT, s.map(([x, z]) => [sg ? -x : x, z]), SW, 0.0015);
    // door handle recess + handle
    for (const [hz, hy] of S.handles) {
      decal(gloss, pS[sg], 4, 1, (u, v) => [lerp(hz - 0.1, hz + 0.1, u), lerp(hy - 0.026, hy + 0.026, v)], 0.0015);
      const h = pS[sg](hz, hy);
      if (h) {
        const cap = new THREE.CapsuleGeometry(0.016, 0.15, 3, 8); cap.rotateX(Math.PI / 2); cap.scale(0.7, 1, 1);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(h.n.x, 0, h.n.z).normalize());
        cap.applyQuaternion(q); cap.translate(h.p.x + h.n.x * 0.008, h.p.y + h.n.y * 0.008, h.p.z + h.n.z * 0.008);
        B.paint.push(norm(cap));
      }
    }
  }
  for (const s of S.seamsRear) ribbon(gloss, pR, s, SW, 0.0015);
  decal(S.name === 'estate' ? chrome : gloss, pR, 10, 1, (u, v) => [lerp(-0.42, 0.42, u), lerp(S.plateR + 0.075, S.plateR + 0.098, v)], 0.003);
  for (const s of S.seamsFront || []) ribbon(gloss, pF, s, SW, 0.0015);
  // SUV wheel-arch cladding
  if (S.cladding) {
    for (const sg of [0, 1]) for (const a of [S.axleF, S.axleR]) {
      const R0 = S.archR - 0.004, R1 = S.archR + 0.085, cy = S.wheelR + 0.012;
      const lo = Math.asin(clamp((S.fTrim(a) - 0.01 - cy) / R1, -1, 1));
      decal(plastic, pS[sg], 28, 2, (u, v) => { const an = lerp(lo, Math.PI - lo, u); const r = lerp(R0, R1, v); return [a + Math.cos(an) * r, cy + Math.sin(an) * r]; }, 0.006);
    }
  }
  for (const d of [lamps, gloss, plastic, chrome]) orientTris(d);
  B.lamps.push(lamps.geo()); B.gloss.push(gloss.geo()); B.plastic.push(plastic.geo()); B.chrome.push(chrome.geo());
  // plates (front, rear) with black holders
  const plates = new GB();
  for (const [proj, y, sgn] of [[pF, S.plateF, 1], [pR, S.plateR, -1]]) {
    const h = proj(0, y); if (!h) continue;
    const n = h.n.clone(); n.x = 0; n.normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    const c = h.p.clone().addScaledVector(n, 0.014);
    const quad = (gbq, w, hh, off, uv) => {
      const cc = c.clone().addScaledVector(n, off);
      const ids = [];
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const p = cc.clone().addScaledVector(right, sx * w / 2).addScaledVector(up, sy * hh / 2);
        ids.push(gbq.v(p.x, p.y, p.z, n.x, n.y, n.z, uv ? (sx + 1) / 2 : 0, uv ? (sy + 1) / 2 : 0));
      }
      gbq.t(ids[0], ids[1], ids[2]); gbq.t(ids[1], ids[3], ids[2]);
    };
    quad(plates, 0.52, 0.11, 0, true);
    quad(plastic, 0.54, 0.13, -0.006, false);
    sgn;
  }
  orientTris(plates); orientTris(plastic);
  B.plate.push(plates.geo());
  B.plastic[B.plastic.length - 1] = plastic.geo();
  // mirrors
  buildMirrors(S, B);
  // spoiler / rails / antenna
  buildRoofParts(S, B);
  // wipers + interior + underbody
  buildInterior(S, B);
  // wheels
  const wh = buildWheel(S, design);
  for (const [sx, az] of [[1, S.axleF], [-1, S.axleF], [1, S.axleR], [-1, S.axleR]]) {
    const mtx = new THREE.Matrix4();
    if (sx < 0) mtx.makeRotationY(Math.PI);
    mtx.premultiply(new THREE.Matrix4().makeTranslation(sx * S.track, S.wheelR - 0.002, az));
    for (const k of ['tyre', 'rim', 'metal', 'chrome']) for (const g of wh[k]) B[k].push(g.clone().applyMatrix4(mtx));
  }
  // merge
  const geos = {};
  for (const k in B) {
    const list = B[k].map(norm).filter((g) => g.index && g.index.count > 0);
    if (list.length) geos[k] = mergeGeometries(list, false);
  }
  geos.shadow = contactShadowGeo(S);
  CACHE.set(key, geos);
  return geos;
}

function buildMirrors(S, B) {
  const G = S.gh;
  for (const sg of [1, -1]) {
    const z = S.mirrorZ, belt = S.fTop(z), x0 = G.fX0(z);
    const hw = S.fHw(z) - 0.02;
    const cx = hw + 0.07, cy = belt + 0.06;
    // housing: soft wedge, rounded aero front, flat back carrying the glass
    const h = new THREE.SphereGeometry(1, 16, 10);
    const p = h.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const f = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
      let x = p.getX(i), y = p.getY(i), zz = p.getZ(i);
      const X = f(x, 0.5), Y = f(y, 0.55), Z = zz > 0 ? f(zz, 0.9) : f(zz, 0.35);
      const t = (X + 1) / 2; // 0 inner .. 1 outer
      const sy = 0.064 * (0.82 + 0.18 * t), sz = (zz > 0 ? 0.07 : 0.022) * (0.8 + 0.2 * t);
      p.setXYZ(i, sg * (cx + X * 0.11), cy + Y * sy + 0.012 * t, z + Z * sz - 0.01 * t);
    }
    h.computeVertexNormals();
    if (sg < 0) { const ix = h.index.array; for (let k = 0; k < ix.length; k += 3) { const tmp = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = tmp; } h.computeVertexNormals(); }
    B.paint.push(norm(h));
    // glass (dark mirror) on the back face
    const gl = roundedBox(0.2, 0.105, 0.01, 0.3, 10, 6); gl.translate(sg * (cx + 0.005), cy + 0.006, z - 0.026);
    B.gloss.push(norm(gl));
    // arm and sail base
    const arm = roundedBox(0.12, 0.035, 0.065, 0.5, 8, 6); arm.translate(sg * (hw - 0.0), belt + 0.045, z - 0.005);
    B.gloss.push(norm(arm));
    const base = roundedBox(Math.max(0.06, hw - x0 + 0.04), 0.04, 0.15, 0.5, 8, 6); base.translate(sg * (x0 + (hw - x0) / 2), belt + 0.012, z);
    B.gloss.push(norm(base));
  }
}

function buildRoofParts(S, B) {
  const G = S.gh;
  const roofAt = (z, x) => { const g = ghSec(S, z); return g.topY(Math.min(Math.abs(x), g.x2)); };
  if (S.spoiler) {
    // roof spoiler overhanging the rear glass
    const zr = S.gh.keys[S.gh.keys.length - 2][1];
    const z0 = zr + 0.06, z1 = zr - 0.13;
    const gbs = new GB();
    const NX = 8, NZ = 3;
    const ids = [];
    const xw = G.fXc(zr) - 0.02;
    for (let i = 0; i <= NX; i++) {
      const x = lerp(-xw, xw, i / NX), col = [];
      for (let k = 0; k <= NZ; k++) {
        const z = lerp(z0, z1, k / NZ);
        const yb = roofAt(z0, x) + 0.004 - 0.03 * (k / NZ) * (k / NZ);
        col.push([gbs.v(x, yb + 0.012 - 0.006 * k / NZ, z, 0, 1, 0), gbs.v(x, yb - 0.022 + 0.012 * k / NZ, z, 0, -1, 0)]);
      }
      ids.push(col);
    }
    for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
      gbs.t(ids[i][k][0], ids[i + 1][k][0], ids[i][k + 1][0]); gbs.t(ids[i + 1][k][0], ids[i + 1][k + 1][0], ids[i][k + 1][0]);
      gbs.t(ids[i][k][1], ids[i][k + 1][1], ids[i + 1][k][1]); gbs.t(ids[i + 1][k][1], ids[i][k + 1][1], ids[i + 1][k + 1][1]);
    }
    for (let i = 0; i < NX; i++) { const a = ids[i][NZ], b = ids[i + 1][NZ]; gbs.t(a[0], a[1], b[0]); gbs.t(b[0], a[1], b[1]); }
    for (const i of [0, NX]) for (let k = 0; k < NZ; k++) { const a = ids[i][k], b = ids[i][k + 1]; gbs.t(a[0], b[0], a[1]); gbs.t(b[0], b[1], a[1]); }
    const g = gbs.geo(); g.computeVertexNormals();
    B[S.name === 'suv' ? 'gloss' : 'paint'].push(g);
  }
  if (S.rails) {
    for (const sg of [1, -1]) {
      const pts = [];
      for (let k = 0; k <= 12; k++) {
        const z = lerp(S.rails.z0, S.rails.z1, k / 12);
        const g = ghSec(S, z), x = g.x2 + g.rc * 0.15;
        const e = Math.min(k, 12 - k) / 12;
        const lift = 0.04 * sstep(0, 0.06, e);
        pts.push(new THREE.Vector3(sg * x, g.topY(x) + 0.006 + lift, z));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.015, 6, false);
      tube.scale(1, 1, 1);
      B[S.rails.color === 'gloss' ? 'gloss' : 'chrome'].push(norm(tube));
      for (const z of [S.rails.z0 + 0.03, S.rails.z1 - 0.03]) {
        const g = ghSec(S, z), x = g.x2 + g.rc * 0.15;
        const foot = new THREE.BoxGeometry(0.04, 0.05, 0.1); foot.translate(sg * x, g.topY(x) + 0.012, z);
        B.plastic.push(norm(foot));
      }
    }
  }
  // shark fin antenna
  const zr = S.gh.keys[S.gh.keys.length - 2][1] + 0.16;
  const fin = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = fin.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setXYZ(i, p.getX(i) * 0.03, y * 0.055, p.getZ(i) * 0.1 + (0.05 * y)); }
  fin.computeVertexNormals();
  fin.translate(0, roofAt(zr, 0) - 0.003, zr);
  B.gloss.push(norm(fin));
}

function buildInterior(S, B) {
  const G = S.gh, I = S.interior;
  const gbI = new GB();
  // dark floor at belt height across the cabin
  const zA = I.dash[0], zB = I.floorEnd, N = 16;
  const ids = [];
  for (let k = 0; k <= N; k++) {
    const z = lerp(zA, zB, k / N), y = S.fTop(z) + 0.004, x = G.fX0(z) - 0.035;
    ids.push([gbI.v(-x, y, z), gbI.v(x, y, z)]);
  }
  for (let k = 0; k < N; k++) { gbI.t(ids[k][0], ids[k][1], ids[k + 1][0]); gbI.t(ids[k][1], ids[k + 1][1], ids[k + 1][0]); }
  orientTris(gbI);
  B.interior.push(gbI.geo());
  const box = (w, h, d, x, y, z, rx = 0) => { const b = roundedBox(w, h, d, 0.45); b.rotateX(rx); b.translate(x, y, z); B.interior.push(norm(b)); };
  // dashboard ramp
  {
    const [z0, z1, hgt] = I.dash; const belt = S.fTop(z0);
    const xw = G.fX0(z1) - 0.06;
    const d = new GB();
    const under = (z, y) => Math.min(y, G.fRoof(z) + G.crown * 0.5 - 0.06);
    const prof = [[z0, belt], [lerp(z0, z1, 0.55), belt + hgt], [z1, belt + hgt], [z1 - 0.05, belt + hgt * 0.4], [z1 - 0.05, belt]].map(([z, y]) => [z, under(z, y)]);
    const L = [], Rr = [];
    for (const [z, y] of prof) { L.push(d.v(-xw, y, z)); Rr.push(d.v(xw, y, z)); }
    for (let i = 0; i < prof.length - 1; i++) { d.t(L[i], Rr[i], L[i + 1]); d.t(Rr[i], Rr[i + 1], L[i + 1]); }
    const g = d.geo(); g.computeVertexNormals(); B.interior.push(g);
    // steering wheel (left-hand drive -> +X is driver's left)
    const sw = new THREE.TorusGeometry(0.17, 0.018, 6, 18); sw.rotateX(-0.95);
    sw.translate(0.37, Math.min(belt + hgt + 0.1, G.fRoof(z1 - 0.12) - 0.2), z1 - 0.12);
    B.interior.push(norm(sw));
  }
  // seats
  const roofIn = (z) => G.fRoof(z) + G.crown * 0.6 - 0.1;
  const seat = (x, z, w) => {
    const belt = S.fTop(z), top = Math.min(belt + I.seatTop, roofIn(z) - 0.2);
    box(w, top - belt + 0.1, 0.12, x, (top + belt - 0.1) / 2, z, -0.22);
    box(w * 0.5, 0.16, 0.1, x, top + 0.09, z - 0.07, -0.2);
  };
  seat(0.37, I.frontSeat, 0.5); seat(-0.37, I.frontSeat, 0.5);
  {
    const z = I.rearSeat, belt = S.fTop(z), top = Math.min(belt + I.seatTop - 0.02, roofIn(z) - 0.2);
    box(1.3, top - belt + 0.1, 0.13, 0, (top + belt - 0.1) / 2, z, -0.25);
    for (const x of [-0.4, 0, 0.4]) box(0.24, 0.13, 0.09, x, top + 0.07, z - 0.07, -0.2);
  }
  // underbody filler (keeps the wheel-arch tunnels dark)
  const ub = new THREE.BoxGeometry(2 * (S.track - S.tyreW / 2 - 0.03), 0.5, (S.axleF - S.axleR) + 0.7);
  ub.translate(0, S.fBot(0) - 0.04 + 0.25, (S.axleF + S.axleR) / 2);
  B.plastic.push(norm(ub));
  // wipers lying on the windshield base
  for (const [x, a] of [[0.05, 0.1], [-0.55, 0.05]]) {
    const zc = S.gh.keys[1][1] - 0.03;
    const g = ghSec(S, zc);
    const w = new THREE.BoxGeometry(0.58, 0.012, 0.022); w.rotateY(a); w.translate(x + 0.29, g.topY(Math.abs(x)) + 0.012, zc);
    B.plastic.push(norm(w));
  }
}

const SHADOWS = new Map();
function contactShadowGeo(S) {
  const W = 2.3, L = S.halfL * 2 + 0.6;
  const g = new THREE.PlaneGeometry(W, L); g.rotateX(-Math.PI / 2); g.translate(0, 0.006, 0);
  return g;
}
function shadowMaterial(S) {
  if (SHADOWS.has(S.name)) return SHADOWS.get(S.name);
  const w = 128, h = 256, W = 2.3, L = S.halfL * 2 + 0.6;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const img = g.createImageData(w, h);
  const hx = S.fHw(0) - 0.05, hz = S.halfL - 0.15, rad = 0.35;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = (i + 0.5) / w * W - W / 2, z = (0.5 - (j + 0.5) / h) * L;
    const qx = Math.max(Math.abs(x) - (hx - rad), 0), qz = Math.max(Math.abs(z) - (hz - rad), 0);
    const d = Math.hypot(qx, qz) - rad; // signed distance to rounded rect
    let a = 0.62 * (1 - sstep(-0.35, 0.3, d));
    for (const az of [S.axleF, S.axleR]) for (const sx of [-1, 1]) {
      const dd = Math.hypot((x - sx * S.track) / 0.1, (z - az) / 0.14);
      a = Math.max(a, 0.7 * Math.exp(-dd * dd * 2.0));
    }
    const k = (j * w + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 0; img.data[k + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ color: 0x000000, map: t, transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  SHADOWS.set(S.name, m);
  return m;
}

/* ------------------------------------------------------------------ public */
export function buildCar({ color = 0x2d4f7c, seed = 1, style = 'hatchback', plate = 'K-482-RV' } = {}) {
  const S = styles()[style] || styles().hatchback;
  const rng = mulberry32((seed | 0) * 7919 + 13);
  const design = Math.floor(rng() * 3) % 3;
  const darkRims = rng() < 0.35;
  const t0 = performance.now();
  const geos = buildStyle(S, design);
  const dt = performance.now() - t0;
  const m = mats();
  const matFor = {
    paint: paintMaterial(color), plastic: m.plastic, gloss: m.gloss, glass: m.glass, chrome: m.chrome, lamps: m.lamps, interior: m.interior,
    tyre: m.tyre, rim: darkRims ? m.rim1 : m.rim0, metal: m.metal, plate: plateMaterial(plate), shadow: shadowMaterial(S),
  };
  const group = new THREE.Group(); group.name = 'car-' + S.name;
  const order = ['shadow', 'plastic', 'paint', 'gloss', 'chrome', 'tyre', 'rim', 'metal', 'interior', 'lamps', 'plate', 'glass'];
  for (const k of order) {
    if (!geos[k]) continue;
    const mesh = new THREE.Mesh(geos[k], matFor[k]);
    mesh.name = k;
    mesh.castShadow = !['shadow', 'lamps', 'plate', 'interior'].includes(k);
    mesh.receiveShadow = k !== 'shadow' && k !== 'glass';
    if (['shadow', 'glass', 'lamps', 'plate'].includes(k)) mesh.userData.noAO = true;
    if (k === 'shadow') mesh.renderOrder = -1;
    group.add(mesh);
  }
  if (DEBUG) { let tot = 0; const parts = []; group.children.forEach((c) => { const t = c.geometry.index.count / 3; tot += t; parts.push(c.name + ':' + t); }); console.warn('CARSTATS ' + S.name + ' ms=' + dt.toFixed(0) + ' tris=' + tot + ' meshes=' + group.children.length + ' ' + parts.join(' ')); }
  return group;
}
const DEBUG = false;
