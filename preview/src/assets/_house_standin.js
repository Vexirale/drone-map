// Simplified stand-in of the real preview house (same footprint, heights, roof and solar panels). For layout checks only.
import * as THREE from 'three';
export function buildHouseStandin() {
  const g = new THREE.Group();
  const brick = new THREE.MeshStandardMaterial({ color: 0x8a4430, roughness: 0.9 });
  const tile = new THREE.MeshStandardMaterial({ color: 0x9c4a32, roughness: 0.8 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x14203a, roughness: 0.25 });
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(10, 6, 8), brick, 0, 3, 0);
  const tri = new THREE.Shape([new THREE.Vector2(-4, 0), new THREE.Vector2(4, 0), new THREE.Vector2(0, 4)]);
  for (const s of [1, -1]) { const geo = new THREE.ShapeGeometry(tri); geo.rotateY(s * Math.PI / 2); add(geo, brick, s * 5, 6, 0); }
  const C = Math.SQRT1_2, L = 6.16, mid = 2.58;
  add(new THREE.BoxGeometry(10.8, 0.14, L), tile, 0, 6 + mid * C - 0.07 * C, -4 + mid * C + 0.07 * C, -Math.PI / 4);
  add(new THREE.BoxGeometry(10.8, 0.14, L), tile, 0, 6 + mid * C - 0.07 * C, 4 - mid * C - 0.07 * C, Math.PI / 4);
  add(new THREE.BoxGeometry(5.1, 0.05, 3.42), panel, -0.76, 6 + 2.81 * C + 0.17 * C, -4 + 2.81 * C - 0.17 * C, -Math.PI / 4);
  add(new THREE.BoxGeometry(0.7, 2.6, 0.62), brick, 2.8, 9.6, 1.0);
  return g;
}
