// Compact foldable enterprise survey drone with RTK module (generic design, no logos or text).
// Real size, metres. Origin at the body centre, front = +Z, up = +Y.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Monotone cubic interpolation through [x, y] keys (Fritsch-Carlson), for smooth body profiles.
function curve(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/* ------------------------------------------------------------------------------------------------
   Body: a lofted superellipse shell. Surface parameter (th, s): th around the section (0 = +X side,
   PI/2 = top), s along the body from the rear tip (0) to the nose tip (1), with superellipse end caps.
-------------------------------------------------------------------------------------------------*/
const BODY = {
  z0: -0.112, z1: 0.114, rr: 0.020, rf: 0.030, kr: 4.2, kf: 3.0, sR: 0.16, sF: 0.20,
  hw: curve([[-0.112, 0.039], [-0.08, 0.0425], [-0.04, 0.0455], [0.0, 0.0475], [0.035, 0.0490], [0.062, 0.0455], [0.090, 0.0355], [0.114, 0.0245]]),
  top: curve([[-0.112, 0.025], [-0.085, 0.0325], [-0.04, 0.0400], [0.0, 0.0435], [0.030, 0.0430], [0.060, 0.0360], [0.090, 0.0225], [0.114, 0.0090]]),
  bot: curve([[-0.112, -0.026], [-0.08, -0.0320], [-0.03, -0.0340], [0.05, -0.0340], [0.080, -0.0300], [0.114, -0.0195]]),
  ex: 2 / 5.0, eTop: 2 / 3.6, eBot: 2 / 6.0, mid: 0.42, narrow: 0.26,
};

function bodyZE(s) {
  const L0 = BODY.z0 + BODY.rr, L1 = BODY.z1 - BODY.rf;
  if (s < BODY.sR) {
    const phi = (1 - s / BODY.sR) * Math.PI / 2;
    return [L0 - BODY.rr * Math.pow(Math.sin(phi), 2 / BODY.kr), Math.pow(Math.cos(phi), 2 / BODY.kr)];
  }
  if (s > 1 - BODY.sF) {
    const phi = Math.min(1, (s - (1 - BODY.sF)) / BODY.sF) * Math.PI / 2;
    return [L1 + BODY.rf * Math.pow(Math.sin(phi), 2 / BODY.kf), Math.pow(Math.max(0, Math.cos(phi)), 2 / BODY.kf)];
  }
  return [L0 + (L1 - L0) * (s - BODY.sR) / (1 - BODY.sR - BODY.sF), 1];
}

function bodyPoint(th, s, out = new THREE.Vector3()) {
  const [z, e] = bodyZE(s);
  const c = Math.cos(th), sn = Math.sin(th);
  const top = BODY.top(z), bot = BODY.bot(z), mid = bot + BODY.mid * (top - bot);
  const narrow = 1 - BODY.narrow * Math.pow(Math.max(0, sn), 1.6);
  const x = BODY.hw(z) * e * narrow * spow(c, BODY.ex);
  const y = sn >= 0 ? mid + (top - mid) * e * Math.pow(sn, BODY.eTop) : mid - (mid - bot) * e * Math.pow(-sn, BODY.eBot);
  return out.set(x, y, z);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
// Surface point, outward normal and metric scale (metres per unit th / per unit s) at (th, s).
function bodyFrame(th, s) {
  const e = 1e-4;
  const p = bodyPoint(th, s);
  bodyPoint(th + e, s, _a); bodyPoint(th - e, s, _b);
  const s0 = Math.max(0.0005, s - e), s1 = Math.min(0.9995, s + e);
  bodyPoint(th, s1, _c); bodyPoint(th, s0, _d);
  const dth = _a.clone().sub(_b).divideScalar(2 * e);
  const ds = _c.clone().sub(_d).divideScalar(s1 - s0);
  const n = dth.clone().cross(ds).normalize();
  const h = 0.08, h2 = 0.02;
  const lth = bodyPoint(th + h, s, _a).distanceTo(bodyPoint(th - h, s, _b)) / (2 * h);
  const sa = Math.max(0.001, s - h2), sb = Math.min(0.999, s + h2);
  const ls = bodyPoint(th, sb, _c).distanceTo(bodyPoint(th, sa, _d)) / (sb - sa);
  return { p, n, lth, ls };
}

// Shell grid and two-tone split: face columns SHELL_GREY[0] <= i < SHELL_GREY[1] form the grey lower shell.
// The split is cut from the shell's own faces (no overlay), so the white shell can never show through.
const SHELL_NTH = 40, SHELL_NS = 34, SHELL_GREY = [22, 38];
const SPLIT_TH = SHELL_GREY.map((i) => (i / SHELL_NTH) * TAU);

// Returns [whiteShell, greyLowerShell]; both share one smooth-normal vertex set, so shading is continuous across the split.
function bodyGeometry(nTh, nS, grey) {
  const pos = [], idx = [[], []];
  const p = new THREE.Vector3();
  for (let j = 1; j < nS; j++) for (let i = 0; i < nTh; i++) { bodyPoint((i / nTh) * TAU, j / nS, p); pos.push(p.x, p.y, p.z); }
  const rear = (nS - 1) * nTh, front = rear + 1;
  bodyPoint(0, 0, p); pos.push(p.x, p.y, p.z);
  bodyPoint(0, 1, p); pos.push(p.x, p.y, p.z);
  const V = (i, j) => (j - 1) * nTh + (i % nTh);
  const side = (i) => idx[i >= grey[0] && i < grey[1] ? 1 : 0];
  for (let j = 1; j < nS - 1; j++) for (let i = 0; i < nTh; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
    side(i).push(a, b, c, b, d, c);
  }
  for (let i = 0; i < nTh; i++) { side(i).push(rear, V(i + 1, 1), V(i, 1)); side(i).push(V(i, nS - 1), V(i + 1, nS - 1), front); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx[0].concat(idx[1]));
  g.computeVertexNormals();
  return idx.map((ix) => {
    const h = new THREE.BufferGeometry();
    h.setAttribute('position', g.attributes.position);
    h.setAttribute('normal', g.attributes.normal);
    h.setIndex(ix);
    return h;
  });
}

// Superellipse-shaped decal patch that follows the body surface (offset along the normal).
// w = size around the section, h = size along the body (metres at the patch centre).
function bodyPatch({ th, s, w, h, n = 4, off = 0.0005, rings = 3, seg = 24 }) {
  const f = bodyFrame(th, s);
  const ath = (w / 2) / f.lth, as = (h / 2) / f.ls;
  const pos = [], nor = [], idx = [];
  const push = (u, v) => {
    const fr = bodyFrame(th + u * ath, Math.min(0.995, Math.max(0.005, s + v * as)));
    pos.push(fr.p.x + fr.n.x * off, fr.p.y + fr.n.y * off, fr.p.z + fr.n.z * off);
    nor.push(fr.n.x, fr.n.y, fr.n.z);
  };
  push(0, 0);
  for (let r = 1; r <= rings; r++) {
    const rho = r / rings;
    for (let k = 0; k < seg; k++) { const a = (k / seg) * TAU; push(rho * spow(Math.cos(a), 2 / n), rho * spow(Math.sin(a), 2 / n)); }
  }
  const R = (r, k) => 1 + (r - 1) * seg + (k % seg);
  for (let k = 0; k < seg; k++) idx.push(0, R(1, k), R(1, k + 1));
  for (let r = 1; r < rings; r++) for (let k = 0; k < seg; k++) {
    const a = R(r, k), b = R(r, k + 1), c = R(r + 1, k), d = R(r + 1, k + 1);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// Rectangular band in (th, s) parameter space following the surface (seams, shells).
function bodyBand(th0, th1, s0, s1, nth, ns, off) {
  const pos = [], nor = [], idx = [];
  for (let j = 0; j <= ns; j++) for (let i = 0; i <= nth; i++) {
    const fr = bodyFrame(th0 + (th1 - th0) * (i / nth), s0 + (s1 - s0) * (j / ns));
    pos.push(fr.p.x + fr.n.x * off, fr.p.y + fr.n.y * off, fr.p.z + fr.n.z * off);
    nor.push(fr.n.x, fr.n.y, fr.n.z);
  }
  const W = nth + 1;
  for (let j = 0; j < ns; j++) for (let i = 0; i < nth; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// Matrix placing a +Y-up local part on the body surface at (th, s), lifted by `lift` along the normal.
function onBody(th, s, lift = 0) {
  const f = bodyFrame(th, s);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), f.n);
  return new THREE.Matrix4().compose(f.p.clone().addScaledVector(f.n, lift), q, new THREE.Vector3(1, 1, 1));
}

/* ---------- swept rounded tube (arms, gimbal yoke) ---------- */
function sweep(points, wf, hf, nAround = 14, nAlong = 14, ex = 3) {
  const crv = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const pos = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(), u = new THREE.Vector3();
  for (let j = 0; j <= nAlong; j++) {
    const t = j / nAlong, C = crv.getPoint(t), T = crv.getTangent(t);
    side.crossVectors(T, up).normalize(); u.crossVectors(side, T).normalize();
    const w = wf(t) / 2, h = hf(t) / 2;
    for (let i = 0; i < nAround; i++) {
      const a = (i / nAround) * TAU, x = w * spow(Math.cos(a), 2 / ex), y = h * spow(Math.sin(a), 2 / ex);
      pos.push(C.x + side.x * x + u.x * y, C.y + side.y * x + u.y * y, C.z + side.z * x + u.z * y);
    }
  }
  for (let j = 0; j < nAlong; j++) for (let i = 0; i < nAround; i++) {
    const a = j * nAround + i, b = j * nAround + ((i + 1) % nAround), c = a + nAround, d = b + nAround;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const lathe = (pts, seg = 24) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/* ---------- merge helpers ---------- */
function prep(g) {
  let geo = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  geo.clearGroups();
  return geo;
}
// Weld a non-indexed merged geometry back into an indexed one: vertices with the same quantised position,
// normal and uv share one index (hard edges keep their split normals).
function weld(g) {
  const pa = g.attributes.position.array, na = g.attributes.normal.array, ua = g.attributes.uv.array, n = g.attributes.position.count;
  const map = new Map(), P = [], N = [], U = [], idx = new Array(n);
  const q = (v, k) => Math.round(v * k);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3, i2 = i * 2;
    const key = q(pa[i3], 1e6) + ',' + q(pa[i3 + 1], 1e6) + ',' + q(pa[i3 + 2], 1e6) + ',' + q(na[i3], 1e3) + ',' + q(na[i3 + 1], 1e3) + ',' +
      q(na[i3 + 2], 1e3) + ',' + q(ua[i2], 1e4) + ',' + q(ua[i2 + 1], 1e4);
    let v = map.get(key);
    if (v === undefined) {
      v = P.length / 3; map.set(key, v);
      P.push(pa[i3], pa[i3 + 1], pa[i3 + 2]); N.push(na[i3], na[i3 + 1], na[i3 + 2]); U.push(ua[i2], ua[i2 + 1]);
    }
    idx[i] = v;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  out.setIndex(idx);
  return out;
}
function flipWinding(g) {
  for (const k of Object.keys(g.attributes)) {
    const a = g.attributes[k], s = a.itemSize, arr = a.array;
    for (let i = 0; i < a.count; i += 3) for (let c = 0; c < s; c++) {
      const i1 = (i + 1) * s + c, i2 = (i + 2) * s + c, t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
    }
  }
}
function put(list, geo, m) {
  const g = prep(geo);
  if (m) { g.applyMatrix4(m); if (m.determinant() < 0) flipWinding(g); }
  list.push(g);
}
const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);

/* ---------- layout ---------- */
const GROUND = -0.054;                      // underside of the landing feet
const FRONT_POD = new THREE.Vector3(0.126, 0.034, 0.128);
const REAR_POD = new THREE.Vector3(0.124, 0.016, -0.150);
const POD_H = 0.014, BELL_H = 0.0135;
const PROP_R = 0.119;
// motor order: front-left(+X), front-right(-X), rear-left(+X), rear-right(-X); dir +1 = CCW seen from above
const MOTORS = [
  { x: FRONT_POD.x, y: FRONT_POD.y, z: FRONT_POD.z, dir: -1 },
  { x: -FRONT_POD.x, y: FRONT_POD.y, z: FRONT_POD.z, dir: 1 },
  { x: REAR_POD.x, y: REAR_POD.y, z: REAR_POD.z, dir: 1 },
  { x: -REAR_POD.x, y: REAR_POD.y, z: REAR_POD.z, dir: -1 },
];
{
  let ccw = 0, cw = 0;
  for (const m of MOTORS) { m.propY = m.y + POD_H / 2 + BELL_H + 0.0026; m.slot = m.dir > 0 ? ccw++ : cw++; }
}

/* ---------- textures & materials (module-level cache) ---------- */
let CACHE = null;

function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

function discTexture() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S), d = img.data;
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / (S / 2) - 1, dy = (y + 0.5) / (S / 2) - 1, r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
    let a = 0;
    if (r < 1) {
      a = 0.34 - 0.22 * sm(0.12, 0.8, r);                       // dense near the root, thin outboard
      a += 0.08 * Math.exp(-Math.pow((r - 0.935) / 0.025, 2));   // tip trace
      a *= sm(0.075, 0.10, r) * (1 - sm(0.965, 0.995, r));
      a *= 1 + 0.16 * Math.cos(2 * ang + 1.3 * r) + 0.05 * Math.sin(ang * 29 + r * 17);
    }
    const o = (y * S + x) * 4, l = 30 + 14 * sm(0.5, 1, r);
    d[o] = l; d[o + 1] = l + 3; d[o + 2] = l + 7; d[o + 3] = Math.max(0, Math.min(255, a * 255));
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// 3x1 emissive palette for the navigation lights: red, green, white (LED geometry UVs point at one texel).
const LED_U = { red: 1 / 6, green: 3 / 6, white: 5 / 6 };
function ledTexture() {
  const c = makeCanvas(3, 1), g = c.getContext('2d');
  ['#ff0800', '#00ff30', '#ffffff'].forEach((col, i) => { g.fillStyle = col; g.fillRect(i, 0, 1, 1); });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
function withUV(geo, u) {
  const g = prep(geo), n = g.attributes.position.count, uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function makeMaterials() {
  return {
    body: new THREE.MeshPhysicalMaterial({ color: 0xe3e6e8, roughness: 0.42, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.28 }),
    grey: new THREE.MeshStandardMaterial({ color: 0x8b9299, roughness: 0.46, metalness: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x4c535b, roughness: 0.3, metalness: 0.75 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x080a0d, roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
    led: new THREE.MeshStandardMaterial({ color: 0x0c0c0c, emissive: 0xffffff, emissiveMap: ledTexture(), emissiveIntensity: 1.7, roughness: 0.3 }),
    prop: new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.42, metalness: 0.05 }),
    disc: new THREE.MeshStandardMaterial({ map: discTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.55, metalness: 0 }),
  };
}

/* ---------- propeller blade ---------- */
// Two-blade CCW prop in its local frame: blades along +/-X, hub at origin, leading edge of the +X blade toward -Z.
function propGeometry() {
  const NS = 13, NC = 8, r0 = 0.007, R = PROP_R;
  const pos = [], idx = [];
  for (let k = 0; k < NS; k++) {
    const t = Math.sin((k / (NS - 1)) * Math.PI / 2) ** 1.15, r = r0 + (R - r0) * t;
    const rn = r / R;
    let chord = 0.009 + 0.032 * rn * Math.exp(-rn * 2.6) * 2.2;            // ~0.022 at 35% radius
    chord *= 1 - 0.75 * Math.pow(Math.max(0, (rn - 0.82) / 0.18), 2.2);      // rounded tip
    chord = Math.max(chord, 0.0012);
    const thick = chord * (0.16 - 0.08 * rn);
    const beta = Math.atan(0.11 / (TAU * Math.max(r, 0.02)));              // pitch ~ 11 cm
    const sweep = 0.010 * rn * rn;                                          // tips swept back
    const lift = 0.004 * rn;                                                // slight dihedral
    for (let c = 0; c < NC; c++) {
      const a = (c / NC) * TAU, cu = Math.cos(a);
      const u = 0.5 * chord * cu - 0.12 * chord;                            // + toward leading edge
      const v = 0.5 * thick * Math.sin(a) * (cu > 0 ? 1 : 0.55) + 0.25 * thick;
      const y = lift + u * Math.sin(beta) + v * Math.cos(beta);
      const z = -(u * Math.cos(beta) - v * Math.sin(beta)) + sweep;
      pos.push(r, y, z);
    }
  }
  // tip and root caps
  const tip = pos.length / 3; pos.push(R + 0.0006, 0.004, 0.010);
  const root = tip + 1; pos.push(r0 - 0.001, 0, 0);
  for (let k = 0; k < NS - 1; k++) for (let c = 0; c < NC; c++) {
    const a = k * NC + c, b = k * NC + ((c + 1) % NC), cc = a + NC, d = b + NC;
    idx.push(a, b, cc, b, d, cc);
  }
  for (let c = 0; c < NC; c++) {
    idx.push((NS - 1) * NC + c, (NS - 1) * NC + ((c + 1) % NC), tip);
    idx.push(root, (c + 1) % NC, c);
  }
  const one = new THREE.BufferGeometry();
  one.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  one.setIndex(idx);
  one.computeVertexNormals();
  const parts = [];
  put(parts, one);
  put(parts, one, M(0, 0, 0, 0, Math.PI, 0));
  return mergeGeometries(parts);
}

/* ---------- static parts ---------- */
function buildParts() {
  const P = { body: [], grey: [], dark: [], metal: [], glass: [], led: [] };
  const bothSides = (key, geo, m) => { put(P[key], geo, m); put(P[key], geo, MIRROR.clone().multiply(m)); };
  const HALF = Math.PI / 2;

  /* shell + design lines */
  const [shellWhite, shellGrey] = bodyGeometry(SHELL_NTH, SHELL_NS, SHELL_GREY);
  put(P.body, shellWhite);
  put(P.grey, shellGrey);
  put(P.dark, bodyBand(0, TAU, 0.352, 0.3565, 40, 1, 0.0005));                       // battery seam
  for (const sd of [1, -1]) {
    const thv = sd > 0 ? 0.12 : Math.PI - 0.12;
    put(P.grey, bodyPatch({ th: thv, s: 0.505, w: 0.017, h: 0.034, n: 5, off: 0.0004, rings: 2, seg: 24 }));   // side vent panel
    for (let i = 0; i < 4; i++) put(P.dark, bodyBand(thv - 0.11, thv + 0.11, 0.4755 + i * 0.02, 0.4795 + i * 0.02, 2, 1, 0.0007));
    put(P.grey, bodyPatch({ th: sd > 0 ? 0.0 : Math.PI, s: 0.33, w: 0.011, h: 0.007, n: 4, off: 0.0005, rings: 1, seg: 16 }));  // battery latch
  }
  for (let i = 0; i < 5; i++) put(P.grey, bodyBand(HALF - 0.5, HALF + 0.5, 0.185 + i * 0.027, 0.1905 + i * 0.027, 6, 1, 0.0005)); // grip ribs

  /* vision sensors: glossy front face plate and grey rear plate with lens pairs, grey lower shell with downward pair */
  const ring = lathe([[0.0040, 0], [0.0056, 0], [0.0058, 0.0011], [0.0044, 0.0015]], 16);
  const eye = lathe([[0.0045, 0], [0.0044, 0.0008], [0.0029, 0.0016], [0, 0.0018]], 16);
  put(P.glass, bodyBand(0, TAU, 0.925, 1.0, 40, 5, 0.0004));
  put(P.grey, bodyBand(0, TAU, 0.0, 0.055, 40, 4, 0.0004));
  for (const sd of [1, -1]) {
    put(P.metal, ring, onBody(HALF - sd * 0.80, 0.955, 0.0004));
    put(P.glass, eye, onBody(HALF - sd * 0.80, 0.955, 0.0004));
    put(P.metal, ring, onBody(HALF - sd * 0.80, 0.040, 0.0004));
    put(P.glass, eye, onBody(HALF - sd * 0.80, 0.040, 0.0004));
  }
  // shell split line on the two-tone boundary, sampled at twice the shell's s density so its chords always clear the shell's
  for (const th of SPLIT_TH) put(P.dark, bodyBand(th - 0.012, th + 0.012, 4 / (2 * SHELL_NS), 63 / (2 * SHELL_NS), 1, 59, 0.0005));
  for (const s of [0.56, 0.66]) { put(P.metal, ring, onBody(-HALF, s, 0.0008)); put(P.glass, eye, onBody(-HALF, s, 0.0008)); }
  put(P.glass, bodyPatch({ th: -HALF, s: 0.43, w: 0.013, h: 0.009, n: 4, off: 0.0008, rings: 2, seg: 16 }));  // auxiliary light

  /* arms: flat rounded beams, front pair high, rear pair low */
  const frontArm = sweep([V3(0.026, 0.019, 0.046), V3(0.046, 0.021, 0.057), V3(0.086, 0.027, 0.093), V3(FRONT_POD.x, FRONT_POD.y - 0.002, FRONT_POD.z)],
    (t) => 0.028 - 0.012 * t, (t) => 0.0135 - 0.004 * t, 12, 12, 4);
  const rearArm = sweep([V3(0.020, -0.022, -0.066), V3(0.044, -0.0212, -0.080), V3(0.084, -0.006, -0.114), V3(REAR_POD.x, REAR_POD.y - 0.002, REAR_POD.z)],
    (t) => 0.027 - 0.011 * t, (t) => 0.0135 - 0.004 * t, 12, 12, 4);
  bothSides('body', frontArm, new THREE.Matrix4());
  bothSides('body', rearArm, new THREE.Matrix4());
  const hinge = lathe([[0, 0], [0.0086, 0], [0.0092, 0.0018], [0.0092, 0.0162], [0.0086, 0.018], [0, 0.018]], 14);
  bothSides('grey', hinge, M(0.044, 0.011, 0.056));
  bothSides('grey', hinge, M(0.042, -0.0305, -0.080));

  /* motors */
  const pod = lathe([[0, -0.007], [0.009, -0.007], [0.0132, -0.0062], [0.0148, -0.0040], [0.0151, 0.0040], [0.0146, 0.0062], [0.0136, 0.0070], [0, 0.0070]], 16);
  const bell = lathe([[0, 0], [0.0136, 0], [0.0139, 0.0015], [0.0139, 0.0108], [0.0127, 0.0128], [0.0060, 0.0134], [0, 0.0135]], 16);
  const hub = lathe([[0, 0], [0.0090, 0], [0.0094, 0.0016], [0.0072, 0.0036], [0, 0.0042]], 12);
  for (const m of MOTORS) {
    put(P.body, pod, M(m.x, m.y, m.z));
    put(P.metal, bell, M(m.x, m.y + POD_H / 2, m.z));
    put(P.dark, hub, M(m.x, m.y + POD_H / 2 + BELL_H - 0.0004, m.z));
  }

  /* landing gear: fins under the front motors, pads under the rear-arm elbows */
  const fin = new THREE.Shape();
  const FL = FRONT_POD.y - GROUND - 0.004;
  fin.moveTo(-0.0080, 0.0); fin.lineTo(0.0080, 0.0);
  fin.bezierCurveTo(0.0068, -FL * 0.4, 0.0042, -FL * 0.8, 0.0034, -FL + 0.004);
  fin.quadraticCurveTo(0.0, -FL - 0.001, -0.0034, -FL + 0.004);
  fin.bezierCurveTo(-0.0042, -FL * 0.8, -0.0068, -FL * 0.4, -0.0080, 0.0);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.0032, bevelEnabled: true, bevelThickness: 0.0013, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 6 });
  finGeo.translate(0, 0, -0.0016).rotateY(HALF);
  const SPLAY = 0.10, finM = M(FRONT_POD.x, FRONT_POD.y, FRONT_POD.z, 0, 0, SPLAY);
  bothSides('body', finGeo, finM);
  bothSides('dark', lathe([[0, 0], [0.0030, 0.0003], [0.0041, 0.0018], [0.0041, 0.0055], [0.0034, 0.0078], [0, 0.0082]], 12),
    finM.clone().multiply(M(0, (GROUND - FRONT_POD.y) / Math.cos(SPLAY), 0)));
  // rear feet under the rear-arm hinges: white post on a dark rubber tip (reads like the front legs at distance)
  bothSides('body', lathe([[0, 0.0074], [0.0063, 0.0074], [0.0062, 0.0090], [0.0050, 0.0290], [0, 0.0290]], 12), M(0.056, GROUND, -0.088));
  bothSides('dark', lathe([[0, 0], [0.0052, 0], [0.0066, 0.0020], [0.0066, 0.0064], [0.0058, 0.0080], [0, 0.0080]], 12), M(0.056, GROUND, -0.088));

  /* navigation lights on the front motor pods: port (+X) red, starboard (-X) green */
  const ledGeo = new THREE.SphereGeometry(0.0034, 10, 6);
  const ledM = (sx) => {
    const dir = new THREE.Vector3(sx * 0.45, 0, 1).normalize();
    const p = new THREE.Vector3(sx * FRONT_POD.x, FRONT_POD.y - 0.0005, FRONT_POD.z).addScaledVector(dir, 0.0140);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1.5, 0.75, 0.55));
  };
  P.led.push(withUV(ledGeo.clone().applyMatrix4(ledM(1)), LED_U.red));
  P.led.push(withUV(ledGeo.clone().applyMatrix4(ledM(-1)), LED_U.green));

  /* 3-axis gimbal: damper mount, yaw motor, side yoke, pitch motor, camera block with wide + tele lens */
  const GZ = 0.078, CY = -0.0395, CZ = 0.1105, MY = BODY.bot(GZ) + 0.0015;
  put(P.dark, lathe([[0, 0], [0.0130, 0], [0.0134, 0.0015], [0.0126, 0.0060], [0, 0.0060]], 20), M(0, MY - 0.006, GZ));
  put(P.metal, lathe([[0, 0], [0.0092, 0], [0.0095, 0.0015], [0.0095, 0.0060], [0.0088, 0.0070], [0, 0.0070]], 18), M(0, MY - 0.013, GZ));
  put(P.dark, sweep([V3(-0.004, MY - 0.0112, GZ), V3(0.022, MY - 0.0112, GZ), V3(0.0312, MY - 0.0125, GZ + 0.007), V3(0.0315, CY + 0.002, CZ - 0.008), V3(0.0315, CY, CZ)],
    () => 0.0050, () => 0.0090, 10, 12));
  put(P.metal, lathe([[0, 0], [0.0096, 0], [0.0099, 0.0015], [0.0099, 0.0050], [0.0090, 0.0062], [0, 0.0064]], 18), M(0.0226, CY, CZ, 0, 0, -HALF));
  put(P.dark, lathe([[0, 0], [0.0060, 0], [0.0062, 0.0020], [0.0052, 0.0034], [0, 0.0036]], 14), M(-0.0226, CY, CZ, 0, 0, HALF));
  const cam = new THREE.ExtrudeGeometry(roundedRect(0.040, 0.019, 0.0060), { depth: 0.026, bevelEnabled: true, bevelThickness: 0.0035, bevelSize: 0.0030, bevelSegments: 2, curveSegments: 4 });
  cam.translate(0, 0, -0.013);
  put(P.dark, cam, M(0, CY, CZ));
  const camFront = CZ + 0.013 + 0.0035;
  const barrel = (r) => lathe([[r * 0.9, -0.001], [r * 1.04, 0], [r * 1.04, 0.0030], [r, 0.0045], [r * 0.80, 0.0047], [r * 0.78, 0.0045]], 20);
  const lens = (r) => lathe([[r * 0.80, 0.0020], [r * 0.80, 0.0033], [r * 0.45, 0.0039], [0, 0.0040]], 20);
  put(P.metal, barrel(0.0090), M(-0.0075, CY, camFront, HALF, 0, 0));
  put(P.glass, lens(0.0090), M(-0.0075, CY, camFront, HALF, 0, 0));
  put(P.metal, barrel(0.0058), M(0.0128, CY + 0.0012, camFront, HALF, 0, 0));
  put(P.glass, lens(0.0058), M(0.0128, CY + 0.0012, camFront, HALF, 0, 0));
  put(P.glass, new THREE.CircleGeometry(0.0015, 10), M(0.0128, CY - 0.0068, camFront + 0.0002));

  /* RTK module: rounded puck on a dark mount, seam ring, short antenna */
  const rz = -0.008, ry = BODY.top(rz) - 0.0025, puckY = ry + 0.0045;
  put(P.dark, lathe([[0, 0], [0.0180, 0], [0.0186, 0.0012], [0.0178, 0.0050], [0, 0.0050]], 24), M(0, ry, rz));
  put(P.body, lathe([[0, 0], [0.0212, 0], [0.0234, 0.0014], [0.0243, 0.0042], [0.0241, 0.0090], [0.0226, 0.0120], [0.0193, 0.0138], [0.0120, 0.0148], [0, 0.0150]], 28), M(0, puckY, rz));
  put(P.dark, lathe([[0.0240, 0.0060], [0.02445, 0.0064], [0.02445, 0.0074], [0.0240, 0.0078]], 28), M(0, puckY, rz));     // puck seam
  put(P.dark, lathe([[0, 0], [0.0026, 0], [0.0026, 0.0095], [0.0021, 0.0116], [0.0010, 0.0124], [0, 0.0125]], 10), M(0, puckY + 0.0125, rz - 0.0145, -0.30, 0, 0));

  /* white anti-collision strobe on the battery top (dark glass when off) */
  put(P.dark, lathe([[0, 0], [0.0060, 0], [0.0060, 0.0016], [0, 0.0016]], 14), onBody(HALF, 0.25, -0.0003));
  put(P.glass, lathe([[0.0046, 0], [0.0042, 0.0022], [0.0025, 0.0036], [0, 0.0040]], 14), onBody(HALF, 0.25, 0.0010));

  const out = {};
  for (const k of Object.keys(P)) out[k] = weld(mergeGeometries(P[k]));
  const strobe = withUV(lathe([[0.0049, 0], [0.0045, 0.0023], [0.0027, 0.0038], [0, 0.0042]], 14), LED_U.white);
  out.strobe = weld(strobe.applyMatrix4(onBody(HALF, 0.25, 0.0010)));
  const ccw = propGeometry();
  const cw = ccw.clone(); cw.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1)); flipWinding(cw);
  out.propCCW = weld(ccw);
  out.propCW = weld(cw);
  out.disc = new THREE.RingGeometry(0.010, PROP_R + 0.001, 40, 1).rotateX(-HALF);
  return out;
}
function V3(x, y, z) { return new THREE.Vector3(x, y, z); }

