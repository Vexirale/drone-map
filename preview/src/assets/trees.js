// trees.js - archviz-style street and garden vegetation for the Dutch-neighbourhood preview.
// Trees grow a recursive, tapered limb skeleton (one merged bark mesh) carrying alpha-cut leaf-cluster cards
// (one merged foliage mesh) whose normals are bent outward from the crown so the crown shades as a soft volume.
// All textures are drawn on canvases once and shared by every tree, shrub and hedge.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const V3 = THREE.Vector3;

/* ------------------------------------------------------------------ helpers */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (rng, a, b) => a + (b - a) * rng();
const ri = (rng, a, b) => Math.floor(a + (b - a + 1) * rng());
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

function ihash(x, y, z, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// smooth value noise in [-1, 1]
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (i, j, k) => ihash(xi + i, yi + j, zi + k, s);
  const a = lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v);
  const b = lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v);
  return lerp(a, b, w) * 2 - 1;
}
function randUnit(rng, out = new V3()) {
  const z = rng() * 2 - 1, a = rng() * TAU, r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}
function anyPerp(v, out = new V3()) {
  if (Math.abs(v.y) < 0.9) out.set(0, 1, 0); else out.set(1, 0, 0);
  return out.crossVectors(v, out).normalize();
}

// growable indexed geometry with position / normal / uv / color
class Geo {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; this.count = 0; }
  v(p, n, u, v, c) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.t.push(u, v); this.c.push(c[0], c[1], c[2]);
    return this.count++;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  get tris() { return this.i.length / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ------------------------------------------------------------------ canvas textures */

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mulc = (a, k) => [Math.min(255, a[0] * k), Math.min(255, a[1] * k), Math.min(255, a[2] * k)];

// Alpha-cut atlas -> DataTexture with: transparent texels filled with the cell's leaf colour (no dark fringes),
// alpha-weighted mips, and per-cell alpha rescaling so foliage keeps its coverage (does not thin out) at distance.
function alphaAtlasTexture(cv, grid) {
  const W = cv.width, H = cv.height;
  const src = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const base = new Uint8Array(src.length);
  base.set(src);
  const cw = W / grid, ch = H / grid;
  const cov0 = [];
  for (let cy = 0; cy < grid; cy++) for (let cx = 0; cx < grid; cx++) {
    let r = 0, g = 0, b = 0, wsum = 0, n = 0;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
      const o = (y * W + x) * 4, a = base[o + 3];
      if (a > 0) { r += base[o] * a; g += base[o + 1] * a; b += base[o + 2] * a; wsum += a; }
      if (a >= 128) n++;
    }
    cov0.push(n / (cw * ch));
    const ar = wsum ? r / wsum : 80, ag = wsum ? g / wsum : 110, ab = wsum ? b / wsum : 60;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
      const o = (y * W + x) * 4, a = base[o + 3];
      if (a < 40) { const t = a / 40; base[o] = lerp(ar, base[o], t); base[o + 1] = lerp(ag, base[o + 1], t); base[o + 2] = lerp(ab, base[o + 2], t); }
    }
  }
  const mips = [{ data: base, width: W, height: H }];
  let w = W, h = H, prev = base;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const d = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, rs = 0, gs = 0, bs = 0;
      for (let k = 0; k < 4; k++) {
        const sx = Math.min(w - 1, x * 2 + (k & 1)), sy = Math.min(h - 1, y * 2 + (k >> 1));
        const o = (sy * w + sx) * 4, al = prev[o + 3] + 1;
        r += prev[o] * al; g += prev[o + 1] * al; b += prev[o + 2] * al; a += prev[o + 3];
        rs += al;
      }
      const o = (y * nw + x) * 4;
      d[o] = r / rs; d[o + 1] = g / rs; d[o + 2] = b / rs; d[o + 3] = a / 4;
    }
    const ccw = nw / grid, cch = nh / grid;
    if (ccw >= 2 && cch >= 2) {
      for (let cy = 0; cy < grid; cy++) for (let cx = 0; cx < grid; cx++) {
        const target = cov0[cy * grid + cx];
        // alpha histogram -> smallest threshold alpha whose coverage reaches the level-0 coverage
        const hist = new Uint32Array(256);
        for (let y = cy * cch; y < (cy + 1) * cch; y++) for (let x = cx * ccw; x < (cx + 1) * ccw; x++) hist[d[(y * nw + x) * 4 + 3]]++;
        const need = target * ccw * cch;
        let acc = 0, th = 255;
        for (; th > 0; th--) { acc += hist[th]; if (acc >= need) break; }
        const s = Math.min(4, Math.max(0.6, 127.5 / Math.max(1, th)));
        for (let y = cy * cch; y < (cy + 1) * cch; y++) for (let x = cx * ccw; x < (cx + 1) * ccw; x++) {
          const o = (y * nw + x) * 4 + 3; d[o] = Math.min(255, d[o] * s);
        }
      }
    }
    mips.push({ data: d, width: nw, height: nh });
    prev = d; w = nw; h = nh;
  }
  const tex = new THREE.DataTexture(base, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// height canvas -> tangent-space normal map (CanvasTexture with flipY, so +v is canvas-up)
function normalFromHeight(hcv, strength) {
  const W = hcv.width, H = hcv.height;
  const hd = hcv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) h[i] = hd[i * 4] / 255;
  const hb = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += h[((y + j + H) % H) * W + ((x + i + W) % W)];
    hb[y * W + x] = s / 9;
  }
  const cv = makeCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = hb[y * W + (x + 1) % W] - hb[y * W + (x - 1 + W) % W];
    const dy = hb[((y + 1) % H) * W + x] - hb[((y - 1 + H) % H) * W + x];
    let nx = -dx * strength, ny = dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * W + x) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * 0.5 + 0.5) * 255; img.data[o + 2] = (nz * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/* ---------- leaf shapes (local space: petiole base at 0,0, tip at 0,-L) */
function leafPath(ctx, kind, L, rng) {
  ctx.beginPath();
  const asym = rr(rng, 0.9, 1.1);
  if (kind === 'oak') {
    const pts = [];
    const ph = rr(rng, 0, 0.3);
    for (let i = 0; i <= 36; i++) {
      const t = i / 36;
      const env = Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.35 + 0.65 * Math.sqrt(t));
      const lobe = 0.5 + 0.5 * Math.abs(Math.cos(Math.PI * (t * 4.2 + ph)));
      pts.push([env * lobe * L * 0.4, -t * L]);
    }
    ctx.moveTo(0, 0);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(-pts[i][0] * asym, pts[i][1]);
  } else if (kind === 'linden') {
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-0.16 * L, 0.12 * L, -0.62 * L * asym, 0.04 * L, -0.52 * L * asym, -0.38 * L);
    ctx.bezierCurveTo(-0.42 * L * asym, -0.72 * L, -0.1 * L, -0.84 * L, 0, -L);
    ctx.bezierCurveTo(0.12 * L, -0.84 * L, 0.44 * L, -0.7 * L, 0.54 * L, -0.38 * L);
    ctx.bezierCurveTo(0.62 * L, -0.02 * L, 0.16 * L, 0.06 * L, 0, 0);
  } else if (kind === 'birch' || kind === 'hydra') {
    const wd = kind === 'hydra' ? 0.42 : 0.36;
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      let e = Math.pow(Math.sin(Math.PI * Math.pow(t, kind === 'hydra' ? 0.85 : 0.62)), 0.9);
      if (i % 2 === 1 && t > 0.15 && t < 0.95) e *= 0.93; // serration
      pts.push([e * L * wd, -t * L]);
    }
    ctx.moveTo(0, 0);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(-pts[i][0] * asym, pts[i][1]);
  } else if (kind === 'maple') {
    const cy = -0.36 * L, R = 0.64 * L;
    const lobes = [[0, 1], [0.95, 0.88], [-0.95, 0.88], [1.85, 0.52], [-1.85, 0.52]];
    for (let i = 0; i <= 80; i++) {
      const a = -Math.PI + (TAU * i) / 80;
      let r = 0.24;
      for (const [ak, lk] of lobes) {
        let da = a - ak; da = Math.atan2(Math.sin(da), Math.cos(da));
        r = Math.max(r, lk * Math.pow(Math.max(0, Math.cos(da * 2.1)), 3.2));
        if (Math.abs(da) < 0.3) r = Math.max(r, lk * (1 - Math.abs(da) * 0.7) * (i % 3 === 0 ? 0.9 : 1));
      }
      if (Math.abs(Math.abs(a) - Math.PI) < 0.35) r = Math.min(r, 0.18);
      const x = Math.sin(a) * r * R, y = cy - Math.cos(a) * r * R;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else { // small ovate (boxwood / privet)
    ctx.ellipse(0, -L * 0.5, L * 0.3, L * 0.5, 0, 0, TAU);
  }
  ctx.closePath();
}

function paintLeaf(ctx, kind, L, col, rng) {
  leafPath(ctx, kind, L, rng);
  const g = ctx.createLinearGradient(-L * 0.45, -L * 0.2, L * 0.45, -L * 0.6);
  g.addColorStop(0, css(mulc(col, 0.86)));
  g.addColorStop(0.48, css(col));
  g.addColorStop(0.52, css(mulc(col, 1.04)));
  g.addColorStop(1, css(mulc(col, 1.1)));
  ctx.fillStyle = g;
  ctx.fill();
  if (L > 70) {
    ctx.lineWidth = Math.max(0.8, L * 0.012);
    ctx.strokeStyle = 'rgba(25,45,15,0.22)';
    ctx.stroke();
  }
  if (L > 30) {
    const vein = css(mixc(col, [235, 240, 190], 0.45), 0.55);
    ctx.strokeStyle = vein;
    ctx.lineWidth = Math.max(0.8, L * 0.022);
    const tipY = kind === 'maple' ? -0.95 * L : -0.94 * L;
    ctx.beginPath(); ctx.moveTo(0, kind === 'maple' ? -0.3 * L : 0); ctx.lineTo(0, tipY); ctx.stroke();
    if (L < 64) return;
    ctx.lineWidth = Math.max(0.6, L * 0.011);
    ctx.strokeStyle = css(mixc(col, [235, 240, 190], 0.35), 0.35);
    ctx.beginPath();
    if (kind === 'maple') {
      for (const a of [0.95, -0.95, 1.85, -1.85]) { ctx.moveTo(0, -0.36 * L); ctx.lineTo(Math.sin(a) * 0.5 * L, -0.36 * L - Math.cos(a) * 0.5 * L); }
    } else {
      for (let k = 1; k <= 4; k++) {
        const y = -L * (0.12 + k * 0.17);
        for (const s of [-1, 1]) { ctx.moveTo(0, y); ctx.lineTo(s * L * 0.22, y - L * 0.12); }
      }
    }
    ctx.stroke();
  }
}

function stemPoint(st, t) {
  const f = t * (st.pts.length - 1), i = Math.min(st.pts.length - 2, Math.floor(f)), u = f - i;
  const a = st.pts[i], b = st.pts[i + 1];
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}
function makeStem(x, y, ang, len, rng, bend) {
  const pts = [{ x, y }];
  const n = 8, step = len / n;
  const curl = rr(rng, -bend, bend);
  for (let i = 0; i < n; i++) {
    ang += curl / n + rr(rng, -0.06, 0.06);
    x += Math.cos(ang) * step; y += Math.sin(ang) * step;
    pts.push({ x, y });
  }
  return { pts, len };
}

// one leaf-cluster image inside the square cell (ox, oy, S)
function drawCluster(ctx, ox, oy, S, kind, o, rng) {
  ctx.save();
  ctx.beginPath(); ctx.rect(ox + 3, oy + 3, S - 6, S - 6); ctx.clip();
  const stems = [];
  stems.push(makeStem(ox + S * (0.5 + rr(rng, -0.03, 0.03)), oy + S * 0.995, -Math.PI / 2 + rr(rng, -0.1, 0.1), S * o.mainLen, rng, 0.35));
  for (let i = 0; i < o.sides; i++) {
    const t = 0.1 + 0.62 * (i + rng() * 0.7) / o.sides;
    const at = stemPoint(stems[0], t), side = i % 2 ? 1 : -1;
    const sa = o.sideAng || [0.5, 1.0];
    const sb = makeStem(at.x, at.y, at.ang + side * rr(rng, sa[0], sa[1]) * (1 - t * 0.35), S * o.sideLen * rr(rng, 0.8, 1.1) * (1 - t * 0.4), rng, 0.6 * side);
    stems.push(sb);
    if (o.sub) {
      const at2 = stemPoint(sb, rr(rng, 0.35, 0.55));
      stems.push(makeStem(at2.x, at2.y, at2.ang - side * rr(rng, 0.5, 0.9), S * o.sideLen * 0.5, rng, 0.3));
    }
  }
  const leaves = [];
  for (const st of stems) {
    const n = Math.max(2, Math.round(st.len / (S * o.spacing)));
    for (let k = 0; k < n; k++) {
      const t = 0.18 + 0.82 * (k + 0.5) / n;
      const at = stemPoint(st, t);
      const side = k % 2 ? 1 : -1;
      for (let m = 0; m < (o.whorl || 1); m++) {
        leaves.push({ x: at.x, y: at.y, ang: at.ang + side * rr(rng, 0.45, 1.2) * (m ? -1 : 1), L: S * rr(rng, o.leafLen[0], o.leafLen[1]) * (0.8 + 0.2 * t), d: rng() });
      }
    }
    const tip = stemPoint(st, 1);
    leaves.push({ x: tip.x, y: tip.y, ang: tip.ang + rr(rng, -0.2, 0.2), L: S * o.leafLen[1], d: rng() });
  }
  // twigs
  ctx.lineCap = 'round';
  for (let s = 0; s < stems.length; s++) {
    const st = stems[s], pts = st.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.strokeStyle = o.twig;
      ctx.lineWidth = Math.max(1, S * o.twigW * (s ? 0.65 : 1) * (1 - i / pts.length * 0.7));
      ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke();
    }
  }
  leaves.sort((a, b) => a.d - b.d);
  const m = 7;
  for (const lf of leaves) {
    let L = lf.L, ok = false;
    for (let k = 0; k < 6 && !ok; k++) {
      const pet = L * o.petiole;
      const cx = lf.x + Math.cos(lf.ang) * (pet + L * 0.5), cy = lf.y + Math.sin(lf.ang) * (pet + L * 0.5);
      const rad = L * (kind === 'maple' ? 0.62 : 0.52);
      if (cx - rad > ox + m && cx + rad < ox + S - m && cy - rad > oy + m && cy + rad < oy + S - m) ok = true; else L *= 0.85;
    }
    if (!ok || L < S * o.leafLen[0] * 0.5) continue;
    const pal = lf.d < 0.4 ? o.back : o.front;
    let col = hex(pal[Math.floor(rng() * pal.length)]);
    col = mulc(col, rr(rng, 0.84, 1.1) * (0.9 + 0.2 * lf.d));
    ctx.save();
    ctx.translate(lf.x, lf.y);
    ctx.rotate(lf.ang + Math.PI / 2);
    const pet = L * o.petiole;
    if (pet > 0.5) { ctx.strokeStyle = o.twig; ctx.lineWidth = Math.max(1, L * 0.03); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -pet); ctx.stroke(); }
    ctx.translate(0, -pet);
    // soft contact shadow cast on the leaves behind: gives the cluster depth
    ctx.save(); ctx.translate(L * 0.035, L * 0.07); ctx.scale(1.05, 1.04);
    leafPath(ctx, kind, L, mulberry32(7)); ctx.fillStyle = 'rgba(10,24,6,0.42)'; ctx.fill();
    ctx.restore();
    paintLeaf(ctx, kind, L, col, rng);
    ctx.restore();
  }
  ctx.restore();
}

