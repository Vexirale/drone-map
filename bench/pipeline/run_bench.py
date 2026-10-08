"""Run the planned processing pipeline on a synthetic sample, timing every step with /usr/bin/time -v.

usage: run_bench.py <sample_dir> [--steps a,b,c,d,e,f,g] [--tag S]
Writes <sample_dir>/bench.json (appends/overwrites per step) and logs in <sample_dir>/logs/.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = os.path.join(ROOT, "node")
OBJ2GLTF = os.path.join(NODE, "node_modules/obj2gltf/bin/obj2gltf.js")
GT = os.path.join(NODE, "node_modules/@gltf-transform/cli/bin/cli.js")
OPT_COMMON = ["--instance", "false", "--palette", "false", "--prune-solid-textures", "false", "--simplify-error", "0.02"]


def timed(name, cmd, d, env=None):
    os.makedirs(os.path.join(d, "logs"), exist_ok=True)
    log = os.path.join(d, "logs", f"{name}.log")
    t0 = time.time()
    with open(log, "w") as f:
        f.write(" ".join(cmd) + "\n\n")
        f.flush()
        p = subprocess.run(["/usr/bin/time", "-v"] + cmd, stdout=f, stderr=subprocess.STDOUT, cwd=NODE,
                           env={**os.environ, **(env or {})})
    txt = open(log).read()
    wall = time.time() - t0
    m = re.search(r"Maximum resident set size \(kbytes\): (\d+)", txt)
    u = re.search(r"User time \(seconds\): ([\d.]+)", txt)
    s = re.search(r"System time \(seconds\): ([\d.]+)", txt)
    cpu = (float(u.group(1)) + float(s.group(1))) if u and s else None
    return dict(step=name, rc=p.returncode, seconds=round(wall, 1), cpu_seconds=cpu,
                peak_rss_mb=round(int(m.group(1)) / 1024) if m else None, log=log)


def glbstats(path):
    out = subprocess.run(["node", os.path.join(HERE, "glbstats.mjs"), path], capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else None


def main():
    d = os.path.abspath(sys.argv[1])
    steps = "a,b,c,d,e,f"
    if "--steps" in sys.argv:
        steps = sys.argv[sys.argv.index("--steps") + 1]
    steps = steps.split(",")
    resf = os.path.join(d, "bench.json")
    res = json.load(open(resf)) if os.path.exists(resf) else {}
    gen = json.load(open(os.path.join(d, "gen_stats.json")))
    tris = gen["tris"]
    obj = os.path.join(d, "terra_obj/Block/Block.obj")
    raw, web, render = (os.path.join(d, f) for f in ("raw.glb", "web.glb", "render.glb"))
    crop, webc = os.path.join(d, "crop.glb"), os.path.join(d, "web_crop.glb")

    def save():
        json.dump(res, open(resf, "w"), indent=1)

    def run(key, name, cmd, out=None, env=None):
        print(f"[{os.path.basename(d)}] {name} ...", flush=True)
        r = timed(name, cmd, d, env)
        if out and os.path.exists(out) and r["rc"] == 0:
            r["out"] = glbstats(out)
        res[key] = r
        save()
        print(f"   rc={r['rc']} {r['seconds']} s, peak RSS {r['peak_rss_mb']} MB"
              + (f", out {r['out']['MB']} MB, {r['out']['tris']:.0f} tris" if r.get("out") else ""), flush=True)
        return r

    if "a" in steps:
        r = run("a_obj2gltf", "a_obj2gltf", ["node", OBJ2GLTF, "-i", obj, "-o", raw, "-b", "--inputUpAxis", "Z", "--unlit"], raw)
        if r["rc"] != 0:
            run("a_obj2gltf_bigheap", "a_obj2gltf_bigheap",
                ["node", "--max-old-space-size=13000", OBJ2GLTF, "-i", obj, "-o", raw, "-b", "--inputUpAxis", "Z", "--unlit"], raw)
    r_web = min(1.0, 500_000 / tris)
    r_ren = min(1.0, 1_500_000 / tris)
    if "b" in steps:
        run("b_web", "b_web", ["node", GT, "optimize", raw, web, "--compress", "meshopt", "--texture-compress", "webp",
                               "--texture-size", "2048", "--simplify-ratio", f"{r_web:.5f}"] + OPT_COMMON, web)
    if "c" in steps:
        run("c_render", "c_render", ["node", GT, "optimize", raw, render, "--compress", "false", "--texture-compress", "false",
                                     "--simplify-ratio", f"{r_ren:.5f}"] + OPT_COMMON, render)
    if "d" in steps:
        r = run("d_crop", "d_crop", ["node", os.path.join(HERE, "crop.mjs"), raw, crop, "--mask", "--compare"], crop)
        try:
            r["crop_report"] = json.loads(open(r["log"]).read().split("\n\n", 1)[1].split("\n\tCommand being timed")[0].strip().splitlines()[-1])
        except Exception as e:  # noqa
            r["crop_report_error"] = str(e)
        save()
    if "e" in steps:
        run("e_web_from_crop", "e_web_from_crop", ["node", GT, "optimize", crop, webc, "--compress", "meshopt", "--texture-compress", "webp",
                                                   "--texture-size", "2048", "--simplify-ratio", f"{r_web:.5f}"] + OPT_COMMON, webc)
    if "f" in steps:
        for key, f in (("f_browser_web", web), ("f_browser_web_crop", webc)):
            if not os.path.exists(f):
                continue
            print(f"[{os.path.basename(d)}] {key} ...", flush=True)
            p = subprocess.run(["node", os.path.join(HERE, "bench_browser.mjs"), f, "--shot", f[:-4] + ".png"],
                               capture_output=True, text=True, cwd=NODE)
            try:
                res[key] = json.loads(p.stdout)
            except Exception:
                res[key] = dict(error=p.stdout[-2000:] + p.stderr[-2000:])
            save()
            print("   ", {k: res[key].get(k) for k in ("loadMs", "firstFrameMs", "gpuTexMB_est", "fileMB", "chromePssPeakMB", "error")}, flush=True)


if __name__ == "__main__":
    main()
