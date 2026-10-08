// Convert all textures of a GLB to KTX2 (Basis ETC1S or UASTC) with the WASM basis encoder (npm ktx2-encoder),
// because KTX-Software's `ktx` CLI (needed by `gltf-transform etc1s/uastc`) could not be installed here.
// usage: node ktx2_test.mjs in.glb out.glb [--uastc] [--size 1024] [--limit N]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(ROOT, 'node', 'package.json'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS, KHRTextureBasisu, EXTTextureWebP } = require('@gltf-transform/extensions');
const sharp = require('sharp');
const { MeshoptDecoder, MeshoptEncoder } = require('meshoptimizer');
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const { encodeToKTX2 } = await import(path.join(ROOT, 'node-ktx/node_modules/ktx2-encoder/dist/node/index.js'));

const args = process.argv.slice(2);
const [inp, out] = args;
const UASTC = args.includes('--uastc');
const si = args.indexOf('--size'); const SIZE = si >= 0 ? +args[si + 1] : 0;
const li = args.indexOf('--limit'); const LIMIT = li >= 0 ? +args[li + 1] : Infinity;

const imageDecoder = async (buf) => {
  let img = sharp(Buffer.from(buf));
  if (SIZE) img = img.resize(SIZE, SIZE, { fit: 'inside' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inp);
const t0 = performance.now();
let n = 0, inBytes = 0, outBytes = 0; const per = [];
for (const tex of doc.getRoot().listTextures()) {
  if (n >= LIMIT) break;
  const t1 = performance.now();
  const src = tex.getImage();
  inBytes += src.byteLength;
  const k = await encodeToKTX2(src, {
    isUASTC: UASTC, generateMipmap: true, isKTX2File: true, isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
    needSupercompression: UASTC, qualityLevel: 128, compressionLevel: 2, imageDecoder,
  });
  tex.setImage(k).setMimeType('image/ktx2');
  outBytes += k.byteLength; n++;
  per.push((performance.now() - t1) / 1000);
}
doc.createExtension(KHRTextureBasisu).setRequired(true);
const webp = doc.getRoot().listExtensionsUsed().find(e => e.extensionName === 'EXT_texture_webp');
if (webp && !doc.getRoot().listTextures().some(t => t.getMimeType() === 'image/webp')) webp.dispose();
await io.write(out, doc);
console.log(JSON.stringify({ mode: UASTC ? 'UASTC+zstd' : 'ETC1S', textures: n, inMB: +(inBytes / 1048576).toFixed(2), ktx2MB: +(outBytes / 1048576).toFixed(2),
  secondsTotal: +((performance.now() - t0) / 1000).toFixed(1), secondsPerTexture: +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(2),
  outMB: +(fs.statSync(out).size / 1048576).toFixed(2), rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
