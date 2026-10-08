"""Print the benchmark table (markdown + JSON rows) from data/<S|M|L>/bench.json and extra.json."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = []
for s in "SML":
    d = os.path.join(ROOT, "data", s)
    b = json.load(open(os.path.join(d, "bench.json")))
    g = json.load(open(os.path.join(d, "gen_stats.json")))
    gl = open(os.path.join(ROOT, "logs", f"gen_{s}.log")).read()
    import re
    w = re.search(r"Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (\d+):([\d.]+)", gl)
    m = re.search(r"Maximum resident set size \(kbytes\): (\d+)", gl)
    known = {"S": (136.2, 42.8), "M": (432.3, 121.8), "L": (875.9, 246.5)}  # MiB, measured before M/L sources were deleted
    try:
        objmb = os.path.getsize(os.path.join(d, "terra_obj/Block/Block.obj")) / 1048576
        jpg = sum(os.path.getsize(os.path.join(d, "terra_obj/Block", f)) for f in os.listdir(os.path.join(d, "terra_obj/Block")) if f.endswith(".jpg")) / 1048576
    except (FileNotFoundError, ZeroDivisionError):
        objmb, jpg = known[s]
    if objmb == 0 or jpg == 0:
        objmb, jpg = known[s]
    rows.append(dict(sample=s, step="0 generate synthetic export (not part of app)", seconds=int(w.group(1)) * 60 + float(w.group(2)),
                     peakRssMB=int(m.group(1)) / 1024, outputMB=objmb + jpg, triangles=g["tris"],
                     notes=f"OBJ {objmb:.0f} MB + {g['pages']} JPG {jpg:.0f} MB; v {g['verts']}, vt {g['uvs']}, {g['charts']} UV charts, {g['cell_cm']:.1f} cm cells, {1000 / g['ppm']:.1f} mm/texel"))
    names = {"a_obj2gltf": "a OBJ->GLB (obj2gltf 3.2.0, --unlit, Z-up)", "b_web": "b web.glb (gltf-transform 4.5.1 optimize: weld+simplify 500k+webp 2048 q80 default+meshopt)",
             "c_render": "c render.glb (simplify 1.5M, original JPEG 4096, no geometry compression)", "d_crop": "d crop to polygon (61% of area) + texture mask",
             "e_web_from_crop": "e web.glb from cropped model (same simplify ratio)"}
    for k, label in names.items():
        r = b.get(k)
        if not r:
            continue
        o = r.get("out") or {}
        note = ""
        if k == "a_obj2gltf":
            note = f"{o.get('verts')} verts, {o.get('images')} JPEG embedded; node default heap"
        if k in ("b_web", "e_web_from_crop"):
            note = f"textures {o.get('imageMB')} MB ({o.get('images')} x webp), geometry {o['MB'] - o['imageMB']:.1f} MB; cpu {r['cpu_seconds']:.0f}s"
        if k == "c_render":
            note = f"textures {o.get('imageMB')} MB JPEG; geometry {o['MB'] - o['imageMB']:.0f} MB float32"
        if k == "d_crop":
            c = r.get("crop_report", {})
            note = (f"tris {c.get('trisIn')}->{c.get('trisOut')}, textures {c.get('texturesIn')}->{c.get('texturesOut')}; tex MB {c.get('textureMB_in')} -> "
                    f"{c.get('textureMB_afterPrune')} (pages pruned) -> {c.get('textureMB_masked')} (masked; unmasked re-encode {c.get('textureMB_reencodedUnmasked')}); "
                    f"stage s {c.get('seconds')}")
        rows.append(dict(sample=s, step=label, seconds=r["seconds"], peakRssMB=r["peak_rss_mb"], outputMB=o.get("MB"), triangles=o.get("tris"), notes=note))
    for k, label in (("f_browser_web", "f browser load web.glb"), ("f_browser_web_crop", "f browser load web.glb (cropped)")):
        r = b.get(k)
        if not r:
            continue
        rows.append(dict(sample=s, step=label, seconds=round(r["loadMs"] / 1000, 2), peakRssMB=r["chromePssPeakMB"], outputMB=round(r["fileMB"], 2), triangles=r["tris"],
                         notes=f"GLTFLoader load {r['loadMs'] / 1000:.2f}s (local), first frame {r['firstFrameMs'] / 1000:.1f}s, frame {r['frameMs']:.0f} ms @1280x720 SwiftShader; "
                               f"{r['textures']} tex {list(r['texDims'].keys())}, est GPU tex {r['gpuTexMB_est']:.0f} MB; peak RSS col = summed Chromium PSS"))
extra = os.path.join(ROOT, "data", "extra.json")
if os.path.exists(extra):
    rows += json.load(open(extra))
if "--json" in sys.argv:
    print(json.dumps(rows, indent=1))
else:
    print("| sample | step | s | peak RSS MB | output MB | triangles | notes |\n|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['sample']} | {r['step']} | {r['seconds']} | {r['peakRssMB']:.0f} | {r['outputMB'] if r['outputMB'] is None else round(r['outputMB'], 1)} | {r['triangles']} | {r['notes']} |")