const TEX = {};

const TREE_CELL = { oak: 0, linden: 1, birch: 2, maple: 3 };
function treeAtlas() {
  if (TEX.treeAtlas) return TEX.treeAtlas;
  const S = 512, cv = makeCanvas(S * 2, S * 2), ctx = cv.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(9001);
  const P = {
    oak: { mainLen: 0.84, sides: 9, sideLen: 0.46, sideAng: [0.7, 1.3], sub: true, spacing: 0.052, whorl: 2, leafLen: [0.1, 0.13], petiole: 0.05, twigW: 0.01, twig: '#5c4a38',
      back: [0x2f4c1e, 0x365522, 0x3d5d26], front: [0x4a6f2b, 0x527832, 0x5a8036, 0x4d722f, 0x62893b] },
    linden: { mainLen: 0.84, sides: 9, sideLen: 0.46, sideAng: [0.7, 1.3], sub: true, spacing: 0.048, whorl: 2, leafLen: [0.085, 0.11], petiole: 0.14, twigW: 0.009, twig: '#5e4b3a',
      back: [0x33531f, 0x3b5d24], front: [0x527f30, 0x5a8835, 0x63913b, 0x568532, 0x6c9841] },
    birch: { mainLen: 0.88, sides: 9, sideLen: 0.46, sideAng: [0.6, 1.2], sub: true, spacing: 0.045, whorl: 2, leafLen: [0.075, 0.095], petiole: 0.22, twigW: 0.007, twig: '#4d3a30',
      back: [0x46692a, 0x4f732e], front: [0x6a9238, 0x739c3e, 0x7da545, 0x6f973b, 0x86ad4c] },
    maple: { mainLen: 0.84, sides: 9, sideLen: 0.46, sideAng: [0.7, 1.3], sub: true, spacing: 0.056, whorl: 2, leafLen: [0.1, 0.13], petiole: 0.3, twigW: 0.009, twig: '#5a4a3a',
      back: [0x325420, 0x3a5e25], front: [0x507f2e, 0x588834, 0x60903a, 0x548431, 0x699741] },
  };
  for (const k of Object.keys(TREE_CELL)) {
    const c = TREE_CELL[k];
    drawCluster(ctx, (c % 2) * S, Math.floor(c / 2) * S, S, k, P[k], rng);
  }
  TEX.treeAtlasCanvas = cv;
  TEX.treeAtlas = alphaAtlasTexture(cv, 2);
  return TEX.treeAtlas;
}