function getCache() {
  if (!CACHE) CACHE = { geo: buildParts(), mat: makeMaterials() };
  return CACHE;
}

/* ---------- public API ---------- */
// Per-drone object references live in a WeakMap (userData stays JSON-safe, so Object3D.clone()/toJSON work);
// clones re-resolve their parts by name on first animateDrone call.
const REFS = new WeakMap();
function refs(root) {
  let r = REFS.get(root);
  if (!r) {
    const inner = root.getObjectByName('DroneHover');
    if (!inner) return null;
    r = { inner, strobe: inner.getObjectByName('drone-strobe'), ccw: inner.getObjectByName('drone-props-ccw'),
      cw: inner.getObjectByName('drone-props-cw'), discs: inner.getObjectByName('drone-prop-discs') };
    if (!r.strobe || !r.ccw || !r.cw || !r.discs) return null;
    REFS.set(root, r);
  }
  return r;
}

export function buildDrone({ seed = 1 } = {}) {
  const { geo, mat } = getCache();
  const rnd = mulberry32((seed | 0) * 7919 + 17);
  const root = new THREE.Group();
  root.name = 'Drone';
  const inner = new THREE.Group();
  inner.name = 'DroneHover';
  root.add(inner);

  const mk = (name, g, m, cast, recv) => {
    const o = new THREE.Mesh(g, m); o.name = name; o.castShadow = cast; o.receiveShadow = recv; inner.add(o); return o;
  };
  mk('drone-body', geo.body, mat.body, true, true);
  mk('drone-grey', geo.grey, mat.grey, true, true);
  mk('drone-dark', geo.dark, mat.dark, true, true);
  mk('drone-metal', geo.metal, mat.metal, true, true);
  mk('drone-glass', geo.glass, mat.glass, true, false).userData.noAO = true;
  mk('drone-led', geo.led, mat.led, false, false).userData.noAO = true;
  const strobe = mk('drone-strobe', geo.strobe, mat.led, false, false);
  strobe.userData.noAO = true;
  strobe.visible = false;

  const ccw = new THREE.InstancedMesh(geo.propCCW, mat.prop, 2);
  const cw = new THREE.InstancedMesh(geo.propCW, mat.prop, 2);
  ccw.name = 'drone-props-ccw'; cw.name = 'drone-props-cw';
  for (const o of [ccw, cw]) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; inner.add(o); }
  const discs = new THREE.InstancedMesh(geo.disc, mat.disc, 4);
  discs.name = 'drone-prop-discs';
  discs.userData.noAO = true;
  discs.castShadow = false; discs.receiveShadow = false; discs.frustumCulled = false;
  discs.visible = false;
  inner.add(discs);

  root.userData = {
    isDrone: true,
    props: 'blur',          // set before animating: 'blur' (motion-blur discs) | 'spin' (rotating blades) | 'stopped' (parked, no bob)
    phase: rnd() * TAU,     // hover phase
    bladeAngles: MOTORS.map(() => rnd() * Math.PI),
    discAngles: MOTORS.map(() => rnd() * TAU),
    strobePhase: 0,         // strobe flashes at whole seconds of (time + strobePhase)
  };
  const r = { inner, strobe, ccw, cw, discs };
  REFS.set(root, r);
  setProps(root.userData, r, 0, false);
  return root;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _Y = new THREE.Vector3(0, 1, 0);
