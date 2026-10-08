"""Synthetic photogrammetry-atlas texture generator.

Produces a 4096x4096 JPEG (q90) whose content compresses roughly like an aerial-photo
texture atlas: chart islands on a black background, filled with multi-octave smooth
noise, per-surface base colours, simple man-made structure (roof tiles, paving, bricks,
planks) and luminance grain. Not meant to look good, only to have realistic entropy.
"""
import json
import sys

import numpy as np
from PIL import Image

S = 4096

# type id -> (name, base RGB)
TYPES = {
    1: ("lawn", (86, 118, 52)),
    2: ("driveway", (128, 124, 118)),
    3: ("patio", (150, 140, 128)),
    4: ("soil", (104, 82, 60)),
    5: ("roof", (128, 62, 46)),
    6: ("wall", (150, 85, 65)),
    7: ("tree", (52, 78, 38)),
    8: ("hedge", (44, 70, 34)),
    9: ("shed", (110, 84, 58)),
    10: ("trunk", (90, 72, 55)),
    11: ("flatroof", (64, 64, 66)),
}
NAME2ID = {v[0]: k for k, v in TYPES.items()}

GRAIN = float(__import__("os").environ.get("GRAIN", 1.5))  # luminance grain sigma (tuned so pages land at ~2-4 MB)
EDGE_F = float(__import__("os").environ.get("EDGE_F", 0.88))  # darkening factor of edge blobs
GRAIN2 = float(__import__("os").environ.get("GRAIN2", 1.5))  # 2px-correlated grain sigma


def octave(rng, n, size=S):
    small = rng.random((n, n), dtype=np.float32)
    return np.asarray(Image.fromarray(small, "F").resize((size, size), Image.BICUBIC))


def make_page(rects, seed, out_path, quality=90):
    rng = np.random.default_rng(seed)
    tmap = np.zeros((S, S), np.uint8)
    for (x, y, w, h, t) in rects:
        tid = NAME2ID[t] if isinstance(t, str) else int(t)
        tmap[max(0, y - 2):min(S, y + h + 2), max(0, x - 2):min(S, x + w + 2)] = tid

    lut = np.zeros((16, 3), np.float32)
    for k, (_, rgb) in TYPES.items():
        lut[k] = rgb
    base = lut[tmap]  # (S,S,3)

    # multi-octave smooth noise (brightness)
    L = (0.50 * octave(rng, 6) + 0.35 * octave(rng, 24) + 0.25 * octave(rng, 96)
         + 0.18 * octave(rng, 384) + 0.12 * octave(rng, 1536))
    L -= L.mean()
    L *= 0.18 / (L.std() + 1e-6)
    bright = 1.0 + L
    # colour variation (shift between R/G)
    C = octave(rng, 16) - 0.5

    yy, xx = np.indices((S, S), dtype=np.int32)
    pat = np.ones((S, S), np.float32)
    # roof tiles: rows every 14px, joints every 20px offset per row
    row = yy // 14
    roof_j = ((yy % 14) < 2) | (((xx + (row % 2) * 10) % 20) < 2)
    pat = np.where((tmap == 5) & roof_j, 0.62, pat)
    # paving: 24px grid
    pav_j = ((yy % 24) < 2) | ((xx % 24) < 2)
    pat = np.where(((tmap == 2) | (tmap == 3)) & pav_j, 0.72, pat)
    # bricks: 8px rows, 22px bricks
    brow = yy // 8
    brick_j = ((yy % 8) < 1) | (((xx + (brow % 2) * 11) % 22) < 1)
    pat = np.where((tmap == 6) & brick_j, 0.8, pat)
    # planks
    pat = np.where((tmap == 9) & ((xx % 16) < 1), 0.7, pat)
    del yy, xx, row, roof_j, pav_j, brow, brick_j

    # vegetation: leaf clumps / shadows
    veg = (tmap == 7) | (tmap == 8) | (tmap == 1)
    clump = octave(rng, 700) - 0.5
    pat = np.where(veg, pat * (1.0 + np.where(tmap == 1, 0.25, 0.7) * clump), pat)
    del clump

    # sharp-edged structure at several scales (leaf clusters, shadows, stones, small objects);
    # makes the spectrum closer to real aerial photos so that downscaled WebP sizes are not underestimated
    for n, thr, fac in ((256, 0.60, EDGE_F), (768, 0.60, EDGE_F), (1536, 0.62, EDGE_F)):
        e = octave(rng, n) > thr
        pat = np.where(e, pat * fac, pat)
        del e

    img = base * (bright * pat)[..., None]
    img[..., 0] *= (1.0 + 0.25 * C)
    img[..., 1] *= (1.0 - 0.15 * C)
    del C, L, bright, pat
    # luminance grain: iid + 2px correlated
    g = rng.standard_normal((S, S), dtype=np.float32) * GRAIN
    g2 = rng.standard_normal((S // 2, S // 2), dtype=np.float32) * GRAIN2
    g += np.asarray(Image.fromarray(g2, "F").resize((S, S), Image.BILINEAR))
    g = np.where(veg, g * 1.3, g)
    img += g[..., None]
    del g, g2
    img[tmap == 0] = 0.0
    np.clip(img, 0, 255, out=img)
    Image.fromarray(img.astype(np.uint8), "RGB").save(out_path, "JPEG", quality=quality)
    return out_path


if __name__ == "__main__":
    # usage: texgen.py pages.json page_index out.jpg  (or 'test' out.jpg for a full-coverage test page)
    if sys.argv[1] == "test":
        rng = np.random.default_rng(1)
        rects = []
        y = 4
        names = list(NAME2ID.keys())
        while y < S - 600:
            x = 4
            h = int(rng.integers(380, 560))
            while x < S - 600:
                w = int(rng.integers(380, 560))
                rects.append((x, y, w, h, names[int(rng.integers(0, len(names)))]))
                x += w + 6
            y += h + 6
        make_page(rects, 7, sys.argv[2])
    else:
        pages = json.load(open(sys.argv[1]))
        i = int(sys.argv[2])
        make_page(pages[i], 1000 + i, sys.argv[3])