const SHRUB_CELL = { small: 0, hydra: 1, flower: 2, grass: 3 };
function shrubAtlas() {
  if (TEX.shrubAtlas) return TEX.shrubAtlas;
  const S = 512, cv = makeCanvas(S * 2, S * 2), ctx = cv.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(4242);
  // 0: small dense leaves (boxwood / privet)
  drawCluster(ctx, 0, 0, S, 'small', { mainLen: 0.86, sides: 9, sideLen: 0.45, spacing: 0.03, whorl: 2, leafLen: [0.065, 0.09], petiole: 0.02, twigW: 0.006, twig: '#4f4630',
    back: [0x2e4e20, 0x365a24, 0x3d6228], front: [0x4a742f, 0x557f35, 0x60893b, 0x4e7a32, 0x6a9342] }, rng);
  // 1: hydrangea leaves
  drawCluster(ctx, S, 0, S, 'hydra', { mainLen: 0.7, sides: 3, sideLen: 0.4, spacing: 0.16, whorl: 2, leafLen: [0.3, 0.38], petiole: 0.08, twigW: 0.014, twig: '#5d6b3a',
    back: [0x3a6226, 0x416b2a], front: [0x56873a, 0x5f9040, 0x689846, 0x5a8a3c] }, rng);
  // 2: hydrangea mophead (near-white, tinted per shrub through vertex colour)
  {
    const ox = 0, oy = S, cx = ox + S / 2, cy = oy + S / 2, R = S * 0.43;
    const fl = [];
    for (let i = 0; i < 520; i++) {
      const a = rng() * TAU, d = Math.sqrt(rng());
      const edge = 0.86 + 0.14 * vnoise(Math.cos(a) * 2 + 3, Math.sin(a) * 2 + 3, 0.5, 77);
      if (d > edge) continue;
      fl.push({ x: cx + Math.cos(a) * d * R, y: cy + Math.sin(a) * d * R, d, r: S * rr(rng, 0.03, 0.045), rot: rng() * TAU });
    }
    fl.sort((p, q) => p.d - q.d).reverse();
    for (const f of fl) {
      const top = (cy - f.y) / R * 0.5 + 0.5;
      const light = (0.7 + 0.3 * (1 - f.d * f.d * 0.85)) * (0.82 + 0.18 * top);
      const base = mulc([242, 240, 236], light * rr(rng, 0.9, 1.05));
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      ctx.beginPath(); ctx.arc(f.r * 0.12, f.r * 0.18, f.r * 1.08, 0, TAU); ctx.fillStyle = 'rgba(60,64,80,0.3)'; ctx.fill();
      for (let p = 0; p < 4; p++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath(); ctx.ellipse(0, -f.r * 0.52, f.r * 0.44, f.r * 0.56, 0, 0, TAU);
        const pg = ctx.createLinearGradient(0, 0, 0, -f.r);
        const pc = mulc(base, rr(rng, 0.9, 1.04));
        pg.addColorStop(0, css(pc)); pg.addColorStop(1, css(mulc(pc, 0.8)));
        ctx.fillStyle = pg; ctx.fill();
        ctx.strokeStyle = 'rgba(70,70,90,0.4)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, f.r * 0.12, 0, TAU); ctx.fillStyle = 'rgba(170,180,120,0.9)'; ctx.fill();
      ctx.restore();
    }
  }
  // 3: ornamental grass blades with a few plumes
  {
    const ox = S, oy = S;
    ctx.save(); ctx.beginPath(); ctx.rect(ox + 3, oy + 3, S - 6, S - 6); ctx.clip();
    for (let i = 0; i < 46; i++) {
      const bx = ox + S * 0.5 + rr(rng, -0.2, 0.2) * S, by = oy + S;
      const lean = rr(rng, -0.35, 0.35), len = S * rr(rng, 0.7, 0.97);
      const w0 = S * rr(rng, 0.014, 0.022);
      const dark = rr(rng, 0.8, 1.1);
      const steps = 14;
      let px = bx, py = by;
      const L = [], Rr = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = bx + Math.sin(lean * t * 1.4) * len * t * 0.55 * Math.sign(lean) * Math.abs(lean) * 2.2;
        const y = by - len * t;
        const w = w0 * (1 - t * 0.92);
        L.push([x - w, y]); Rr.push([x + w, y]);
        px = x; py = y;
      }
      const g = ctx.createLinearGradient(0, by, 0, by - len);
      g.addColorStop(0, css(mulc([58, 86, 38], dark)));
      g.addColorStop(0.6, css(mulc([100, 134, 60], dark)));
      g.addColorStop(1, css(mulc([150, 160, 92], dark)));
      ctx.beginPath(); ctx.moveTo(L[0][0], L[0][1]);
      for (const p of L) ctx.lineTo(p[0], p[1]);
      for (let k = Rr.length - 1; k >= 0; k--) ctx.lineTo(Rr[k][0], Rr[k][1]);
      ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(210,220,170,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(px, py); ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const x = ox + S * (0.5 + rr(rng, -0.22, 0.22)), top = oy + S * rr(rng, 0.04, 0.12);
      ctx.strokeStyle = 'rgba(150,140,95,1)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, oy + S); ctx.lineTo(x, top + S * 0.2); ctx.stroke();
      for (let k = 0; k < 140; k++) {
        const t = rng(), yy = top + t * S * 0.24, spread = Math.sin(Math.PI * Math.min(1, t * 1.2)) * S * 0.035;
        const xx = x + rr(rng, -spread, spread);
        ctx.strokeStyle = css(mulc([222, 208, 168], rr(rng, 0.85, 1.05)), 0.9); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + rr(rng, -4, 4), yy + rr(rng, 5, 11)); ctx.stroke();
      }
    }
    ctx.restore();
  }
  TEX.shrubAtlasCanvas = cv;
  TEX.shrubAtlas = alphaAtlasTexture(cv, 2);
  return TEX.shrubAtlas;
}

// tiling dense-leaf texture used under shrub/hedge leaf cards
function coreTexture() {
  if (TEX.core) return TEX.core;
  const S = 512, cv = makeCanvas(S, S), ctx = cv.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(777);
  ctx.fillStyle = '#1f3418'; ctx.fillRect(0, 0, S, S);
  const pal = [0x2a4a1e, 0x325622, 0x3b6127, 0x456c2c, 0x4f7832, 0x5a8338, 0x65903f];
  for (let i = 0; i < 3200; i++) {
    const layer = i / 3200;
    const x = rng() * S, y = rng() * S, L = rr(rng, 13, 24), a = rng() * TAU;
    const col = mulc(hex(pal[Math.min(pal.length - 1, Math.floor(layer * pal.length * rr(rng, 0.7, 1.1)))]), rr(rng, 0.9, 1.08));
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      if (x + dx < -L || x + dx > S + L || y + dy < -L || y + dy > S + L) continue;
      ctx.save(); ctx.translate(x + dx, y + dy); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, -L * 0.5, L * 0.3, L * 0.5, 0, 0, TAU);
      ctx.fillStyle = css(col); ctx.fill();
      ctx.strokeStyle = 'rgba(15,30,10,0.4)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  TEX.core = t;
  return t;
}

// periodic (tileable) value-noise fBm over the unit square: fx, fy lattice cells at the first octave
function tileFbm(fx, fy, seed, oct) {
  const layers = [];
  for (let o = 0; o < oct; o++) {
    const px = fx << o, py = fy << o, L = new Float32Array(px * py);
    for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) L[j * px + i] = ihash(i, j, 0, seed + o) * 2 - 1;
    layers.push({ px, py, L, a: 0.5 ** (o + 1) });
  }
  const norm = layers.reduce((t, l) => t + l.a, 0);
  return (u, v) => {
    let t = 0;
    for (let o = 0; o < layers.length; o++) {
      const { px, py, L, a } = layers[o];
      const x = u * px, y = v * py, xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const su = xf * xf * (3 - 2 * xf), sv = yf * yf * (3 - 2 * yf);
      const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
      const p = L[y0 * px + x0], q = L[y0 * px + x1], r = L[y1 * px + x0], w = L[y1 * px + x1];
      t += a * (p + (q - p) * su + (r - p + (p - q - r + w) * su) * sv);
    }
    return t / norm;
  };
}

// generic plated bark (oak / linden / maple, tinted per species through vertex colour) + its normal map:
// vertically stretched, domain-warped cellular plates separated by dark fissures; tiles in both directions.
function barkTextures() {
  if (TEX.bark) return TEX.bark;
  const S = 512, cv = makeCanvas(S, S), ctx = cv.getContext('2d', { willReadFrequently: true });
  const hv = makeCanvas(S, S), hc = hv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(S, S), himg = hc.createImageData(S, S);
  const GX = 20, GY = 4;
  const fx = new Float32Array(GX * GY), fy = new Float32Array(GX * GY), sh = new Float32Array(GX * GY);
  const rng = mulberry32(5150);
  for (let i = 0; i < GX * GY; i++) { fx[i] = rng(); fy[i] = rng(); sh[i] = rng(); }
  const nWarpU = tileFbm(8, 4, 11, 3), nWarpV = tileFbm(6, 3, 13, 2), nDet = tileFbm(48, 24, 41, 3);
  const nFine1 = tileFbm(96, 6, 51, 1), nFine2 = tileFbm(40, 12, 52, 1), nLich = tileFbm(5, 5, 61, 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const wu = u + 0.022 * nWarpU(u, v), wv = v + 0.05 * nWarpV(u, v);
    const px = wu * GX, py = wv * GY;
    const cx = Math.floor(px), cy = Math.floor(py);
    let d1 = 9, d2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const k = (((gy % GY) + GY) % GY) * GX + (((gx % GX) + GX) % GX);
      const dx = gx + fx[k] - px, dy = gy + fy[k] - py;
      const d = Math.hypot(dx, dy);
      if (d < d1) { d2 = d1; d1 = d; id = k; } else if (d < d2) d2 = d;
    }
    const edge = d2 - d1;
    const fis = smoothstep(0.015, 0.09, edge);
    const det = nDet(u, v);
    const fine = nFine1(wu, v) * 0.6 + nFine2(wu, v) * 0.4;
    const lich = smoothstep(0.3, 0.62, nLich(u, v));
    const plate = fis * (0.62 + 0.38 * smoothstep(0.04, 0.45, edge)) * (0.84 + 0.16 * det) * (0.84 + 0.16 * fine);
    const tone = 0.85 + 0.3 * sh[id];
    let r = lerp(34, 132 * tone, plate), g = lerp(29, 122 * tone, plate), b = lerp(26, 112 * tone, plate);
    const l = lich * fis * 0.4;
    r = lerp(r, 126, l); g = lerp(g, 128, l); b = lerp(b, 106, l);
    const o = (y * S + x) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    const hh = plate * 255;
    himg.data[o] = hh; himg.data[o + 1] = hh; himg.data[o + 2] = hh; himg.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  hc.putImageData(himg, 0, 0);
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  TEX.bark = { map, normal: normalFromHeight(hv, 5) };
  return TEX.bark;
}

