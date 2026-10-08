# Asset module rules (read fully)

Each asset is a plain ES module in this folder. It is later inlined into a single-file HTML page, so:
- Allowed imports, exactly these lines and nothing else:
    import * as THREE from 'three';
    import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
- Only `export function ...` for the listed exports. Everything else module-private.
- Deterministic: use a seeded PRNG (mulberry32), never Math.random() or Date.
- No network, no image files: textures are drawn on <canvas> (CanvasTexture, colorSpace SRGBColorSpace for colour maps; max 1024x1024 each, prefer 512). Cache textures/materials/geometries at module level and reuse them across calls (e.g. 6 trees must not create 6 copies of the leaf texture).
- Units: metres, +Y up. The returned Object3D has its origin on the ground (y=0) at the asset's footprint centre.
- Shadows: set castShadow / receiveShadow deliberately. Alpha-cut materials (leaves, mesh, fences with gaps) must use alphaTest and a matching customDepthMaterial (MeshDepthMaterial with depthPacking RGBADepthPacking, same map, same alphaTest) so their shadows have the cut-out shape.
- Set `userData.noAO = true` on meshes the screen-space AO pass must skip: alpha-cut foliage cards, decals, glass, transparent things.
- Lighting/look: the page uses ACES tone mapping, image-based lighting from a blue sky dome, a warm sun from the south-west at ~48 degrees elevation, soft PCF shadows, GTAO ambient occlusion and exponential fog. MeshStandardMaterial / MeshPhysicalMaterial only (no unlit or toon). Do not add lights.
- Performance: the page must run smoothly on a mid-range phone. Respect the per-asset budgets in your brief. Use InstancedMesh or merged geometry instead of many small meshes. Report triangles and draw calls from the harness.

# Test harness
    node tools/shoot-asset.mjs <outDir> <jobs.json>      (run from preview/)
Job: {"name","width":1280,"height":720,"quality":"high"|"low","ground":true,"camera":{"pos":[x,y,z],"target":[x,y,z],"fov":38},
      "modules":[{"file":"trees.js","export":"buildTree","args":{...},"position":[x,y,z],"rotationY":0,"scale":1}], "shadowCenter":[x,z]}
- `ground:true` adds a plain green ground disc (set false if your module builds its own ground).
- `_house_standin.js` / export `buildHouseStandin` is a stand-in of the real house at the origin (walls x -5..5, z -4..4, ridge y=10 along x, solar panels on the south (-z) roof slope). Use it for scale and composition.
- The report prints triangles/draw calls (main pass) and errors. Look at every PNG you produce with the Read tool. Iterate until it looks good, not until it merely runs.
- Headless software rendering: each job takes ~1-3 s; batch several jobs per run.
