// Physically crop a GLB to a ground polygon (privacy crop), optionally masking texture pixels that are
// only used by removed triangles.
// usage: node crop.mjs in.glb out.glb [--mask] [--compare] [--quality 90]
//   polygon: property boundary in OBJ/Terra coordinates (x east, y north, metres, relative to SRSOrigin);
//            converted to glTF (x, -y) on the XZ ground plane because obj2gltf was run with --inputUpAxis Z.
// Triangles are kept when their centroid is inside the polygon (2D, height ignored, so tree crowns overhanging
// the boundary are cut vertically). Unused vertices, empty primitives, unused materials/textures are removed.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(HERE, '..', 'node', 'package.json'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { prune } = require('@gltf-transform/functions');
const sharp = require('sharp');

const args = process.argv.slice(2);
const [inp, out] = args;
const MASK = args.includes('--mask');
const COMPARE = args.includes('--compare');
const qi = args.indexOf('--quality');
const QUALITY = qi >= 0 ? +args[qi + 1] : 90;
const PAD = 2.0; // px: keep texels within 2 px of a kept triangle (bilinear filtering / mip bleed)

// property boundary (Terra x east, y north); ~60% of the 30 x 50 m scan area
const POLY_XY = [[-13, -24], [12, -24], [12.5, 0], [12, 12], [-3, 13], [-13, 12]];
const POLY = POLY_XY.map(([x, y]) => [x, -y]); // glTF XZ
const polyArea = Math.abs(POLY_XY.reduce((a, [x, y], i) => { const [x2, y2] = POLY_XY[(i + 1) % POLY_XY.length]; return a + x * y2 - x2 * y; }, 0) / 2);

function inside(px, pz) {
  let c = false;
  for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
    const [xi, zi] = POLY[i], [xj, zj] = POLY[j];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}

const T = {}; let t = performance.now();
const lap = k => { const n = performance.now(); T[k] = +((n - t) / 1000).toFixed(2); t = n; };
const rssPeak = { v: 0 }; const memTimer = setInterval(() => { rssPeak.v = Math.max(rssPeak.v, process.memoryUsage().rss); }, 50);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
lap('read');

const root = doc.getRoot();
let trisIn = 0, trisOut = 0, vertsIn = 0, vertsOut = 0;
const keptByTexture = new Map(); // Texture -> array of {uv, idx}
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const posA = prim.getAttribute('POSITION');
    const pos = posA.getArray();
    const idxA = prim.getIndices();
    const idx = idxA.getArray();
    const nt = idx.length / 3;
    trisIn += nt; vertsIn += posA.getCount();
    const keepIdx = new Uint32Array(idx.length);
    let k = 0;
    for (let f = 0; f < nt; f++) {
      const a = idx[3 * f] * 3, b = idx[3 * f + 1] * 3, c = idx[3 * f + 2] * 3;
      let x = (pos[a] + pos[b] + pos[c]) / 3, y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (inside(wx, wz)) { keepIdx[k++] = idx[3 * f]; keepIdx[k++] = idx[3 * f + 1]; keepIdx[k++] = idx[3 * f + 2]; }
    }
    if (k === 0) { prim.dispose(); continue; }
    // compact vertices
    const nv = posA.getCount();
    const remap = new Int32Array(nv).fill(-1);
    let n = 0;
    const newIdx = keepIdx.subarray(0, k);
    for (let i = 0; i < k; i++) { const v = newIdx[i]; if (remap[v] < 0) remap[v] = n++; newIdx[i] = remap[v]; }
    for (const sem of prim.listSemantics()) {
      const acc = prim.getAttribute(sem);
      const src = acc.getArray(); const es = acc.getElementSize();
      const dst = new src.constructor(n * es);
      for (let v = 0; v < nv; v++) { const r = remap[v]; if (r >= 0) for (let e = 0; e < es; e++) dst[r * es + e] = src[v * es + e]; }
      acc.setArray(dst);
    }
    idxA.setArray(n > 65535 ? new Uint32Array(newIdx) : new Uint16Array(newIdx));
    trisOut += k / 3; vertsOut += n;
    const tex = prim.getMaterial()?.getBaseColorTexture();
    if (tex) {
      if (!keptByTexture.has(tex)) keptByTexture.set(tex, []);
      keptByTexture.get(tex).push({ uv: prim.getAttribute('TEXCOORD_0').getArray(), idx: idxA.getArray() });
    }
  }
}
for (const mesh of root.listMeshes()) if (mesh.listPrimitives().length === 0) mesh.dispose();
const texIn = root.listTextures().length;
const texBytesIn = root.listTextures().reduce((a, t) => a + t.getImage().byteLength, 0);
lap('crop_geometry');
await doc.transform(prune());
const texOut = root.listTextures().length;
const texBytesPruned = root.listTextures().reduce((a, t) => a + t.getImage().byteLength, 0);
lap('prune');