function birchTextures() {
  if (TEX.birch) return TEX.birch;
  const S = 512, cv = makeCanvas(S, S), ctx = cv.getContext('2d', { willReadFrequently: true });
  const hv = makeCanvas(S, S), hc = hv.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(2718);
  ctx.fillStyle = '#ece9e2'; ctx.fillRect(0, 0, S, S);
  hc.fillStyle = '#b0b0b0'; hc.fillRect(0, 0, S, S);
  const wrap = (fn) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy); };
  for (let i = 0; i < 60; i++) {
    const y = rng() * S, h = rr(rng, 4, 26), c = rng() < 0.5 ? [205, 200, 192] : [232, 222, 210];
    ctx.fillStyle = css(c, rr(rng, 0.25, 0.5));
    wrap((dx, dy) => ctx.fillRect(0 + dx * 0, y + dy, S, h));
  }
  for (let i = 0; i < 90; i++) {
    const x = rng() * S, y = rng() * S, w = rr(rng, 20, 90), h = rr(rng, 6, 20);
    ctx.fillStyle = css([216, 206, 196], rr(rng, 0.2, 0.45));
    wrap((dx, dy) => { ctx.beginPath(); ctx.ellipse(x + dx, y + dy, w / 2, h / 2, 0, 0, TAU); ctx.fill(); });
  }
  for (let i = 0; i < 220; i++) {
    const x = rng() * S, y = rng() * S, w = rr(rng, 8, 46), h = rr(rng, 1.4, 3.6), c = rr(rng, 0.7, 1.2);
    wrap((dx, dy) => {
      ctx.fillStyle = css(mulc([62, 52, 48], c), rr(rng, 0.7, 0.95));
      ctx.beginPath(); ctx.ellipse(x + dx, y + dy, w / 2, h / 2, rr(rng, -0.04, 0.04), 0, TAU); ctx.fill();
      hc.fillStyle = '#303030'; hc.beginPath(); hc.ellipse(x + dx, y + dy, w / 2, h / 2, 0, 0, TAU); hc.fill();
    });
  }
  for (let i = 0; i < 16; i++) {
    const x = rng() * S, y = rng() * S, w = rr(rng, 40, 110), h = rr(rng, 10, 36);
    const pts = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * TAU, rad = rr(rng, 0.55, 1.0);
      pts.push([Math.cos(a) * w / 2 * rad, Math.sin(a) * h / 2 * rad * (Math.sin(a) > 0 ? 1.2 : 0.7)]);
    }
    wrap((dx, dy) => {
      for (const [c, s] of [[ctx, 'rgba(34,30,28,0.92)'], [hc, '#181818']]) {
        c.fillStyle = s; c.beginPath();
        pts.forEach((p, k) => (k ? c.lineTo(x + dx + p[0], y + dy + p[1]) : c.moveTo(x + dx + p[0], y + dy + p[1])));
        c.closePath(); c.fill();
      }
    });
  }
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  TEX.birch = { map, normal: normalFromHeight(hv, 4) };
  return TEX.birch;
}

/* ------------------------------------------------------------------ materials */

const MAT = {};
// Foliage: back faces keep the bent (outward) normal instead of flipping it, plus a faint transmitted-light lift.
function foliageMaterial(map, key, lift) {
  const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <alphatest_fragment>', `{
		vec3 fdx = dFdx( vViewPosition ), fdy = dFdy( vViewPosition );
		vec3 fn = normalize( cross( fdx, fdy ) );
		float facing = abs( dot( fn, normalize( vViewPosition ) ) );
		diffuseColor.a *= smoothstep( 0.2, 0.45, facing );
	}
	#include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * vec3(${lift.map((x) => x.toFixed(3)).join(',')});`)
      // leaves are dull: weaker F0 and grazing reflectance (no white sheen on sun-grazing cards)
      .replace('#include <lights_physical_fragment>', THREE.ShaderChunk.lights_physical_fragment
        .replace('vec3( 0.04 ), diffuseColor.rgb', 'vec3( 0.03 ), diffuseColor.rgb').replace(/material\.specularF90 = 1\.0;/g, 'material.specularF90 = 0.3;'))
      // cheap translucency: leaves on the crown rim glow yellow-green when the camera looks towards the sun
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	#if NUM_DIR_LIGHTS > 0
	{
		vec3 Ld = directionalLights[ 0 ].direction;
		float back = pow( saturate( dot( - geometryViewDir, Ld ) ), 3.0 );
		float rim = smoothstep( -0.35, 0.25, dot( normal, Ld ) );
		reflectedLight.directDiffuse += diffuseColor.rgb * vec3( 1.05, 1.1, 0.6 ) * directionalLights[ 0 ].color * ( back * rim * 0.5 );
	}
	#endif`);
  };
  m.customProgramCacheKey = () => 'foliage-' + key;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide });
  return { mat: m, depth };
}
function treeLeafMat() { return MAT.treeLeaf || (MAT.treeLeaf = foliageMaterial(treeAtlas(), 'tree', [0.035, 0.05, 0.015])); }
function shrubLeafMat() { return MAT.shrubLeaf || (MAT.shrubLeaf = foliageMaterial(shrubAtlas(), 'shrub', [0.03, 0.04, 0.015])); }
function barkMat() {
  if (MAT.bark) return MAT.bark;
  const t = barkTextures();
  return (MAT.bark = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(1.1, 1.1), vertexColors: true, roughness: 0.93, metalness: 0 }));
}
function birchMat() {
  if (MAT.birch) return MAT.birch;
  const t = birchTextures();
  return (MAT.birch = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, roughness: 0.72, metalness: 0 }));
}
function coreMat() {
  return MAT.core || (MAT.core = new THREE.MeshStandardMaterial({ map: coreTexture(), vertexColors: true, roughness: 0.88, metalness: 0 }));
}

// UV rectangle of atlas cell c in a 2x2 atlas (DataTexture: canvas top row is v = 0). [u0, vBottom, u1, vTop]
function cellUV(c) {
  const cx = c % 2, cy = Math.floor(c / 2), e = 0.002;
  return [cx * 0.5 + e, (cy + 1) * 0.5 - e, (cx + 1) * 0.5 - e, cy * 0.5 + e];
}

/* ------------------------------------------------------------------ geometry emitters */

const _s = new V3(), _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _n = new V3();
// Leaf card centred at c; up/n unit and orthogonal; sn = shading normal; bend > 0 folds the card into a V.
function emitCard(G, c, up, n, w, h, sn, col, uv, bend, flip, bottomK, spread) {
  const side = _s.crossVectors(up, n).normalize();
  const u0 = flip ? uv[2] : uv[0], u1 = flip ? uv[0] : uv[2];
  const cb = [col[0] * bottomK, col[1] * bottomK, col[2] * bottomK];
  const corner = (sx, sy, lift) => {
    const p = new V3().copy(c).addScaledVector(side, sx * w * 0.5).addScaledVector(up, sy * h * 0.5).addScaledVector(n, lift);
    const nn = _n.copy(sn).addScaledVector(side, sx * spread).addScaledVector(up, sy * spread * 0.6).normalize();
    return [p, nn.clone()];
  };
  if (!bend) {
    const q = [corner(-1, -1, 0), corner(1, -1, 0), corner(1, 1, 0), corner(-1, 1, 0)];
    const i0 = G.v(q[0][0], q[0][1], u0, uv[1], cb);
    const i1 = G.v(q[1][0], q[1][1], u1, uv[1], cb);
    const i2 = G.v(q[2][0], q[2][1], u1, uv[3], col);
    const i3 = G.v(q[3][0], q[3][1], u0, uv[3], col);
    G.tri(i0, i1, i2); G.tri(i0, i2, i3);
  } else {
    const um = (u0 + u1) / 2, lift = bend * w;
    const q = [corner(-1, -1, 0), corner(0, -1, lift), corner(1, -1, 0), corner(-1, 1, 0), corner(0, 1, lift), corner(1, 1, 0)];
    const i0 = G.v(q[0][0], q[0][1], u0, uv[1], cb);
    const i1 = G.v(q[1][0], q[1][1], um, uv[1], cb);
    const i2 = G.v(q[2][0], q[2][1], u1, uv[1], cb);
    const i3 = G.v(q[3][0], q[3][1], u0, uv[3], col);
    const i4 = G.v(q[4][0], q[4][1], um, uv[3], col);
    const i5 = G.v(q[5][0], q[5][1], u1, uv[3], col);
    G.tri(i0, i1, i4); G.tri(i0, i4, i3); G.tri(i1, i2, i5); G.tri(i1, i5, i4);
  }
}

// Tapered tube along pts (parallel-transport frames). radii per point, colours per point.
function emitTube(G, pts, radii, cols, radial, uRep, flare) {
  const n = pts.length;
  const T = [];
  for (let i = 0; i < n; i++) T.push(new V3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize());
  const N = anyPerp(T[0]);
  const B = new V3();
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      _a.crossVectors(T[i - 1], T[i]);
      const s = _a.length();
      if (s > 1e-6) N.applyAxisAngle(_a.multiplyScalar(1 / s), Math.asin(Math.min(1, s)));
      N.addScaledVector(T[i], -N.dot(T[i])).normalize();
      const rAvg = Math.max(0.006, (radii[i] + radii[i - 1]) * 0.5);
      v += pts[i].distanceTo(pts[i - 1]) * uRep / (TAU * rAvg);
    }
    B.crossVectors(T[i], N);
    const base = G.count;
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU, cs = Math.cos(th), sn = Math.sin(th);
      _d.set(N.x * cs + B.x * sn, N.y * cs + B.y * sn, N.z * cs + B.z * sn);
      let r = radii[i];
      if (flare) r *= flare(pts[i].y, th);
      _c.copy(pts[i]).addScaledVector(_d, r);
      G.v(_c, _d, (j / radial) * uRep, v, cols[i]);
    }
    if (i > 0) {
      const p0 = base - (radial + 1);
      for (let j = 0; j < radial; j++) {
        const a = p0 + j, b = a + 1, c = base + j, d = c + 1;
        G.tri(a, b, c); G.tri(b, d, c);
      }
    }
  }
}

/* ------------------------------------------------------------------ tree species */

