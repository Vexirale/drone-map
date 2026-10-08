import os, sys, math
os.environ["PROJ_DATA"] = ""  # set below via pyproj.datadir
import pyproj
from pyproj import CRS, Transformer
from pyproj.transformer import TransformerGroup
pyproj.network.set_network_enabled(False)
grid_dir = sys.argv[1]
pyproj.datadir.append_data_dir(grid_dir)

pts = {"Eindhoven (lat 51.4416, lon 5.4697)": (5.4697, 51.4416),
       "Groningen (53.2194, 6.5665)": (6.5665, 53.2194),
       "Middelburg (51.4988, 3.6136)": (3.6136, 51.4988),
       "Maastricht (50.8514, 5.6910)": (5.6910, 50.8514)}

tg = TransformerGroup("EPSG:4258", "EPSG:28992", always_xy=True)
print("ETRS89 -> RD candidates now (grid dir appended):")
for t in tg.transformers: print("  acc=%s %s" % (t.accuracy, t.description))
grid_t = [t for t in tg.transformers if "(9)" in t.description][0]
h7_t = [t for t in tg.transformers if "(8)" in t.description][0]
print("grid pipeline:", grid_t.definition)
print("7p pipeline  :", h7_t.definition)

# classic proj4 string with towgs84 (used by proj4js / epsg.io)
p4 = "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs"
t_p4 = Transformer.from_crs("EPSG:4326", CRS.from_proj4(p4), always_xy=True)
# old epsg.io-style towgs84 (pre-2019 PROJ)
p4old = "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.237,50.0087,465.658,-0.406857,0.350733,-1.87035,4.0812 +units=m +no_defs"
t_p4old = Transformer.from_crs("EPSG:4326", CRS.from_proj4(p4old), always_xy=True)
print()
for name,(lon,lat) in pts.items():
    gx,gy = grid_t.transform(lon,lat)
    hx,hy = h7_t.transform(lon,lat)
    px,py = t_p4.transform(lon,lat)
    ox,oy = t_p4old.transform(lon,lat)
    print(f"{name}: grid(RDNAPTRANS2018)= {gx:.3f},{gy:.3f}")
    print(f"   EPSG 7-param (8) diff = {math.hypot(hx-gx,hy-gy):.3f} m")
    print(f"   proj4 towgs84 (EPSG:15739 values) diff = {math.hypot(px-gx,py-gy):.3f} m")
    print(f"   proj4 old towgs84 (565.237..) diff = {math.hypot(ox-gx,oy-gy):.3f} m")

# UTM31N -> RD via pipeline treating UTM as ETRS89 (EPSG:25831) with grid
lon,lat = 5.4697, 51.4416
u = Transformer.from_crs("EPSG:4258","EPSG:25831",always_xy=True).transform(lon,lat)
print("\nEindhoven point in UTM31N:", u)
tg2 = TransformerGroup("EPSG:25831","EPSG:28992",always_xy=True)
for t in tg2.transformers:
    x,y = t.transform(*u); print("  25831->28992", t.description, "=> %.3f,%.3f"%(x,y))
tg3 = TransformerGroup("EPSG:32631","EPSG:28992",always_xy=True)
for t in tg3.transformers:
    x,y = t.transform(*u); print("  32631->28992", t.description, "=> %.3f,%.3f"%(x,y))
# The RD x=161000,y=383000 point in WGS84
inv = Transformer.from_crs("EPSG:28992","EPSG:4258",always_xy=True)
print("\nRD 161000,383000 -> ETRS89 lon/lat:", inv.transform(161000,383000))
print("lat 51.4416 lon 5.4697 -> RD (grid):", grid_t.transform(5.4697,51.4416))