// texture masking
let texBytesMasked = 0, texBytesReenc = 0, maskCoverage = [];
if (MASK) {
  for (const tex of root.listTextures()) {
    const parts = keptByTexture.get(tex) || [];
    const img = sharp(Buffer.from(tex.getImage()));
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, C = info.channels;
    const mask = new Uint8Array(W * H);
    for (const { uv, idx } of parts) {
      for (let f = 0; f < idx.length; f += 3) {
        const ax = uv[2 * idx[f]] * W, ay = uv[2 * idx[f] + 1] * H;
        const bx = uv[2 * idx[f + 1]] * W, by = uv[2 * idx[f + 1] + 1] * H;
        const cx = uv[2 * idx[f + 2]] * W, cy = uv[2 * idx[f + 2] + 1] * H;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - PAD)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx) + PAD));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - PAD)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy) + PAD));
        // edge functions normalised to pixel distance; accept points within PAD of the triangle
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const s = area >= 0 ? 1 : -1;
        const e = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]].map(([x1_, y1_, x2_, y2_]) => {
          const dx = x2_ - x1_, dy = y2_ - y1_, L = Math.hypot(dx, dy) || 1;
          return [x1_, y1_, s * dx / L, s * dy / L];
        });
        for (let y = y0; y <= y1; y++) {
          const py = y + 0.5;
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            if ((e[0][2] * (py - e[0][1]) - e[0][3] * (px - e[0][0])) >= -PAD &&
                (e[1][2] * (py - e[1][1]) - e[1][3] * (px - e[1][0])) >= -PAD &&
                (e[2][2] * (py - e[2][1]) - e[2][3] * (px - e[2][0])) >= -PAD) mask[y * W + x] = 1;
          }
        }
      }
    }
    let cov = 0;
    if (COMPARE) {
      const re = await sharp(data, { raw: { width: W, height: H, channels: C } }).jpeg({ quality: QUALITY }).toBuffer();
      texBytesReenc += re.length;
    }
    for (let i = 0; i < W * H; i++) { if (mask[i]) cov++; else { const o = i * C; data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; } }
    maskCoverage.push(cov / (W * H));
    const enc = await sharp(data, { raw: { width: W, height: H, channels: C } }).jpeg({ quality: QUALITY }).toBuffer();
    tex.setImage(new Uint8Array(enc.buffer, enc.byteOffset, enc.length)).setMimeType('image/jpeg');
    texBytesMasked += enc.length;
  }
  lap('mask_textures');
}
await io.write(out, doc);
lap('write');
clearInterval(memTimer);
const MB = b => +(b / 1048576).toFixed(2);
console.log(JSON.stringify({
  in: inp, out, polygonAreaM2: polyArea, polygonFractionOf30x50: +(polyArea / 1500).toFixed(3),
  trisIn, trisOut, vertsIn, vertsOut, texturesIn: texIn, texturesOut: texOut,
  textureMB_in: MB(texBytesIn), textureMB_afterPrune: MB(texBytesPruned),
  textureMB_reencodedUnmasked: COMPARE ? MB(texBytesReenc) : null, textureMB_masked: MASK ? MB(texBytesMasked) : null,
  maskCoverageMean: maskCoverage.length ? +(maskCoverage.reduce((a, b) => a + b, 0) / maskCoverage.length).toFixed(3) : null,
  outMB: MB(fs.statSync(out).size), seconds: T, nodeRssPeakMB: Math.round(rssPeak.v / 1048576),
}));