const KINDS = {
  oak: {
    leader: false, split: 0.36, trunkR: 0.034, crownBase: 0.22, width: 1.0, peak: 0.45, dome: 0.4, lobes: 0.26, lean: 0.07,
    nScaf: [5, 7], scafAng: [28, 62], scafR: [0.5, 0.7], scafLen: [0.72, 0.95],
    d2: 2.4, a2: [40, 72], l2: 0.62, d3: 3.4, a3: [35, 70], l3: [0.4, 0.85],
    crook: [0.04, 0.17, 0.26, 0.3], up: [0, 0.03, 0.01, 0.02], out: 0.5,
    leaf: 0.78, cards: 2300, cardsStreet: 1500, holes: -0.22, hollow: 0.42, skip: 0.14,
    tint: [0.9, 0.86, 0.76], tintVar: 0.1, bark: [0.84, 0.8, 0.76], twig: [0.56, 0.5, 0.44],
  },
  linden: {
    leader: true, trunkR: 0.028, crownBase: 0.24, width: 0.7, peak: 0.36, dome: 0.55, lobes: 0.18, lean: 0.04,
    nScaf: [15, 20], scafAngLow: [62, 78], scafAngHigh: [32, 46], scafR: [0.32, 0.48], scafLen: [0.72, 0.92],
    d2: 2.6, a2: [38, 62], l2: 0.6, d3: 3.4, a3: [35, 65], l3: [0.35, 0.75],
    crook: [0.015, 0.1, 0.2, 0.26], up: [0, 0.05, 0.03, 0.02], out: 0.4,
    leaf: 0.72, cards: 2300, cardsStreet: 1600, holes: -0.2, hollow: 0.45, skip: 0.14,
    tint: [0.92, 0.88, 0.78], tintVar: 0.08, bark: [0.9, 0.88, 0.85], twig: [0.58, 0.5, 0.43],
  },
  birch: {
    leader: true, trunkR: 0.021, crownBase: 0.3, width: 0.56, peak: 0.42, dome: 0.62, lobes: 0.32, lean: 0.08, birch: true,
    nScaf: [12, 16], scafAngLow: [50, 64], scafAngHigh: [30, 42], scafR: [0.3, 0.45], scafLen: [0.7, 0.95],
    d2: 2.8, a2: [32, 58], l2: 0.62, d3: 3.8, a3: [25, 55], l3: [0.45, 0.95],
    crook: [0.02, 0.12, 0.16, 0.18], up: [0, 0.03, -0.06, -0.14], out: 0.35,
    leaf: 0.58, cards: 1900, cardsStreet: 1300, holes: -0.12, hollow: 0.36, skip: 0.16,
    tint: [0.95, 0.93, 0.8], tintVar: 0.08, bark: [1, 1, 1], twig: [0.36, 0.3, 0.27],
  },
  maple: {
    leader: false, split: 0.34, trunkR: 0.03, crownBase: 0.22, width: 0.9, peak: 0.47, dome: 0.45, lobes: 0.2, lean: 0.05,
    nScaf: [5, 7], scafAng: [22, 55], scafR: [0.5, 0.7], scafLen: [0.75, 0.95],
    d2: 2.6, a2: [38, 65], l2: 0.6, d3: 3.4, a3: [35, 65], l3: [0.38, 0.8],
    crook: [0.03, 0.12, 0.2, 0.26], up: [0, 0.04, 0.02, 0.02], out: 0.45,
    leaf: 0.76, cards: 2200, cardsStreet: 1500, holes: -0.2, hollow: 0.44, skip: 0.15,
    tint: [0.92, 0.87, 0.76], tintVar: 0.09, bark: [0.92, 0.9, 0.87], twig: [0.55, 0.48, 0.42],
  },
};

function makeEnvelope(sp, H, rng, seed) {
  const base = H * sp.crownBase * rr(rng, 0.88, 1.12);
  const top = H;
  const Rmax = H * sp.width * 0.5 * rr(rng, 0.86, 1.12);
  const la = rr(rng, 0.2, 1) * sp.lean, laz = rng() * TAU;
  const lean = { x: Math.cos(laz) * la, z: Math.sin(laz) * la };
  const peak = sp.peak * rr(rng, 0.9, 1.1);
  const k = Math.log(0.5) / Math.log(peak);
  const ns = seed * 13 + 5;
  const lobe = sp.lobes * rr(rng, 0.8, 1.2);
  const ro = rng() * 10;
  function radiusAt(eta, az) {
    const prof = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(eta, k))), sp.dome);
    const cx = Math.cos(az), sz = Math.sin(az);
    const n = vnoise(cx * 1.3 + ro, eta * 2.2, sz * 1.3 + ro, ns) * 0.75 + vnoise(cx * 2.8 + ro, eta * 4.6, sz * 2.8 + ro, ns + 1) * 0.35;
    return Rmax * prof * (1 + lobe * n);
  }
  function inside(p) {
    const eta = (p.y - base) / (top - base);
    if (eta <= 0 || eta >= 1) return false;
    const dx = p.x - lean.x * p.y, dz = p.z - lean.z * p.y;
    return Math.hypot(dx, dz) <= radiusAt(eta, Math.atan2(dz, dx));
  }
  const cy = base + (top - base) * peak;
  const centre = new V3(lean.x * cy, cy, lean.z * cy);
  const Ry = (top - base) * 0.5;
  const tmp = new V3();
  // distance along d from p to where the ray leaves the crown (entering it first if p starts below/outside)
  function exitDist(p, d, maxT) {
    const steps = 16, st = maxT / steps;
    let i0 = 1;
    if (!inside(p)) {
      let found = false;
      for (let i = 1; i <= steps * 2 && !found; i++) if (inside(tmp.copy(p).addScaledVector(d, i * st * 0.5))) { found = true; i0 = Math.ceil(i * 0.5) + 1; }
      if (!found) return 0;
    }
    for (let i = i0; i <= steps; i++) {
      if (!inside(tmp.copy(p).addScaledVector(d, i * st))) {
        let lo = (i - 1) * st, hi = i * st;
        for (let k2 = 0; k2 < 6; k2++) { const m = (lo + hi) / 2; if (inside(tmp.copy(p).addScaledVector(d, m))) lo = m; else hi = m; }
        return lo;
      }
    }
    return maxT;
  }
  const dv = new V3();
  function depth(p) {
    dv.subVectors(p, centre);
    const L = dv.length();
    if (L < 1e-4) return 0;
    dv.multiplyScalar(1 / L);
    const e = exitDist(centre, dv, H * 1.5);
    return e > 1e-3 ? L / e : 1.2;
  }
  function normal(p, out = new V3()) {
    out.set((p.x - centre.x) / (Rmax * Rmax), (p.y - centre.y) / (Ry * Ry), (p.z - centre.z) / (Rmax * Rmax));
    if (out.lengthSq() < 1e-10) out.set(0, 1, 0);
    return out.normalize();
  }
  return { base, top, Rmax, Ry, lean, centre, inside, exitDist, depth, normal };
}

function pointAt(br, t) {
  const n = br.pts.length, f = clamp01(t) * (n - 1), i = Math.min(n - 2, Math.floor(f)), u = f - i;
  return { p: new V3().lerpVectors(br.pts[i], br.pts[i + 1], u), d: new V3().subVectors(br.pts[i + 1], br.pts[i]).normalize(), r: lerp(br.r[i], br.r[i + 1], u) };
}

function growPath(rng, env, start, dir, len, nSeg, crook, upT, steer) {
  const pts = [start.clone()];
  const d = dir.clone(), p = start.clone(), step = len / nSeg, toC = new V3();
  for (let i = 0; i < nSeg; i++) {
    d.x += rr(rng, -crook, crook); d.y += rr(rng, -crook, crook) * 0.6; d.z += rr(rng, -crook, crook);
    d.y += upT;
    if (steer && i > 0 && !env.inside(p)) { toC.subVectors(env.centre, p).normalize(); d.addScaledVector(toC, 0.25); }
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
  }
  return pts;
}

function childDir(rng, parentD, az, elev, pos, sp, level, out = new V3()) {
  const N = anyPerp(parentD), B = new V3().crossVectors(parentD, N);
  const se = Math.sin(elev), ce = Math.cos(elev);
  out.copy(parentD).multiplyScalar(ce).addScaledVector(N, se * Math.cos(az)).addScaledVector(B, se * Math.sin(az));
  const radial = new V3(pos.x, 0, pos.z);
  if (radial.lengthSq() > 1e-6) {
    radial.normalize();
    const dr = out.x * radial.x + out.z * radial.z;
    if (dr < 0 && level >= 2) out.addScaledVector(radial, -1.6 * dr);
    out.addScaledVector(radial, sp.out * 0.4);
  }
  out.y += sp.up[level] * 2;
  return out.normalize();
}

