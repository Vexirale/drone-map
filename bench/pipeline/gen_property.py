"""Generate a synthetic DJI-Terra-like textured OBJ export of a whole property (~30 x 50 m).

Structure (matches what we know/assume about Terra OBJ exports, see report):
  <out>/terra_obj/metadata.xml          (SRS EPSG:32631 + SRSOrigin)
  <out>/terra_obj/Block/Block.obj       (v + vt + f v/vt, Z-up, coords relative to SRSOrigin)
  <out>/terra_obj/Block/Block.mtl       (one material per texture page)
  <out>/terra_obj/Block/Block_<i>.jpg   (4096x4096 JPEG q90 atlases)

Geometry: jittered grids with random diagonals (irregular, near-uniform triangle size),
split into UV charts that are shelf-packed into N atlas pages (spatially coherent pages).
Scene: undulating ground with lawn/driveway/patio/beds, 10x8 m gable-roof house, shed,
4 tree crowns (noisy cube-spheres) with trunks, 2 hedges.

usage: gen_property.py --tris 2000000 --pages 12 --out DIR [--no-textures]
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time
from multiprocessing import Pool

import numpy as np

PAGE = 4096
PAD = 4
HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------------- utm
def utm(lat, lon, zone=31):
    """WGS84 -> UTM north (Snyder series). Good to ~1 m, enough for a fake origin."""
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0 = 0.9996
    lon0 = math.radians(zone * 6 - 183)
    phi, lam = math.radians(lat), math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    T = math.tan(phi) ** 2
    C = ep2 * math.cos(phi) ** 2
    A = math.cos(phi) * (lam - lon0)
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * phi)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * phi))
    E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000
    Nn = k0 * (M + N * math.tan(phi) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
                                         + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720))
    return E, Nn


# ----------------------------------------------------------------------------- noise
class SinNoise:
    """Smooth 3D noise as a sum of random-direction sinusoids (deterministic per seed)."""

    def __init__(self, seed, n, kmin, kmax):
        r = np.random.default_rng(seed)
        d = r.normal(size=(n, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        self.k = d * r.uniform(kmin, kmax, size=(n, 1))
        self.ph = r.uniform(0, 2 * np.pi, size=n)
        self.n = n

    def __call__(self, x, y, z):
        out = np.zeros_like(x)
        for i in range(self.n):
            out += np.sin(self.k[i, 0] * x + self.k[i, 1] * y + self.k[i, 2] * z + self.ph[i])
        return out / math.sqrt(self.n / 2)


N_GROUND = SinNoise(11, 6, 0.08, 0.5)
N_TREE1 = SinNoise(21, 6, 1.5, 3.0)
N_TREE2 = SinNoise(22, 8, 6.0, 12.0)
N_HEDGE1 = SinNoise(31, 6, 1.0, 3.0)
N_HEDGE2 = SinNoise(32, 6, 6.0, 14.0)


def ground_z(x, y):
    return 0.010 * y + 0.18 * N_GROUND(x, y, np.zeros_like(x))


# ----------------------------------------------------------------------------- scene
HOUSE = dict(x0=-5.0, x1=5.0, y0=-2.0, y1=6.0, eave=3.0, pitch=math.radians(40), over=0.4)
SHED = dict(x0=8.0, x1=11.0, y0=16.0, y1=18.5, hf=2.4, hb=2.1)
TREES = [(10.0, -15.0, 3.0, 2.5), (-12.0, 15.0, 3.5, 3.0), (11.0, 8.0, 2.5, 2.0), (2.0, 20.0, 4.0, 3.0)]
HEDGES = [((-14.3, -24.0), (-14.3, 24.0)), ((-14.0, 24.3), (14.0, 24.3))]
HEDGE_W, HEDGE_H = 0.8, 1.5


class Patch:
    def __init__(self, name, W, H, fmap, ftype, mask=None, rough=0.0, seed=0):
        self.name, self.W, self.H, self.fmap, self.ftype, self.mask = name, W, H, fmap, ftype, mask
        self.rough, self.seed = rough, seed


def ground_type(x, y):
    if -11.0 <= x <= -7.5 and y <= 4.0:
        return "driveway"
    if -5.0 <= x <= 5.0 and -4.5 <= y < -2.0:
        return "patio"
    if (5.0 < x < 6.5 and -2.0 < y < 6.0) or (-14 < x < -12.5 and -20 < y < 10):
        return "soil"
    return "lawn"


def build_patches():
    P = []
    # ground
    def g_map(U, V):
        X, Y = U - 15.0, V - 25.0
        return X, Y, ground_z(X, Y)

    def g_mask(U, V):
        X, Y = U - 15.0, V - 25.0
        h, s = HOUSE, SHED
        inside_h = (X > h["x0"]) & (X < h["x1"]) & (Y > h["y0"]) & (Y < h["y1"])
        inside_s = (X > s["x0"]) & (X < s["x1"]) & (Y > s["y0"]) & (Y < s["y1"])
        return ~(inside_h | inside_s)

    P.append(Patch("ground", 30.0, 50.0, g_map, lambda U, V: ground_type(U - 15, V - 25), g_mask, 0.012, 1))

    # house
    h = HOUSE
    zb = float(ground_z(np.array([0.0]), np.array([2.0]))[0]) - 0.05
    ze = zb + h["eave"]
    tp = math.tan(h["pitch"])
    half = (h["y1"] - h["y0"]) / 2
    rise = half * tp
    W_x, W_y = h["x1"] - h["x0"], h["y1"] - h["y0"]
    P.append(Patch("wall_s", W_x, h["eave"], lambda U, V: (h["x0"] + U, np.full_like(U, h["y0"]), zb + V),
                   lambda U, V: "wall", None, 0.005, 2))
    P.append(Patch("wall_n", W_x, h["eave"], lambda U, V: (h["x1"] - U, np.full_like(U, h["y1"]), zb + V),
                   lambda U, V: "wall", None, 0.005, 3))
    gmask = lambda U, V: V <= h["eave"] + (half - np.abs(U - half)) * tp
    P.append(Patch("wall_e", W_y, h["eave"] + rise, lambda U, V: (np.full_like(U, h["x1"]), h["y0"] + U, zb + V),
                   lambda U, V: "wall", gmask, 0.005, 4))
    P.append(Patch("wall_w", W_y, h["eave"] + rise, lambda U, V: (np.full_like(U, h["x0"]), h["y1"] - U, zb + V),
                   lambda U, V: "wall", gmask, 0.005, 5))
    slope = (half + h["over"]) / math.cos(h["pitch"])
    c, s_ = math.cos(h["pitch"]), math.sin(h["pitch"])
    z_eave = ze - h["over"] * tp
    P.append(Patch("roof_s", W_x + 2 * h["over"], slope,
                   lambda U, V: (h["x0"] - h["over"] + U, h["y0"] - h["over"] + V * c, z_eave + V * s_),
                   lambda U, V: "roof", None, 0.01, 6))
    P.append(Patch("roof_n", W_x + 2 * h["over"], slope,
                   lambda U, V: (h["x1"] + h["over"] - U, h["y1"] + h["over"] - V * c, z_eave + V * s_),
                   lambda U, V: "roof", None, 0.01, 7))

    # shed (mono-pitch)
    sd = SHED
    zs = float(ground_z(np.array([9.5]), np.array([17.25]))[0]) - 0.05
    sw, sl = sd["x1"] - sd["x0"], sd["y1"] - sd["y0"]
    top = lambda dy: sd["hf"] - (sd["hf"] - sd["hb"]) * dy / sl
    P.append(Patch("shed_s", sw, sd["hf"], lambda U, V: (sd["x0"] + U, np.full_like(U, sd["y0"]), zs + V),
                   lambda U, V: "shed", None, 0.005, 8))
    P.append(Patch("shed_n", sw, sd["hb"], lambda U, V: (sd["x1"] - U, np.full_like(U, sd["y1"]), zs + V),
                   lambda U, V: "shed", None, 0.005, 9))
    P.append(Patch("shed_e", sl, sd["hf"], lambda U, V: (np.full_like(U, sd["x1"]), sd["y0"] + U, zs + V),
                   lambda U, V: "shed", lambda U, V: V <= top(U), 0.005, 10))
    P.append(Patch("shed_w", sl, sd["hf"], lambda U, V: (np.full_like(U, sd["x0"]), sd["y1"] - U, zs + V),
                   lambda U, V: "shed", lambda U, V: V <= top(sl - U), 0.005, 11))
    P.append(Patch("shed_roof", sw + 0.4, sl + 0.4,
                   lambda U, V: (sd["x0"] - 0.2 + U, sd["y0"] - 0.2 + V, zs + top(V - 0.2) + 0.03),
                   lambda U, V: "flatroof", None, 0.008, 12))

    # trees: noisy cube-sphere crowns + trunks
    faces = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
             ((0, 1, 0), (0, 0, 1), (1, 0, 0)), ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
             ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (0, 1, 0), (1, 0, 0))]
    for ti, (cx, cy, r, th) in enumerate(TREES):
        zg = float(ground_z(np.array([cx]), np.array([cy]))[0])
        cz = zg + th + 0.9 * r
        Wf = r * math.pi / 2
        for fi, (d, a1, a2) in enumerate(faces):
            d, a1, a2 = np.array(d, float), np.array(a1, float), np.array(a2, float)

            def t_map(U, V, d=d, a1=a1, a2=a2, cx=cx, cy=cy, cz=cz, r=r, Wf=Wf, ti=ti):
                a = np.tan((2 * U / Wf - 1) * math.pi / 4)
                b = np.tan((2 * V / Wf - 1) * math.pi / 4)
                px = d[0] + a * a1[0] + b * a2[0]
                py = d[1] + a * a1[1] + b * a2[1]
                pz = d[2] + a * a1[2] + b * a2[2]
                n = np.sqrt(px * px + py * py + pz * pz)
                px, py, pz = px / n, py / n, pz / n
                rr = r * (1 + 0.22 * N_TREE1(px + ti, py, pz) + 0.07 * N_TREE2(px, py + ti, pz))
                return cx + rr * px, cy + rr * py, cz + 0.85 * rr * pz

            P.append(Patch(f"tree{ti}_f{fi}", Wf, Wf, t_map, lambda U, V: "tree", None, 0.03, 100 + ti * 10 + fi))
        rt = 0.2
        P.append(Patch(f"trunk{ti}", 2 * math.pi * rt, th + 0.3 * r,
                       lambda U, V, cx=cx, cy=cy, zg=zg, rt=rt: (cx + rt * np.cos(U / rt), cy + rt * np.sin(U / rt), zg + V),
                       lambda U, V: "trunk", None, 0.01, 200 + ti))

    # hedges: rounded-box profile swept along a line, noisy
    for hi, (p0, p1) in enumerate(HEDGES):
        p0, p1 = np.array(p0), np.array(p1)
        L = float(np.linalg.norm(p1 - p0))
        t = (p1 - p0) / L
        nrm = np.array([t[1], -t[0]])
        prof = 2 * HEDGE_H + HEDGE_W

        def h_map(U, V, p0=p0, t=t, nrm=nrm, hi=hi):
            side_r = V < HEDGE_H
            top_ = (V >= HEDGE_H) & (V < HEDGE_H + HEDGE_W)
            off = np.where(side_r, HEDGE_W / 2, np.where(top_, HEDGE_W / 2 - (V - HEDGE_H), -HEDGE_W / 2))
            z = np.where(side_r, V, np.where(top_, HEDGE_H, HEDGE_H - (V - HEDGE_H - HEDGE_W)))
            bx = p0[0] + U * t[0]
            by = p0[1] + U * t[1]
            disp = 0.12 * N_HEDGE1(bx, by + hi, z) + 0.04 * N_HEDGE2(bx, by, z + hi)
            onx = np.where(top_, 0.0, np.where(side_r, 1.0, -1.0))
            onz = np.where(top_, 1.0, 0.0)
            X = bx + (off + disp * onx) * nrm[0]
            Y = by + (off + disp * onx) * nrm[1]
            Z = ground_z(bx, by) + z + disp * onz
            return X, Y, Z

        P.append(Patch(f"hedge{hi}", L, prof, h_map, lambda U, V: "hedge", None, 0.03, 300 + hi))
    return P


# ----------------------------------------------------------------------------- tessellation
def seg_split(n, rng, lo=8, hi=24):
    """Split n cells into consecutive segments of random length in [lo, hi]."""
    cuts = [0]
    while cuts[-1] < n:
        cuts.append(min(n, cuts[-1] + int(rng.integers(lo, hi + 1))))
    if len(cuts) > 2 and cuts[-1] - cuts[-2] < lo // 2:
        cuts.pop(-2)
    return np.array(cuts)


def count_cells(patches, h):
    tot = 0
    for p in patches:
        nu, nv = max(1, round(p.W / h)), max(1, round(p.H / h))
        if p.mask is None:
            tot += nu * nv
        else:
            du, dv = p.W / nu, p.H / nv
            U, V = np.meshgrid((np.arange(nu) + 0.5) * du, (np.arange(nv) + 0.5) * dv, indexing="ij")
            tot += int(p.mask(U, V).sum())
    return tot


def tessellate(p, h):
    rng = np.random.default_rng(p.seed)
    nu, nv = max(1, round(p.W / h)), max(1, round(p.H / h))
    du, dv = p.W / nu, p.H / nv
    I, J = np.meshgrid(np.arange(nu + 1), np.arange(nv + 1), indexing="ij")
    ju = rng.uniform(-0.35, 0.35, I.shape)
    jv = rng.uniform(-0.35, 0.35, I.shape)
    ju[(I == 0) | (I == nu)] = 0
    jv[(J == 0) | (J == nv)] = 0
    U = (I + ju) * du
    V = (J + jv) * dv
    del ju, jv
    X, Y, Z = p.fmap(U, V)
    X = np.asarray(X, np.float64) + rng.normal(0, p.rough * 0.3, U.shape)
    Y = np.asarray(Y, np.float64) + rng.normal(0, p.rough * 0.3, U.shape)
    Z = np.asarray(Z, np.float64) + rng.normal(0, p.rough, U.shape)
    pos = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
    Uf, Vf = U.ravel(), V.ravel()
    del X, Y, Z, U, V

    # cells
    ci, cj = np.meshgrid(np.arange(nu), np.arange(nv), indexing="ij")
    if p.mask is not None:
        keep = p.mask((ci + 0.5) * du, (cj + 0.5) * dv)
    else:
        keep = np.ones(ci.shape, bool)
    ci, cj = ci[keep], cj[keep]
    useg, vseg = seg_split(nu, rng), seg_split(nv, rng)
    cu = np.searchsorted(useg, ci, side="right") - 1
    cv = np.searchsorted(vseg, cj, side="right") - 1
    nchu = len(useg) - 1
    chart_local = cv * nchu + cu  # row-major over (v-segment, u-segment): shelf-friendly order
    diag = rng.random(ci.shape) < 0.5
    stride = nv + 1
    v00 = ci * stride + cj
    v10 = (ci + 1) * stride + cj
    v11 = (ci + 1) * stride + cj + 1
    v01 = ci * stride + cj + 1
    t1 = np.where(diag[:, None], np.stack([v00, v10, v11], 1), np.stack([v00, v10, v01], 1))
    t2 = np.where(diag[:, None], np.stack([v00, v11, v01], 1), np.stack([v10, v11, v01], 1))
    tris = np.concatenate([t1, t2], 0)
    tchart = np.concatenate([chart_local, chart_local], 0)
    order = np.argsort(tchart, kind="stable")
    tris, tchart = tris[order], tchart[order]
    used_charts = np.unique(tchart)
    charts = []
    for c in used_charts:
        sv, su = divmod(int(c), nchu)
        i0, i1 = useg[su], useg[su + 1]
        j0, j1 = vseg[sv], vseg[sv + 1]
        cxm = (i0 + i1) / 2 * du
        cym = (j0 + j1) / 2 * dv
        charts.append(dict(local=int(c), U0=i0 * du, V0=j0 * dv, Wm=(i1 - i0) * du, Hm=(j1 - j0) * dv,
                           type=p.ftype(cxm, cym)))
    return dict(pos=pos, U=Uf, V=Vf, tris=tris, tchart=tchart, charts=charts, name=p.name)


def pack(charts, ppm, pages):
    """Shelf-pack charts (in order) into pages. Returns placements or None if overflow."""
    pl = []
    page, x, y, rowh = 0, PAD, PAD, 0
    for c in charts:
        w = int(math.ceil(c["Wm"] * ppm)) + 1
        hh = int(math.ceil(c["Hm"] * ppm)) + 1
        if w + 2 * PAD > PAGE or hh + 2 * PAD > PAGE:
            return None
        if x + w + PAD > PAGE:
            x, y, rowh = PAD, y + rowh + PAD, 0
        if y + hh + PAD > PAGE:
            page, x, y, rowh = page + 1, PAD, PAD, 0
            if page >= pages:
                return None
        pl.append((page, x, y, w, hh))
        x += w + PAD
        rowh = max(rowh, hh)
    return pl


def fmt_write(f, prefix_fmt, arr, chunk=400000):
    n = arr.shape[0]
    for s in range(0, n, chunk):
        a = arr[s:s + chunk]
        f.write((prefix_fmt * a.shape[0]) % tuple(a.ravel().tolist()))


def tex_job(args):
    pages_json, i, out = args
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "texgen.py"), pages_json, str(i), out], check=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tris", type=int, required=True)
    ap.add_argument("--pages", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-textures", action="store_true")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    t0 = time.time()
    patches = build_patches()
    area = sum(p.W * p.H for p in patches)
    h = math.sqrt(2 * area / a.tris)
    for _ in range(3):
        cells = count_cells(patches, h)
        h *= math.sqrt(2 * cells / a.tris)
    print(f"param area {area:.0f} m2, cell size h={h * 100:.2f} cm, est tris {2 * count_cells(patches, h)}", flush=True)

    tess = [tessellate(p, h) for p in patches]
    allc = []
    for ti, t in enumerate(tess):
        for c in t["charts"]:
            c["patch"] = ti
            allc.append(c)
    tot_area = sum(c["Wm"] * c["Hm"] for c in allc)
    lo, hi = 10.0, math.sqrt(a.pages * PAGE * PAGE / tot_area) * 1.2
    for _ in range(30):
        mid = (lo + hi) / 2
        if pack(allc, mid, a.pages) is None:
            hi = mid
        else:
            lo = mid
    ppm = lo
    pl = pack(allc, ppm, a.pages)
    for c, q in zip(allc, pl):
        c["page"], c["x0"], c["y0"], c["wpx"], c["hpx"] = q
    used_px = sum(c["wpx"] * c["hpx"] for c in allc)
    npages = max(c["page"] for c in allc) + 1
    print(f"charts {len(allc)}, texel density {ppm:.0f} px/m ({1000 / ppm:.1f} mm/px), pages {npages}, "
          f"atlas fill {used_px / (npages * PAGE * PAGE) * 100:.1f}%  [{time.time() - t0:.1f}s]", flush=True)

    # global arrays
    vblocks, vtblocks, fpage = [], [], [[] for _ in range(npages)]
    voff, vtoff = 0, 0
    ci = 0
    for t in tess:
        nchart = len(t["charts"])
        loc2idx = {c["local"]: ci + k for k, c in enumerate(t["charts"])}
        used, vinv = np.unique(t["tris"].ravel(), return_inverse=True)
        gv = (vinv.reshape(-1, 3) + voff).astype(np.int64)
        vblocks.append(t["pos"][used])
        voff += len(used)
        nv = t["pos"].shape[0]
        key = t["tchart"][:, None].astype(np.int64) * nv + t["tris"]
        ukey, kinv = np.unique(key.ravel(), return_inverse=True)
        gvt = (kinv.reshape(-1, 3) + vtoff).astype(np.int64)
        kc = (ukey // nv).astype(np.int64)
        kv = (ukey % nv).astype(np.int64)
        # per-chart params
        lc = np.array([c["local"] for c in t["charts"]])
        cidx = np.searchsorted(lc, kc)
        U0 = np.array([c["U0"] for c in t["charts"]])[cidx]
        V0 = np.array([c["V0"] for c in t["charts"]])[cidx]
        X0 = np.array([allc[loc2idx[c["local"]]]["x0"] for c in t["charts"]])[cidx]
        Y0 = np.array([allc[loc2idx[c["local"]]]["y0"] for c in t["charts"]])[cidx]
        px = X0 + (t["U"][kv] - U0) * ppm + 0.5
        py = Y0 + (t["V"][kv] - V0) * ppm + 0.5
        vtblocks.append(np.stack([px / PAGE, 1.0 - py / PAGE], 1))
        vtoff += len(ukey)
        tpage = np.array([allc[loc2idx[c["local"]]]["page"] for c in t["charts"]])[np.searchsorted(lc, t["tchart"])]
        for pg in np.unique(tpage):
            m = tpage == pg
            fpage[pg].append(np.stack([gv[m, 0], gvt[m, 0], gv[m, 1], gvt[m, 1], gv[m, 2], gvt[m, 2]], 1) + 1)
        ci += nchart
        t.clear()
    del tess
    Vall = np.concatenate(vblocks)
    VTall = np.concatenate(vtblocks)
    ntri = sum(sum(len(b) for b in fp) for fp in fpage)
    print(f"v {len(Vall)}, vt {len(VTall)}, f {ntri}  [{time.time() - t0:.1f}s]", flush=True)

    # georef: put SRSOrigin near Amersfoort NL, in UTM 31N (EPSG:32631)
    E, N = utm(52.1561, 5.3878)
    E, N = round(E, 3), round(N, 3)
    blk = os.path.join(a.out, "terra_obj", "Block")
    os.makedirs(blk, exist_ok=True)
    with open(os.path.join(a.out, "terra_obj", "metadata.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<ModelMetadata version="1">\n'
                '\t<!--Spatial Reference System-->\n\t<SRS>EPSG:32631</SRS>\n'
                '\t<!--Origin in Spatial Reference System-->\n'
                f'\t<SRSOrigin>{E:.3f},{N:.3f},{4.0:.3f}</SRSOrigin>\n'
                '\t<Texture>\n\t\t<ColorSource>Visible</ColorSource>\n\t</Texture>\n</ModelMetadata>\n')
    with open(os.path.join(blk, "Block.mtl"), "w") as f:
        for i in range(npages):
            f.write(f"newmtl Block_{i}\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 1\nmap_Kd Block_{i}.jpg\n\n")
    with open(os.path.join(blk, "Block.obj"), "w", buffering=1 << 24) as f:
        f.write(f"# synthetic DJI-Terra-like export\n# vertices {len(Vall)} faces {ntri}\nmtllib Block.mtl\n")
        fmt_write(f, "v %.6f %.6f %.6f\n", Vall)
        fmt_write(f, "vt %.6f %.6f\n", VTall)
        for pg in range(npages):
            f.write(f"usemtl Block_{pg}\n")
            for b in fpage[pg]:
                fmt_write(f, "f %d/%d %d/%d %d/%d\n", b)
    print(f"obj written {os.path.getsize(os.path.join(blk, 'Block.obj')) / 1e6:.0f} MB  [{time.time() - t0:.1f}s]", flush=True)

    # pages description (for texture gen + later masking experiments)
    pages = [[] for _ in range(npages)]
    for c in allc:
        pages[c["page"]].append((c["x0"], c["y0"], c["wpx"], c["hpx"], c["type"]))
    pj = os.path.join(a.out, "pages.json")
    json.dump(pages, open(pj, "w"))
    json.dump(dict(tris=ntri, verts=int(len(Vall)), uvs=int(len(VTall)), charts=len(allc), pages=npages,
                   cell_cm=h * 100, ppm=ppm, fill=used_px / (npages * PAGE * PAGE), srs_origin=[E, N, 4.0]),
              open(os.path.join(a.out, "gen_stats.json"), "w"), indent=1)
    del Vall, VTall, fpage
    if not a.no_textures:
        with Pool(a.jobs) as pool:
            jobs = [(pj, i, os.path.join(blk, f"Block_{i}.jpg")) for i in range(npages)]
            for _ in pool.imap_unordered(tex_job, jobs):
                pass
        sizes = [os.path.getsize(os.path.join(blk, f"Block_{i}.jpg")) for i in range(npages)]
        print(f"textures: {npages} x 4096^2, JPEG min/mean/max {min(sizes) / 1e6:.2f}/{np.mean(sizes) / 1e6:.2f}/"
              f"{max(sizes) / 1e6:.2f} MB  [{time.time() - t0:.1f}s]", flush=True)


if __name__ == "__main__":
    main()
