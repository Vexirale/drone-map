// Quick GLB stats from the JSON chunk only: triangles, vertices, primitives, images (count, mime, bytes).
// usage: node glbstats.mjs file.glb [--json]
import fs from 'node:fs';

export function glbStats(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(20);
  fs.readSync(fd, head, 0, 20, 0);
  const jsonLen = head.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 20);
  fs.closeSync(fd);
  const j = JSON.parse(jb.toString('utf8'));
  let tris = 0, verts = 0, prims = 0;
  for (const m of j.meshes || []) for (const p of m.primitives) {
    prims++;
    const pos = j.accessors[p.attributes.POSITION];
    verts += pos.count;
    tris += (p.indices !== undefined ? j.accessors[p.indices].count : pos.count) / 3;
  }
  const imgs = (j.images || []).map(im => ({ mime: im.mimeType, bytes: im.bufferView !== undefined ? j.bufferViews[im.bufferView].byteLength : 0 }));
  const imgBytes = imgs.reduce((a, b) => a + b.bytes, 0);
  const mimes = {};
  for (const im of imgs) mimes[im.mime] = (mimes[im.mime] || 0) + 1;
  return {
    file, MB: +(fs.statSync(file).size / 1048576).toFixed(2), tris, verts, prims, images: imgs.length, mimes,
    imageMB: +(imgBytes / 1048576).toFixed(2), extensionsUsed: j.extensionsUsed || [],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2).filter(a => !a.startsWith('--'))) console.log(JSON.stringify(glbStats(f)));
}