function buildTreeGeometry(seed, H, kind, hero) {
  const sp = KINDS[kind];
  const rng = mulberry32(seed * 7919 + (kind.charCodeAt(0) << 8) + 17);
  const env = makeEnvelope(sp, H, rng, seed);
  const S = H / 8;
  const branches = [];
  const leafSites = [];
  const radial = hero ? [12, 7, 4, 3] : [8, 5, 3, 3];
  const segs = hero ? [10, 7, 4, 2] : [6, 4, 3, 2];
  const minR = hero ? 0.006 : 0.012;
  const tint = sp.tint.map((x) => x * rr(rng, 1 - sp.tintVar, 1 + sp.tintVar * 0.5));
  const hue = rr(rng, -1, 1) * sp.tintVar;
  tint[0] *= 1 + hue; tint[2] *= 1 - hue;

  // trunk
  const trunkLen = sp.leader ? H * 0.97 : H * sp.split * rr(rng, 0.88, 1.1);
  const tDir = new V3(env.lean.x, 1, env.lean.z).normalize();
  const tPts = [new V3(0, -0.15, 0)];
  {
    const d = tDir.clone(), p = tPts[0].clone();
    for (let i = 1; i <= segs[0]; i++) {
      const t = Math.pow(i / segs[0], 1.25);
      d.x += rr(rng, -sp.crook[0], sp.crook[0]); d.z += rr(rng, -sp.crook[0], sp.crook[0]);
      d.lerp(tDir, 0.25).normalize();
      const target = new V3().copy(tPts[0]).addScaledVector(d, 0);
      p.copy(tPts[i - 1]).addScaledVector(d, trunkLen * (t - Math.pow((i - 1) / segs[0], 1.25)));
      tPts.push(p.clone());
      void target;
    }
  }
  const r0 = sp.trunkR * H * rr(rng, 0.88, 1.12);
  const tipF = sp.leader ? 0.07 : 0.6;
  const trunk = { level: 0, pts: tPts, r: tPts.map((p, i) => r0 * (1 - (1 - tipF) * Math.pow(i / (tPts.length - 1), sp.leader ? 0.85 : 1.2))), len: trunkLen };
  branches.push(trunk);

  const addBranch = (level, parent, t, az, elev, lenF, rF, worldDir) => {
    const at = pointAt(parent, t);
    const dir = worldDir ? worldDir.clone() : childDir(rng, at.d, az, elev, at.p, sp, level);
    const start = at.p.clone().addScaledVector(dir, -at.r * 0.4);
    let maxL = env.exitDist(at.p, dir, H * 1.2);
    let len;
    if (level === 1) len = Math.max(maxL, 0.25 * H * S * 0) * rr(rng, sp.scafLen[0], sp.scafLen[1]);
    else if (level === 2) len = Math.min(parent.len * sp.l2 * (1 - t * 0.55) + 0.25 * S, maxL * rr(rng, 0.65, 0.95) + 0.15 * S);
    else len = Math.min(rr(rng, sp.l3[0], sp.l3[1]) * Math.sqrt(S), maxL * 1.05 + 0.2 * S);
    if (level === 1 && maxL < 0.3 * S) return null;
    if (len < 0.2 * S) return null;
    const n = segs[level];
    const pts = growPath(rng, env, start, dir, len, n, sp.crook[level], sp.up[level], level >= 2);
    const rs = Math.max(minR, at.r * rF);
    const rt = Math.max(minR * 0.6, rs * (level === 3 ? 0.35 : 0.22));
    const br = { level, pts, r: pts.map((p, i) => lerp(rs, rt, Math.pow(i / n, 0.9))), len };
    branches.push(br);
    return br;
  };

  // scaffolds
  const scaf = [];
  const nS = ri(rng, sp.nScaf[0], sp.nScaf[1]);
  const az0 = rng() * TAU;
  if (sp.leader) {
    const tb = clamp01((env.base * 0.92) / trunkLen);
    for (let k = 0; k < nS; k++) {
      const f = (k + rr(rng, 0, 0.7)) / nS;
      const t = lerp(tb, 0.93, f);
      const ang = THREE.MathUtils.degToRad(lerp(rr(rng, sp.scafAngLow[0], sp.scafAngLow[1]), rr(rng, sp.scafAngHigh[0], sp.scafAngHigh[1]), f));
      const az = az0 + k * 2.39996 + rr(rng, -0.35, 0.35);
      const dir = new V3(Math.sin(ang) * Math.cos(az) + env.lean.x, Math.cos(ang), Math.sin(ang) * Math.sin(az) + env.lean.z).normalize();
      const b = addBranch(1, trunk, t, 0, 0, 1, rr(rng, sp.scafR[0], sp.scafR[1]), dir);
      if (b) scaf.push(b);
    }
  } else {
    for (let k = 0; k < nS; k++) {
      const t = rr(rng, 0.72, 1.0);
      const ang = THREE.MathUtils.degToRad(k === 0 ? rr(rng, 6, 16) : rr(rng, sp.scafAng[0], sp.scafAng[1]));
      const az = az0 + (k * TAU) / nS + rr(rng, -0.4, 0.4);
      const dir = new V3(Math.sin(ang) * Math.cos(az) + env.lean.x, Math.cos(ang), Math.sin(ang) * Math.sin(az) + env.lean.z).normalize();
      const b = addBranch(1, trunk, t, 0, 0, 1, rr(rng, sp.scafR[0], sp.scafR[1]), dir);
      if (b) scaf.push(b);
    }
    // a couple of low limbs below the split for a more natural silhouette
    for (let k = 0; k < 2; k++) {
      const t = rr(rng, 0.55, 0.75);
      const ang = THREE.MathUtils.degToRad(rr(rng, 50, 70));
      const az = az0 + rng() * TAU;
      const dir = new V3(Math.sin(ang) * Math.cos(az), Math.cos(ang), Math.sin(ang) * Math.sin(az)).normalize();
      const b = addBranch(1, trunk, t, 0, 0, 1, rr(rng, 0.3, 0.42), dir);
      if (b) scaf.push(b);
    }
  }
  // secondary limbs and twigs; every secondary limb carries one foliage clump
  const mkClump = (br, t) => {
    const c = pointAt(br, t).p;
    const o = env.normal(c);
    c.addScaledVector(o, -0.15 * S);
    return { c, skip: rng() < sp.skip, v: rr(rng, 0.9, 1.08), h: rr(rng, -1, 1) * 0.07 };
  };
  const sec = [];
  for (const P of scaf) {
    const n2 = Math.max(2, Math.round((P.len * sp.d2 * (hero ? 1 : 0.85)) / Math.sqrt(S)));
    let az = rng() * TAU;
    for (let k = 0; k < n2; k++) {
      const t = 0.16 + 0.8 * (k + rr(rng, 0.2, 0.8)) / n2;
      az += 2.39996 + rr(rng, -0.3, 0.3);
      const b = addBranch(2, P, t, az, THREE.MathUtils.degToRad(rr(rng, sp.a2[0], sp.a2[1])), 1, rr(rng, 0.45, 0.65));
      if (b) sec.push(b);
    }
    // scaffold tip foliage
    leafSites.push({ br: P, t0: 0.6, clump: mkClump(P, 0.85) });
  }
  if (hero) {
    for (const P of sec) {
      const cl = mkClump(P, 0.72);
      const n3 = Math.max(1, Math.round((P.len * sp.d3) / Math.sqrt(S)));
      let az = rng() * TAU;
      for (let k = 0; k < n3; k++) {
        const t = 0.15 + 0.85 * (k + rr(rng, 0.2, 0.8)) / n3;
        az += 2.39996 + rr(rng, -0.3, 0.3);
        const b = addBranch(3, P, t, az, THREE.MathUtils.degToRad(rr(rng, sp.a3[0], sp.a3[1])), 1, rr(rng, 0.5, 0.7));
        if (b) leafSites.push({ br: b, t0: 0.15, clump: cl });
      }
      leafSites.push({ br: P, t0: 0.55, clump: cl });
    }
  } else {
    for (const P of sec) leafSites.push({ br: P, t0: 0.25, clump: mkClump(P, 0.7) });
  }

  const isB = !!sp.birch;

  // ---- foliage plan (cards are placed before the bark so twigs that ended up bare can be dropped)
  const budget = hero ? 25000 : 10000;
  const bend = hero ? 0.1 : 0;
  const tpc = bend ? 4 : 2;
  const wanted = Math.round((hero ? sp.cards : sp.cardsStreet) * Math.pow(S, 0.8));
  const size0 = sp.leaf * Math.pow(S, 0.6) * (hero ? 1 : 1.45);
  const holeSeed = seed * 31 + 9, holeF = 0.85 / S;
  const up = new V3(), nrm = new V3(), out = new V3(), cpos = new V3(), sn = new V3(), rv = new V3(), cl = new V3();
  const cw = [];
  let tot = 0;
  for (const s of leafSites) { tot += s.br.len * (1 - s.t0); cw.push(tot); }
  const cards = [];
  let guard = 0;
  while (cards.length < wanted && guard++ < wanted * 8) {
    const x = rng() * tot;
    let lo = 0, hi = cw.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cw[m] < x) lo = m + 1; else hi = m; }
    const site = leafSites[lo];
    if (site.clump.skip && rng() < 0.9) continue;
    const at = pointAt(site.br, rr(rng, site.t0, 1));
    const size = size0 * rr(rng, 0.75, 1.2);
    randUnit(rng, rv);
    cpos.copy(at.p).addScaledVector(rv, size * 0.3);
    env.normal(cpos, out);
    up.copy(at.d).multiplyScalar(0.7).addScaledVector(out, 0.5).addScaledVector(randUnit(rng, rv), 0.6);
    up.y += isB ? -0.35 : 0.15;
    up.normalize();
    cpos.addScaledVector(up, size * 0.38);
    const rho = env.depth(cpos);
    if (rng() > smoothstep(sp.hollow, sp.hollow + 0.36, rho)) continue;
    const hole = vnoise(cpos.x * holeF + 3.1, cpos.y * holeF * 1.2, cpos.z * holeF + 7.7, holeSeed);
    if (hole < sp.holes && rng() < 0.9) continue;
    // card normal: perpendicular to up, roughly facing out, rotated randomly about up
    nrm.copy(out).addScaledVector(up, -out.dot(up));
    if (nrm.lengthSq() < 1e-4) anyPerp(up, nrm); else nrm.normalize();
    nrm.applyAxisAngle(up, rr(rng, -1.15, 1.15));
    // shading normal: blend of crown-outward and clump-outward directions, so every clump reads as a soft lump
    cl.subVectors(cpos, site.clump.c);
    if (cl.lengthSq() < 1e-6) cl.copy(out); else cl.normalize();
    sn.copy(out).multiplyScalar(0.55).addScaledVector(cl, 0.45).addScaledVector(nrm, 0.1);
    sn.y += 0.1;
    sn.normalize();
    // colour: species tint x per-card variation x crown-depth and clump-side AO
    const eta = clamp01((cpos.y - env.base) / (env.top - env.base));
    let ao = 0.36 + 0.64 * smoothstep(0.35, 1.0, rho);
    ao *= 0.76 + 0.24 * eta;
    ao *= 0.84 + 0.16 * clamp01(0.5 + out.y * 0.7);
    ao *= 0.66 + 0.34 * clamp01(0.5 + 0.5 * cl.dot(out));
    const v = rr(rng, 0.86, 1.1) * site.clump.v, hv = rr(rng, -1, 1) * 0.05 + site.clump.h;
    const col = [tint[0] * v * ao * (1 + hv), tint[1] * v * ao, tint[2] * v * ao * (1 - hv)];
    cards.push({ p: cpos.clone(), up: up.clone(), n: nrm.clone(), size, sn: sn.clone(), col, flip: rng() < 0.5 });
    site.br.used = true;
  }

  // ---- bark mesh (twigs without foliage are skipped)
  const G = new Geo();
  const flareSeed = rng() * TAU, nRoots = ri(rng, 4, 6);
  const flare = (y, th) => {
    const yy = Math.max(0, y);
    return 1 + 0.5 * Math.exp(-yy / (0.32 * S)) + 0.35 * Math.exp(-yy / (0.22 * S)) * Math.pow(Math.max(0, Math.cos(nRoots * th + flareSeed)), 2);
  };
  for (const br of branches) {
    const L = br.level;
    if (L === 3 && !br.used) continue;
    const cols = br.pts.map((p) => {
      let c = L === 0 ? sp.bark : L === 1 ? mixc(sp.bark, sp.twig, isB ? 0.15 : 0.25) : L === 2 ? mixc(sp.bark, sp.twig, isB ? 0.85 : 0.6) : sp.twig;
      c = c.slice();
      if (isB && L <= 1) {
        const base = smoothstep(1.3 * S, 0.0, p.y);
        c = mixc(c, [0.3, 0.27, 0.25], base * 0.85);
      }
      let ao = 1;
      if (p.y > env.base * 0.9) ao = 0.55 + 0.45 * smoothstep(0.2, 1.0, env.depth(p));
      ao *= 0.85 + 0.15 * smoothstep(0, 0.6, p.y);
      return [c[0] * ao, c[1] * ao, c[2] * ao];
    });
    const uRep = L === 0 ? (isB ? 1 : 3) : L === 1 ? (isB ? 1 : 2) : 1;
    emitTube(G, br.pts, br.r, cols, radial[L], uRep, L === 0 ? flare : null);
  }
  const barkTris = G.tris;

  // ---- foliage mesh, trimmed to the triangle budget
  const nCards = Math.min(cards.length, Math.floor((budget - 100 - barkTris) / tpc));
  const F = new Geo();
  const uv = cellUV(TREE_CELL[kind]);
  for (let i = 0; i < nCards; i++) {
    const c = cards[i];
    emitCard(F, c.p, c.up, c.n, c.size, c.size, c.sn, c.col, uv, bend, c.flip, 0.8, 0.28);
  }
  const made = nCards;
  return { bark: G.build(), leaves: F.build(), barkTris, leafTris: F.tris, cards: made, isBirch: isB };
}

