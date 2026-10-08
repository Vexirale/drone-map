"""Reference prefill: model footprint (UTM31N) -> cadastral parcel(s) -> crop polygon in model-local metres.

Usage: python -I prefill_demo.py <grid_dir> <originE> <originN> <halfsize_m> [address]
Simulates a DJI Terra model whose metadata.xml says SRS=EPSG:32631 and SRSOrigin=originE,originN,0
and whose mesh spans +-halfsize_m around the origin. Never raises on network trouble: returns None.
"""
import json, sys, time, urllib.parse, urllib.request
import pyproj
from pyproj.transformer import TransformerGroup
from shapely.geometry import shape, Point, box, mapping
from shapely.ops import unary_union, transform as shp_transform

OGC = "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/{c}/items"
BAG = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items"
LOC = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
RD = "http://www.opengis.net/def/crs/EPSG/0/28992"


def get(url, params, timeout=10):
    q = url + "?" + urllib.parse.urlencode(params)
    t0 = time.time()
    with urllib.request.urlopen(q, timeout=timeout) as r:
        d = json.load(r)
    return d, time.time() - t0


def main():
    grid_dir, oe, on, half = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    address = sys.argv[5] if len(sys.argv) > 5 else None
    pyproj.network.set_network_enabled(False)
    pyproj.datadir.append_data_dir(grid_dir)
    # Treat EPSG:32631 from network-RTK as ETRS89 (EPSG:25831); use the RDNAPTRANS2018 grid.
    tg = TransformerGroup("EPSG:25831", "EPSG:28992", always_xy=True)
    fwd = next(t for t in tg.transformers if "(9)" in t.description)
    inv = next(t for t in TransformerGroup("EPSG:28992", "EPSG:25831", always_xy=True).transformers if "(9)" in t.description)

    foot_utm = box(oe - half, on - half, oe + half, on + half)
    foot_rd = shp_transform(lambda x, y, z=None: fwd.transform(x, y), foot_utm)
    minx, miny, maxx, maxy = foot_rd.bounds
    bbox = f"{minx:.2f},{miny:.2f},{maxx:.2f},{maxy:.2f}"

    parcels, t_p = get(OGC.format(c="perceel"), {"f": "json", "limit": 1000, "bbox": bbox, "bbox-crs": RD, "crs": RD})
    panden, t_b = get(BAG, {"f": "json", "limit": 1000, "bbox": bbox, "bbox-crs": RD, "crs": RD})
    print(f"parcels in footprint: {len(parcels['features'])} ({t_p:.2f}s); BAG panden: {len(panden['features'])} ({t_b:.2f}s)")

    seed, how = None, None
    if address:
        loc, t_l = get(LOC, {"q": address, "fq": "type:adres", "rows": 1, "fl": "weergavenaam,centroide_rd,gekoppeld_perceel"})
        docs = loc["response"]["docs"]
        if docs:
            wkt = docs[0]["centroide_rd"]  # POINT(x y)
            x, y = map(float, wkt[wkt.index("(") + 1:-1].split())
            seed, how = Point(x, y), f"address '{docs[0]['weergavenaam']}' gekoppeld_perceel={docs[0].get('gekoppeld_perceel')} ({t_l:.2f}s)"
    if seed is None:
        centre = foot_rd.centroid
        live = [shape(f["geometry"]) for f in panden["features"] if f["properties"].get("status") not in ("Pand gesloopt", "Bouwvergunning verleend", "Niet gerealiseerd pand")]
        live = [g for g in live if g.intersects(foot_rd)]
        if live:
            main_b = min(live, key=lambda g: g.centroid.distance(centre) / max(g.area, 1) ** 0.5)
            seed, how = main_b.representative_point(), "main BAG pand nearest model centre"
        else:
            seed, how = centre, "model centre"
    hits = [f for f in parcels["features"] if shape(f["geometry"]).contains(seed)]
    if not hits:
        print("no parcel found -> no prefill (operator draws manually)")
        return None
    p = hits[0]
    pr = p["properties"]
    geom_rd = shape(p["geometry"])
    print(f"seed via {how}: parcel {pr['akr_kadastrale_gemeente_code_waarde']}-{pr['sectie']}-{pr['perceelnummer']} "
          f"registered {pr['kadastrale_grootte_waarde']} m2 ({pr['soort_grootte_waarde']}), geom area {geom_rd.area:.0f} m2")
    geom_utm = shp_transform(lambda x, y, z=None: inv.transform(x, y), geom_rd)
    local = shp_transform(lambda x, y, z=None: (x - oe, y - on), geom_utm)
    local = local.intersection(box(-half, -half, half, half)).simplify(0.05)
    n = sum(len(g.exterior.coords) for g in getattr(local, "geoms", [local]))
    print(f"crop polygon in model-local metres: {local.geom_type}, {n} vertices, bounds {[round(b, 2) for b in local.bounds]}")
    return mapping(local)


if __name__ == "__main__":
    main()