function setProps(ud, r, t, flying) {
  const mode = flying ? ud.props : 'stopped';
  MOTORS.forEach((m, i) => {
    const a0 = ud.bladeAngles[i];
    _q.setFromAxisAngle(_Y, mode === 'spin' ? a0 + m.dir * 31 * t : a0); _p.set(m.x, m.propY, m.z);
    (m.dir > 0 ? r.ccw : r.cw).setMatrixAt(m.slot, _m.compose(_p, _q, _s));
    _q.setFromAxisAngle(_Y, ud.discAngles[i] + m.dir * 2.1 * t); _p.set(m.x, m.propY + 0.0004, m.z);
    r.discs.setMatrixAt(i, _m.compose(_p, _q, _s));
  });
  const blur = mode === 'blur';
  for (const b of [r.ccw, r.cw]) { b.instanceMatrix.needsUpdate = true; b.visible = !blur; }
  r.discs.instanceMatrix.needsUpdate = true;
  r.discs.visible = blur;
}

export function animateDrone(drone, timeSeconds) {
  const ud = drone && drone.userData;
  if (!ud || !ud.isDrone) return;
  const r = refs(drone);
  if (!r) return;
  const t = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const flying = ud.props !== 'stopped';
  setProps(ud, r, t, flying);
  const ph = ud.phase || 0;
  if (flying) {
    // tiny hover bob (~5 mm at real size) and attitude wobble around a slight nose-down trim
    r.inner.position.set(0, 0.0042 * Math.sin(TAU * 0.43 * t + ph) + 0.0016 * Math.sin(TAU * 1.13 * t + 2.1 * ph), 0);
    r.inner.rotation.set(0.010 * Math.sin(TAU * 0.29 * t + 1.3 * ph) + 0.010, 0, 0.009 * Math.sin(TAU * 0.37 * t + 0.7 * ph));
  } else {
    r.inner.position.set(0, 0, 0); r.inner.rotation.set(0, 0, 0);
  }
  // white anti-collision strobe: one short flash per second (front-arm red/green lights are always on)
  const f = t + (ud.strobePhase || 0);
  r.strobe.visible = f - Math.floor(f) < 0.085;
}