/* ------------------------------------------------------------------ exports */

const GEO_CACHE = new Map();

export function buildTree({ seed = 1, height = 8, kind = 'oak', detail = 'hero' } = {}) {
  if (!KINDS[kind]) kind = 'oak';
  const hero = detail !== 'street';
  const key = `tree|${kind}|${seed}|${height}|${hero ? 'h' : 's'}`;
  let g = GEO_CACHE.get(key);
  if (!g) { g = buildTreeGeometry(seed, height, kind, hero); GEO_CACHE.set(key, g); }
  const group = new THREE.Group();
  group.name = `tree-${kind}`;
  const bark = new THREE.Mesh(g.bark, g.isBirch ? birchMat() : barkMat());
  bark.castShadow = true; bark.receiveShadow = true; bark.name = 'bark';
  const lm = treeLeafMat();
  const leaves = new THREE.Mesh(g.leaves, lm.mat);
  leaves.customDepthMaterial = lm.depth;
  leaves.castShadow = true; leaves.receiveShadow = true; leaves.name = 'leaves';
  leaves.userData.noAO = true;
  group.add(bark, leaves);
  group.userData = { kind, height, detail: hero ? 'hero' : 'street', triangles: g.barkTris + g.leafTris, drawCalls: 2 };
  return group;
}

/* ---------- shrubs */

function bumpyEllipsoidCore(rng, R, h, seed, rad = 1, col = [0.5, 0.56, 0.46]) {
  const geo = new THREE.SphereGeometry(1, 16, 10);
  const pos = geo.attributes.position, uvA = geo.attributes.uv;
  const colors = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 1 + 0.1 * vnoise(x * 1.7 + 4, y * 1.7, z * 1.7 + 4, seed);
    const yy = Math.max(0.01, h * 0.5 * (1 + y * (y > 0 ? rad : 1)));
    pos.setXYZ(i, x * R * rad * n, yy, z * R * rad * n);
    uvA.setXY(i, uvA.getX(i) * Math.max(2, Math.round(R * 7)), uvA.getY(i) * Math.max(1, Math.round(h * 2.5)));
    const ao = 0.55 + 0.45 * clamp01(y * 0.5 + 0.55);
    colors.push(col[0] * ao, col[1] * ao, col[2] * ao);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function ellipsoidArea(a, c) {
  const p = 1.6075, ap = Math.pow(a, p), cp = Math.pow(c, p);
  return 4 * Math.PI * Math.pow((ap * ap + 2 * ap * cp) / 3, 1 / p);
}

function shellCards(F, rng, n, centre, radii, lobeSeed, lobeAmp, uv, sizeR, tintF, opts = {}) {
  const d = new V3(), p = new V3(), up = new V3(), nrm = new V3(), sn = new V3(), rv = new V3();
  for (let i = 0; i < n; i++) {
    randUnit(rng, d);
    if (d.y < (opts.minY ?? -0.35)) d.y = -d.y * 0.5;
    d.normalize();
    const lob = 1 + lobeAmp * vnoise(d.x * 2.1 + 9, d.y * 2.1, d.z * 2.1 + 9, lobeSeed);
    const depthF = rr(rng, opts.inner ?? 0.84, 1.02);
    p.set(centre.x + d.x * radii.x * lob * depthF, centre.y + d.y * radii.y * lob * depthF, centre.z + d.z * radii.z * lob * depthF);
    if (p.y < 0.04) p.y = 0.04 + rng() * 0.05;
    const size = rr(rng, sizeR[0], sizeR[1]);
    const out = new V3((p.x - centre.x) / (radii.x * radii.x), (p.y - centre.y) / (radii.y * radii.y), (p.z - centre.z) / (radii.z * radii.z)).normalize();
    // card roughly tangent to the surface with a leafy tilt
    nrm.copy(out).addScaledVector(randUnit(rng, rv), opts.tilt ?? 0.75).normalize();
    up.copy(randUnit(rng, rv)).addScaledVector(nrm, -rv.dot(nrm));
    if (up.lengthSq() < 1e-4) anyPerp(nrm, up);
    up.normalize();
    if (opts.upBias) { up.y += opts.upBias; up.addScaledVector(nrm, -up.dot(nrm)).normalize(); }
    sn.copy(out); sn.y += 0.1; sn.normalize();
    const ao = (0.6 + 0.4 * depthF) * (0.8 + 0.2 * clamp01(out.y * 0.5 + 0.6));
    const v = rr(rng, 0.85, 1.12);
    const col = [tintF[0] * ao * v, tintF[1] * ao * v, tintF[2] * ao * v];
    emitCard(F, p, up, nrm, size, size, sn, col, uv, 0, rng() < 0.5, opts.bottomK ?? 0.85, 0.2);
  }
}

export function buildShrub({ seed = 1, radius = 0.8, height = 1.0, kind = 'boxwood' } = {}) {
  const key = `shrub|${kind}|${seed}|${radius}|${height}`;
  let g = GEO_CACHE.get(key);
  if (!g) {
    const rng = mulberry32(seed * 104729 + kind.length * 31 + 5);
    const F = new Geo();
    let core = null;
    const R = radius, h = height;
    if (kind === 'grass') {
      const uv = cellUV(SHRUB_CELL.grass);
      const n = Math.round(Math.min(170, 105 * Math.pow(R / 0.6, 1.1) * Math.sqrt(h)));
      const p = new V3(), dir = new V3(), side = new V3(), nr = new V3();
      for (let i = 0; i < n; i++) {
        const az = rng() * TAU, br = R * 0.3 * Math.sqrt(rng());
        const lean = rr(rng, 0.15, 1.0) * (0.5 + 0.5 * br / (R * 0.3));
        const reach = R * rr(rng, 0.55, 1.05) * lean;
        const hh = (h * rr(rng, 0.7, 1.02)) / (1 - 0.42 * lean);
        const w = rr(rng, 0.14, 0.22) * Math.sqrt(R / 0.8 * h);
        dir.set(Math.cos(az), 0, Math.sin(az));
        side.set(-dir.z, 0, dir.x).applyAxisAngle(dir, rr(rng, -0.4, 0.4));
        const bx = Math.cos(az) * br, bz = Math.sin(az) * br;
        const steps = 4;
        const tint = mulc([1, 1, 1], rr(rng, 0.85, 1.1));
        let prev = -1;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const horiz = reach * Math.pow(t, 1.5), vert = hh * (t - 0.42 * lean * t * t);
          p.set(bx + dir.x * horiz, vert, bz + dir.z * horiz);
          nr.set(dir.x * 0.5, 0.85, dir.z * 0.5).normalize();
          const c = [tint[0] * (0.55 + 0.45 * t), tint[1] * (0.55 + 0.45 * t), tint[2] * (0.55 + 0.45 * t)];
          const wt = w * (1 - 0.3 * t);
          const vv = lerp(uv[1], uv[3], t);
          const a = F.v(new V3().copy(p).addScaledVector(side, -wt / 2), nr, uv[0], vv, c);
          F.v(new V3().copy(p).addScaledVector(side, wt / 2), nr, uv[2], vv, c);
          if (prev >= 0) { F.tri(prev, prev + 1, a + 1); F.tri(prev, a + 1, a); }
          prev = a;
        }
      }
    } else if (kind === 'hydrangea') {
      const centre = new V3(0, h * 0.5, 0), radii = new V3(R, h * 0.5, R);
      core = bumpyEllipsoidCore(rng, R, h, seed, 0.8, [0.5, 0.58, 0.45]);
      shellCards(F, rng, Math.round(Math.min(900, 95 * ellipsoidArea(R, h * 0.5))), centre, radii, seed + 3, 0.12, cellUV(SHRUB_CELL.hydra), [0.28 * Math.sqrt(R / 0.8), 0.38 * Math.sqrt(R / 0.8)], [0.7, 0.78, 0.66], { tilt: 0.9 });
      const pal = [[1.0, 0.48, 0.68], [0.42, 0.58, 1.0], [1.05, 1.03, 1.0], [0.66, 0.5, 1.0], [0.95, 1.05, 0.82], [1.0, 0.62, 0.8]];
      const base = pal[ri(rng, 0, pal.length - 1)];
      const nHeads = Math.round(Math.min(34, Math.max(8, 16 * R * R / 0.64)));
      const uvF = cellUV(SHRUB_CELL.flower);
      const d = new V3(), hc = new V3(), up = new V3(), nrm = new V3(), sn = new V3(), rv = new V3();
      for (let i = 0; i < nHeads; i++) {
        randUnit(rng, d); d.y = Math.abs(d.y) * 0.9 + 0.15; d.normalize();
        const hr = rr(rng, 1.03, 1.12);
        hc.set(d.x * R * hr, h * 0.5 + d.y * h * 0.5 * hr, d.z * R * hr);
        const hs = rr(rng, 0.26, 0.34) * Math.sqrt(R / 0.8);
        const col = mulc(base, rr(rng, 0.85, 1.0)).map((x, k) => x * (k === 1 ? rr(rng, 0.95, 1.03) : 1));
        // a small "ball" of three crossing cards: one facing out, two tilted 60 degrees around it
        const t1 = anyPerp(d, new V3()), t2 = new V3().crossVectors(d, t1), a0 = rng() * TAU;
        for (let k = 0; k < 3; k++) {
          if (k === 0) nrm.copy(d).addScaledVector(randUnit(rng, rv), 0.15).normalize();
          else { const a = a0 + k * 2.1; nrm.copy(d).multiplyScalar(0.5).addScaledVector(t1, 0.87 * Math.cos(a)).addScaledVector(t2, 0.87 * Math.sin(a)).normalize(); }
          up.copy(randUnit(rng, rv)).addScaledVector(nrm, -rv.dot(nrm)).normalize();
          sn.copy(d).addScaledVector(nrm, 0.3).normalize();
          emitCard(F, hc.clone().addScaledVector(d, -hs * 0.12 * k), up, nrm, hs * (k ? 0.9 : 1), hs * (k ? 0.9 : 1), sn, col, uvF, 0, rng() < 0.5, 0.9, 0.45);
        }
      }
    } else { // boxwood
      const centre = new V3(0, h * 0.5, 0), radii = new V3(R, h * 0.5, R);
      core = bumpyEllipsoidCore(rng, R, h, seed, 0.9, [0.6, 0.66, 0.52]);
      const area = ellipsoidArea(R, h * 0.5);
      shellCards(F, rng, Math.round(Math.min(1300, 165 * area)), centre, radii, seed + 3, 0.06, cellUV(SHRUB_CELL.small), [0.2 * Math.sqrt(R / 0.8), 0.27 * Math.sqrt(R / 0.8)], [0.84, 0.9, 0.78], { tilt: 0.45, inner: 0.93 });
    }
    g = { leaves: F.build(), core, tris: F.tris + (core ? core.index.count / 3 : 0) };
    GEO_CACHE.set(key, g);
  }
  const group = new THREE.Group();
  group.name = `shrub-${kind}`;
  const lm = shrubLeafMat();
  const leaves = new THREE.Mesh(g.leaves, lm.mat);
  leaves.customDepthMaterial = lm.depth;
  leaves.castShadow = true; leaves.receiveShadow = true; leaves.userData.noAO = true;
  group.add(leaves);
  if (g.core) {
    const core = new THREE.Mesh(g.core, coreMat());
    core.castShadow = true; core.receiveShadow = true;
    group.add(core);
  }
  group.userData = { kind, triangles: g.tris, drawCalls: g.core ? 2 : 1 };
  return group;
}

/* ---------- clipped hedge along +X */

export function buildHedge({ length = 6, height = 1.0, depth = 0.6, seed = 1 } = {}) {
  const key = `hedge|${length}|${height}|${depth}|${seed}`;
  let g = GEO_CACHE.get(key);
  if (!g) {
    const rng = mulberry32(seed * 15485863 + 77);
    const L = length, H = height, D = depth;
    // core: slightly irregular box with world-scale UVs on the tiling leaf texture
    const inset = 0.07;
    const box = new THREE.BoxGeometry(L - inset * 2, H - inset, D - inset * 2, Math.max(2, Math.ceil(L / 0.5)), Math.max(1, Math.ceil(H / 0.4)), 2);
    box.translate(0, (H - inset) / 2, 0);
    const pos = box.attributes.position, nor = box.attributes.normal, uvA = box.attributes.uv;
    const cols = [];
    const T = 0.55;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      if (Math.abs(ny) > 0.5) uvA.setXY(i, x / T, z / T); else if (Math.abs(nz) > 0.5) uvA.setXY(i, x / T, y / T); else uvA.setXY(i, z / T, y / T);
      if (y > 0.01) {
        x += 0.03 * vnoise(x * 1.3, y * 1.3, z * 1.3, seed);
        y += 0.025 * vnoise(x * 1.3 + 5, y * 1.3, z * 1.3, seed + 1);
        z += 0.03 * vnoise(x * 1.3 + 9, y * 1.3, z * 1.3, seed + 2);
      }
      pos.setXYZ(i, x, y, z);
      const ao = 0.5 + 0.5 * smoothstep(0, H * 0.8, y);
      cols.push(0.62 * ao, 0.7 * ao, 0.55 * ao);
    }
    box.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const core = mergeGeometries([box.toNonIndexed()]);
    core.computeVertexNormals();
    // leaf cards over the clipped surfaces
    const F = new Geo();
    const uv = cellUV(SHRUB_CELL.small);
    const tint = [0.9 * rr(rng, 0.94, 1.04), 1.0, 0.82 * rr(rng, 0.9, 1.05)];
    const faces = [
      { area: L * D, n: new V3(0, 1, 0) },
      { area: L * H, n: new V3(0, 0, 1) }, { area: L * H, n: new V3(0, 0, -1) },
      { area: D * H, n: new V3(1, 0, 0) }, { area: D * H, n: new V3(-1, 0, 0) },
    ];
    const totA = faces.reduce((s, f) => s + f.area, 0);
    const nCards = Math.round(Math.min((5700 * Math.max(1, L / 6) - core.attributes.position.count / 3) / 2, totA * 80));
    const p = new V3(), up = new V3(), nrm = new V3(), sn = new V3(), rv = new V3();
    for (let i = 0; i < nCards; i++) {
      let x = rng() * totA, f = faces[0];
      for (const ff of faces) { if (x < ff.area) { f = ff; break; } x -= ff.area; }
      const n = f.n;
      if (n.y > 0.5) p.set(rr(rng, -L / 2, L / 2), H, rr(rng, -D / 2, D / 2));
      else if (Math.abs(n.z) > 0.5) p.set(rr(rng, -L / 2, L / 2), rr(rng, 0.05, H), (n.z * D) / 2);
      else p.set((n.x * L) / 2, rr(rng, 0.05, H), rr(rng, -D / 2, D / 2));
      // rounded clipped edges: blend normal near the edges
      sn.copy(n);
      const ex = smoothstep(L / 2 - 0.12, L / 2, Math.abs(p.x)), ez = smoothstep(D / 2 - 0.12, D / 2, Math.abs(p.z)), ey = smoothstep(H - 0.12, H, p.y);
      sn.x += Math.sign(p.x) * ex; sn.z += Math.sign(p.z) * ez; sn.y += ey;
      sn.normalize();
      const off = rr(rng, -0.05, 0.035) + (rng() < 0.06 ? rr(rng, 0.04, 0.1) : 0);
      p.addScaledVector(sn, off);
      // pull corner points slightly inwards so corners look clipped-round
      p.addScaledVector(n, -0.04 * (ex * ez + ex * ey + ez * ey));
      nrm.copy(sn).addScaledVector(randUnit(rng, rv), 0.85).normalize();
      up.copy(randUnit(rng, rv)).addScaledVector(nrm, -rv.dot(nrm));
      if (up.lengthSq() < 1e-4) anyPerp(nrm, up);
      up.normalize();
      const size = rr(rng, 0.2, 0.3);
      const ao = (0.72 + 0.28 * smoothstep(0, H, p.y)) * (0.86 + 0.14 * clamp01(0.5 + off * 10));
      const v = rr(rng, 0.86, 1.1);
      emitCard(F, p, up, nrm, size, size, sn, [tint[0] * ao * v, tint[1] * ao * v, tint[2] * ao * v], uv, 0, rng() < 0.5, 0.85, 0.15);
    }
    g = { leaves: F.build(), core, tris: F.tris + core.attributes.position.count / 3 };
    GEO_CACHE.set(key, g);
  }
  const group = new THREE.Group();
  group.name = 'hedge';
  const lm = shrubLeafMat();
  const leaves = new THREE.Mesh(g.leaves, lm.mat);
  leaves.customDepthMaterial = lm.depth;
  leaves.castShadow = true; leaves.receiveShadow = true; leaves.userData.noAO = true;
  const core = new THREE.Mesh(g.core, coreMat());
  core.castShadow = true; core.receiveShadow = true;
  group.add(core, leaves);
  group.userData = { triangles: g.tris, drawCalls: 2 };
  return group;
}
