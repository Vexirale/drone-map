# Measurements: how every number is calculated

Status: the design for M4 (phase 2), fixed before building so quotes can be trusted and checked. The inputs it needs are stored from the first upload in M1. This document describes algorithm version **`measure-1`**. A change to any method or parameter below is a new version (section 9). The code in `packages/shared` follows this document, not the other way around.

`bench/measurements/worked-example.ts` implements this document on a synthetic property with known dimensions. Run it with `node bench/measurements/worked-example.ts`, which takes about a minute. It produces the worked example in section 7, checks every method against the exact geometry and checks every uncertainty formula by Monte Carlo. M4 ports it to `packages/shared` with the same tests.

## 1. Principles

- **Traceable.** Every value can be traced back to its picked points, the model file (by SHA-256), the method, the algorithm version and its parameters. Staff see all of it in the "Hoe berekend?" panel.
- **Frozen once issued.** A measurement is a list of revisions that are never changed. Quotes, reports and customer pages refer to one revision and keep a copy of what they showed. A better algorithm only changes old numbers when an operator recalculates, and then as a new revision; issued documents keep their values.
- **No unbacked accuracy.** A ± is only shown when it follows from the model's measured resolution or from real control measurements (section 6). Otherwise the value is shown without one.
- **Dutch formatting** everywhere, with `Intl.NumberFormat('nl-NL')`: `12,4 m²`, `3,25 m`, `45,0°`, thousands with a dot (`1.234,5 m²`). Coordinates are shown without a thousands separator (`671842,32`), as Dutch surveyors write them.

## 2. Frame and coordinates

**Local metric frame.** All math runs in the job-local frame: metres east (E), north (N) and up (U), equal to the model's projected coordinates minus the job origin (`docs/architecture.md` §8). The origin is stored in double precision, so the original coordinates of every point are exact: `X = E + origin.E`, `Y = N + origin.N`, `Z = U + origin.U`.

**Projection scale.** DJI Terra exports in a projected system, usually WGS 84 / UTM 31N, or RD New. A projection scales horizontal distances by a factor k that depends only on the location; heights are not scaled. The worker computes k at the job origin with PROJ and stores it as `jobs.projection_scale`. Within a property k varies by less than 0.4 ppm, so one value per job is enough. Values from PROJ 9.8.1 (pyproj 3.8.0), checked against the closed-form series:

| Place                                                   | System                         |          k − 1 |       10 m edge |    100 m² area |
| ------------------------------------------------------- | ------------------------------ | -------------: | --------------: | -------------: |
| Eindhoven                                               | UTM 31N (EPSG:32631 and 25831) |        −38 ppm |         −0,4 mm |        −77 cm² |
| Eindhoven                                               | RD New (EPSG:28992)            |        −53 ppm |         −0,5 mm |       −106 cm² |
| Eindhoven                                               | UTM 32N (wrong zone)           |       +339 ppm |         +3,4 mm |       +678 cm² |
| Vlissingen                                              | UTM 31N                        |       −380 ppm |         −3,8 mm |       −761 cm² |
| Den Helder                                              | UTM 31N                        |       −228 ppm |         −2,3 mm |       −457 cm² |
| Maastricht                                              | UTM 31N                        |        +41 ppm |         +0,4 mm |        +81 cm² |
| Groningen                                               | UTM 32N                        |        −76 ppm |         −0,8 mm |       −152 cm² |
| Enschede                                                | UTM 32N                        |       −146 ppm |         −1,5 mm |       −292 cm² |
| Groningen, Maastricht, Vlissingen, Enschede, Den Helder | RD New                         | −32 to +43 ppm | −0,3 to +0,4 mm | −64 to +85 cm² |

Two smaller effects come on top. Projected coordinates describe the ellipsoid surface, and Dutch ground lies about 35 to 80 m above it (NAP height plus 41 to 46 m of geoid, NLGEO2018), so ground distances come out a further 5 to 13 ppm short (at most 0,13 mm per 10 m). And because only E and N carry k, a 45° roof face changes its slope length by (k − 1)/2 and its pitch by at most about 0,01° (0,001° at Eindhoven).

**Conclusion: at roof scale this does not matter.** The worst case in the Netherlands is 4 mm on a 10 m edge and 0,08 m² on 100 m², while the model's own accuracy is at centimetre level (moving the edges of a 10 × 10 m area by 1 cm already changes it by 0,4 m²). The factor also affects the before and after scan of a job equally. `measure-1` therefore does not correct for it, and the panel shows k. Over a whole 100 m property it can reach 4 cm in Zeeland (0,04 %); if that ever matters, a new version can divide E and N by `projection_scale`.

**Geographic input.** A model in degrees (for example WGS 84 latitude/longitude) is reprojected with PROJ to the job's projected system before anything else: the UTM zone of the job origin (31N west of 6° E, 32N east of it) when it is the job's first scan, otherwise the system of the first scan. Its error is then the k above. A local east-north-up frame would be exact for distances, but it would put one job in two frames, and the operator's alignment nudge cannot remove the resulting scale difference. Degrees are never converted with a fixed number of metres per degree: with a sphere of 6371 km, distances at Eindhoven would come out 3 cm per 10 m short from east to west.

**Up axis.** Terra and the stored data are Z-up. Only three.js uses Y-up, and the conversion exists in exactly one function (`enuToThree`).

**Heights and NAP.** A height is a difference in U between two points, which needs no datum. An absolute height is shown as NAP only when the vertical datum is known:

- the model's heights are already NAP (vertical CRS EPSG:5709, or a compound system with it): NAP = U + origin.U;
- the heights are ellipsoidal (ETRS89/WGS 84): NAP = ellipsoidal height − N, with the geoid height N from the official NLGEO2018 model (RDNAPTRANS2018, grid `nl_nsgi_nlgeo2018.tif`, bundled with the RD grid; about 41 to 46 m in the Netherlands). N changes by at most a few millimetres across a property, so it is stored once per job (`jobs.nap_offset`);
- otherwise (unknown vertical datum, or outside the Netherlands): relative heights only, and the panel says why.

Absolute NAP heights depend on the RTK fix and the geoid model, not on the model's resolution, so they are shown without a ± (section 6 only covers relative values).

## 3. Picking and re-projection

The browser shows the light mesh (`web.glb`, about 500k triangles), so points are picked there for speed. The final values are computed on the server on `work.glb`, the full-detail mesh (PLAN.md decision 11).

1. For every picked point the browser stores the **view ray**: origin = camera position, direction = the unit vector from the camera through the picked point, both in the local frame. In the 2D orthophoto view the ray is vertical (from 1000 m above, pointing down).
2. `measurement.compute` intersects each ray with `work.glb` (BVH, Möller-Trumbore, no back-face culling, first hit) and uses that point.
3. Both points are stored with their distance `d`. If `d > max(10 cm, 2σ)` (σ from section 6), the point is **flagged**: the light and the full mesh disagree there (the ray grazes an edge, a thin branch, a hole), and the operator checks it before the measurement can be used in a quote. 2σ keeps a shift within a point's own ± unflagged; the 10 cm floor comes from the synthetic study in section 7.6 (it flags 0,6 % of random picks) and is re-measured on the first real `web.glb`/`work.glb` pair.
4. If the ray misses `work.glb` entirely (a hole in the full mesh), the closest point of `work.glb` to the picked point is used and the point is flagged.

## 4. Methods

Notation: points `p_i = (E, N, U)` in metres; `|v|` is the length of a vector.

### 4.1 Distance and length

- Distance: the straight 3D distance between two points, `d = |p_2 − p_1|`.
- Length: the sum of the 3D segment lengths of a polyline, `L = Σ_i |p_(i+1) − p_i|`.

### 4.2 Height

The vertical difference between two points, `h = U_2 − U_1`. It is stored signed and shown as a positive number with "hoger" or "lager". With a known vertical datum both NAP heights are shown too (section 2).

### 4.3 Area on a roof face, and the pitch

The operator draws a polygon on a roof face.

1. **Provisional plane** through the polygon's points (total least squares, as in step 3; exact for three points).
2. **Vertex selection.** A vertex of `work.glb` is used when its projection onto the plane lies inside the polygon, at least 0,25 m (the edge margin) from the polygon's edges, and its distance to the plane is at most 0,30 m (the band). The band keeps walls, gutters below the eaves and trees out of the fit. The margin keeps the neighbouring face and the gable walls out at ridges and rakes: without it, the synthetic 45° face fits with an RMS of 6,5 cm and a pitch of 44,3°; with it, 3 mm and 45,000°. Fewer than 10 vertices is an error.
3. **Plane fit (total least squares).** Centroid `c` of the selected vertices; covariance `C = (1/n) Σ (q_j − c)(q_j − c)ᵀ`; the normal `n` is the eigenvector of the smallest eigenvalue of `C` (Jacobi), turned so it points up (`n_U ≥ 0`).
4. **Refit once:** select again with the fitted plane (step 2) and fit again (step 3).
5. **Flatness:** `RMS = sqrt((1/n) Σ ((q_j − c) · n)²)`, the root mean square distance of the selected vertices to the plane.
6. **Area along the slope.** Project the polygon onto the plane and express it in an orthonormal in-plane basis: `e1 = (Z × n)/|Z × n|` (horizontal, along the face) and `e2 = n × e1` (up the slope). Then the shoelace formula on the 2D coordinates `(x_i, y_i)`: `A_slope = ½ |Σ_i (x_i · y_(i+1) − x_(i+1) · y_i)|`.
7. **Area from above:** the shoelace formula on the E/N coordinates of the plane-projected polygon. For a plane, `A_plan = A_slope · cos θ`.
8. **Pitch:** `θ = atan2(sqrt(n_E² + n_N²), n_U)` in degrees, the angle between the normal and vertical (numerically better than `arccos(n_U)` near 0°).
9. **Not flat.** If the RMS is above 5 cm, the surface is not one plane (a dormer, a chimney, two faces, a bulging net). Then the area along the slope is replaced by the mesh surface area clipped to the polygon (4.5), with the prism along the fitted normal and only the mesh within the band of the plane counted. The panel and the customer text say so ("niet vlak: oppervlakte van het 3D-model binnen de vorm"). The pitch is still shown, marked as an average.

### 4.4 Area on the ground (tuin, oprit)

1. **Surface area:** the mesh surface area of `work.glb` clipped to the vertical prism over the polygon (4.5), counting only mesh between the lowest picked point minus 1 m and the highest plus 1 m. Without that slab, a tree crown, a roof overhang or a facade inside the prism would count: a 6 × 3 m polygon drawn 2 cm into a house facade (18,1 m² from above) gave 54,2 m² without the slab and 24,0 m² with it, the rest being 6 m² of facade strip that the steep-part line below makes visible.
2. **Area from above:** the shoelace formula on the E/N coordinates of the polygon's points.
3. Pieces whose normal is more than 60° from vertical (kerbs, low walls, the facade above) are summed separately and shown as "waarvan X m² steile vlakken", so a mistake like the one above is visible at once.

Both areas are shown, labeled. Ground work is normally quoted by the area from above (what a lawn treatment or a roll of mesh covers); the quote mapping chooses which one.

### 4.5 Mesh surface area clipped to a polygon

The polygon is cut into triangles by ear clipping (any simple polygon, concave or not, either winding; collinear vertices are dropped; a self-intersecting polygon is refused). Every mesh triangle near the polygon is tested against the prism of each polygon triangle, whose three side planes run along the prism axis (the plane normal for a roof face, vertical for the ground):

- completely inside: its full area counts;
- completely outside one side plane: it is skipped;
- otherwise it is clipped in 3D with Sutherland-Hodgman, one side plane at a time, and the area of the clipped piece counts.

Clipping in 3D, instead of projecting to 2D and dividing by the cosine of the slope, counts vertical faces correctly: a 30 cm kerb inside a ground polygon adds its real 0,9 m², where a projection would divide by zero.

## 5. Effective resolution

The resolution says how much detail the model holds, and sets the point uncertainty.

- **Texel size (always available).** For every textured triangle of `work.glb`, `t = sqrt(A_3D / (A_UV · W · H))`, with `A_3D` its area in m², `A_UV` its area in texture coordinates and `W × H` the size of its texture page in pixels. The resolution is the area-weighted median of `t`: the smallest t such that triangles at or below it cover half the surface. Computed once at import (M1) and stored with the scan. On the synthetic test mesh (roof 0,8 cm, ground 1,0 cm, a blurry wall 2,0 cm) it gives 1,0 cm; the plain mean would give 1,34 cm and the unweighted median 0,8 cm.
- **GSD from the DJI Terra quality report,** when the export folder contains one, is preferred: it is what Terra measured on the photos. The scan records which one was used.

## 6. Uncertainty

### 6.1 Point uncertainty

`σ = 2 × resolution`, the same for each axis. Pix4D states that a correctly reconstructed model has a relative accuracy of 1 to 3 GSD (and an absolute one of 1 to 2 GSD horizontally, 1 to 3 vertically). Measurements inside one model depend on the relative accuracy, so 2 is the middle of that range. With a 1 cm resolution, σ = 2 cm and a single point is good to about ± 4 cm. That is an estimate. Control measurements (6.4) replace it once there are enough.

### 6.2 Propagation to every value

With independent point errors of σ per axis:

| Value                                     | σ                                                                         | Note                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distance                                  | `σ · √2`                                                                  | the error along the line of each end point                                                                                                                                                                                                    |
| Length                                    | `σ · sqrt(Σ_i \|g_i\|²)`, `g_i = u_(i−1) − u_i`                           | `u_i` is the unit direction of segment i; an end point has one term                                                                                                                                                                           |
| Height                                    | `σ · √2`                                                                  | the vertical errors of both points                                                                                                                                                                                                            |
| Area along the slope                      | `σ/2 · sqrt(Σ_i \|v_(i+1) − v_(i−1)\|²)`                                  | in the plane's 2D coordinates; for a rectangle this is `σ ·` its diagonal                                                                                                                                                                     |
| Area from above                           | the same formula on the E/N coordinates                                   | conservative on a sloped face (the full-method Monte Carlo spread is 0,75 of it at 45°)                                                                                                                                                       |
| Mesh surface area (ground, not-flat roof) | `σ · sqrt(Σ_i ((∂S/∂x_i)² + (∂S/∂y_i)²))`                                 | derivatives of the clipped area by central differences (1 mm) for both in-plane axes of every polygon point; equals the polygon formula on flat ground and follows kerbs and bumps                                                            |
| Pitch                                     | `max(σ_v / sqrt(Σ_j ((q_j − c) · e2)²), √2 · σ / D)`, `σ_v = max(RMS, σ)` | the first term is the plane fit with independent vertex errors; the second is two points σ apart at the ends of the face, with D the polygon's extent along the slope. Mesh errors are correlated, so the fit term alone would claim too much |

### 6.3 What is shown

- The ± shown is **2σ, rounded up** (about 95 % of normal errors): lengths and heights to whole cm, areas to 0,1 m², the pitch to 0,1°. Floating-point dust does not round up (2σ = 0,06000000000000001 m is shown as 6 cm).
- Values: lengths in m with 2 decimals, areas in m² with 1 decimal, the pitch in degrees with 1 decimal.
- The source is always stated: "op basis van de resolutie van het model (1,0 cm)" or "op basis van 14 controlemetingen".
- Without a resolution (no texture and no quality report) and without enough control measurements, no ± is shown at all.

### 6.4 Control measurements ("controlemetingen")

- The operator can enter a tape-measured value for any measurement value (a gutter length, a flat roof part, a driveway). Stored: the tape value, the model value of that revision, the deviation `model − tape`, the relative deviation, the instrument, and who and when.
- Settings show per kind (lengths and heights in cm; areas in %): the number of control measurements, the average signed deviation (a scale problem shows up here), and the average and maximum absolute deviation.
- **Switch-over:** from 10 control measurements of a kind on (a setting), the ± shown for that kind comes from them: `± = 2 · RMS(deviation)` in cm for lengths and heights, and `± = 2 · RMS(relative deviation) · value` for areas. The resolution estimate is then no longer used for that kind.
- The ± and its source are stored in each revision when it is computed, so a later control measurement does not change an issued number.

## 7. Worked example

The output of `node bench/measurements/worked-example.ts`, shortened. The property is synthetic, so every exact value is known.

### 7.1 Job and scan

- House 10,00 m (east) × 8,00 m (north), eaves at 6,00 m, ridge at 10,00 m along east: two 45° faces with a 4,00 m run. Also a 30° lean-to shed, a 6 × 3 m driveway, a terrace raised 0,30 m (a kerb) and an 8 × 6 m lawn with mole hills (`U = 0,12 · sin(2πx/3) · sin(2πy/3)`).
- Full mesh (`work.glb` stand-in): 0,25 m grid, 46.360 triangles, 3 mm vertex noise. Light mesh (`web.glb` stand-in): 1 m grid, 2.956 triangles.
- `metadata.xml` as Terra writes it: `<SRS>EPSG:32631</SRS>`, `<SRSOrigin>671842.3164090217,5702113.884057588,63.71899999957532</SRSOrigin>` (a made-up point in Eindhoven, 51,444° N 5,473° E). The first scan fixes the job origin, so local = OBJ coordinates and original = local + origin. Projection scale at the origin: k = 0,999962572 (−37 ppm). Vertical datum unknown, so only relative heights are shown.
- Resolution 1,00 cm, so σ = 2,00 cm per axis and the flag threshold is max(10 cm, 4 cm) = 10 cm.

### 7.2 Picks: from the light mesh to the full mesh

| Point | What           | Camera (E, N, U)           | Light-mesh hit             | Final point on the full mesh | Difference | Original (UTM 31N E, N, h)         |
| ----- | -------------- | -------------------------- | -------------------------- | ---------------------------- | ---------: | ---------------------------------- |
| P1    | eave corner SW | (−11,547; −11,547; 17,547) | (0,0010; 0,0010; 5,9990)   | (0,0012; 0,0012; 5,9988)     |     0,4 mm | 671842,3176; 5702113,8853; 69,7178 |
| P2    | eave corner SE | (21,547; −11,547; 17,547)  | (10,0039; −0,0039; 6,0039) | (10,0039; −0,0039; 6,0039)   |     0,0 mm | 671852,3203; 5702113,8801; 69,7229 |
| P3    | ridge end E    | (17,428; 4,000; 28,570)    | (9,9990; 4,0000; 9,9975)   | (9,9990; 4,0000; 9,9976)     |     0,1 mm | 671852,3154; 5702117,8841; 73,7166 |
| P4    | ridge end W    | (−7,428; 4,000; 28,570)    | (0,0030; 4,0000; 9,9926)   | (0,0029; 4,0000; 9,9926)     |     0,1 mm | 671842,3194; 5702117,8841; 73,7116 |
| P5    | eave corner NW | (−11,547; 19,547; 17,547)  | (−0,0007; 8,0007; 6,0007)  | (−0,0007; 8,0007; 6,0007)    |     0,0 mm | 671842,3157; 5702121,8848; 69,7197 |
| P6    | eave corner NE | (21,547; 19,547; 17,547)   | (9,9986; 7,9986; 5,9986)   | (9,9986; 7,9986; 5,9986)     |     0,0 mm | 671852,3150; 5702121,8827; 69,7176 |

The driveway (D1 to D4) and lawn (L1 to L4) picks behave the same (at most 0,3 mm difference). No point is flagged.

### 7.3 Distance, length, height

| Measurement                      | Calculation               | Value (exact)  | σ        | Shown                   |
| -------------------------------- | ------------------------- | -------------- | -------- | ----------------------- |
| Distance P1–P2 (eave)            | `\|P2 − P1\|`             | 10,0027 m (10) | 0,0283 m | `10,00 m ± 6 cm`        |
| Length P5–P1–P2–P6 (three eaves) | 7,9995 + 10,0027 + 8,0025 | 26,0048 m (26) | 0,0490 m | `26,00 m ± 10 cm`       |
| Height P1 to P4 (eave to ridge)  | 9,9926 − 5,9988           | 3,9939 m (4)   | 0,0283 m | `3,99 m ± 6 cm` (hoger) |

For the length, `Σ|g_i|² = 6,0008`, so σ = 0,020 · √6,0008 = 0,0490 m.

### 7.4 Roof face P1–P2–P3–P4

1. Provisional plane through the four picks: n = (−0,00054; −0,70643; 0,70778).
2. Selection: 763 vertices (band 0,30 m, edge margin 0,25 m); the refit selects the same 763.
3. Fitted plane: c = (5,0579; 1,9917; 7,9917), n = (0,000032; −0,707116; 0,707098); eigenvalues 8,84·10⁻⁶, 2,04 and 7,53.
4. Flatness: RMS 2,97 mm, below 5 cm, so the plane method applies.
5. Polygon in the plane: (−5,0568; −2,8165), (4,9459; −2,8168), (4,9412; 2,8383), (−5,0549; 2,8351). Shoelace: **area along the slope 56,5306 m²** (exact 56,5685).
6. The same polygon from above (E/N): **39,9727 m²** (exact 40). Ratio 1,41423 (√2 = 1,41421).
7. **Pitch 45,0007°** (exact 45).
8. Uncertainty, σ = 0,02 m:
   - area along the slope: `σ/2 · sqrt(Σ|v_(i+1) − v_(i−1)|²)` = 0,2297 m², so ± 0,5 m²;
   - area from above: 0,2154 m², so ± 0,5 m²;
   - pitch: the fit term is 0,02 / √1553,4 = 0,029°; the floor is √2 · 0,02 / 5,655 m = 0,287°; so σ = 0,287° and ± 0,6°.

Shown: "Oppervlakte langs de helling: 56,5 m² ± 0,5 m²", "Oppervlakte van boven gezien: 40,0 m² ± 0,5 m²", "Hellingshoek: 45,0° ± 0,6°". The 30° shed face gives 13,8217 m² along the slope (exact 13,8564), 11,9697 m² from above (exact 12) and 30,0020°.

### 7.5 Ground areas

| Polygon                                | Surface area                                            | From above (exact) | Shown                                                                                                                |
| -------------------------------------- | ------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Driveway D1–D4, 6 × 3 m, flat          | 18,0140 m²                                              | 18,0085 m² (18)    | "Oppervlakte over het terrein: 18,0 m² ± 0,3 m²", "van boven gezien: 18,0 m² ± 0,3 m²"                               |
| 3 × 3 m across the 0,30 m terrace kerb | 9,9064 m², of which 0,9016 m² steep (exact 9,9 and 0,9) | 9,0047 m² (9)      | "Oppervlakte over het terrein: 9,9 m² ± 0,2 m² (waarvan 0,9 m² steile vlakken)", "van boven gezien: 9,0 m² ± 0,2 m²" |
| Lawn L1–L4, 8 × 6 m with mole hills    | 48,7406 m² (noise-free mesh: 48,7350)                   | 47,9939 m² (48)    | "Oppervlakte over het terrein: 48,7 m² ± 0,5 m²", "van boven gezien: 48,0 m² ± 0,4 m²"                               |

Measured as a roof face, the lawn fits a plane with an RMS of 61,9 mm, above 5 cm, so the method switches to the mesh surface along the fitted normal: 48,7405 m², with "niet vlak" shown.

### 7.6 Checks

- **Exact geometry.** Every method run on the noise-free mesh with the exact points matches the exact value to within 10⁻⁹ (distance, length, height, both roof faces, √2 ratio, both pitches, driveway, concave L-shape in both windings, kerb, lawn). Run on the noisy mesh with re-projected picks, every value lies well inside its shown ±. Ear clipping gives the shoelace area for an L-shape, an L-shape with a collinear point, a comb and a star, in both windings; a self-intersecting bow tie is refused.
- **Monte Carlo** (σ = 0,02 m, fixed seed, 20.000 to 50.000 trials each): the empirical spread divided by the formula is 0,998 (distance), 1,004 and 0,998 (two polylines), 0,998 (height), 0,998 and 0,991 (area along the slope, from the formula and through the whole plane-fit method), 1,006 and 0,996 (area from above, rectangle and L-shape), 1,007 and 1,007 (pitch fit term at 45° and 30°), 0,999, 0,996 and 0,996 (mesh areas of driveway, lawn and kerb) and 1,000 (not-flat lawn). All within 3 %.
- **Flag threshold.** 3000 random picks (camera 15 to 40 m away): the median difference between light and full mesh is 2,8 mm and the 95th percentile 22 mm; above 10 cm are 0,6 % of picks (curved lawn 4,7 %, flat surfaces 0,5 %). The largest differences (up to 6,5 m) are rays grazing an edge, where the two meshes hit different surfaces; those must be flagged.

## 8. What people see

### 8.1 Staff: "Hoe berekend?"

Every measurement has a panel with:

- the method in plain Dutch, for example "Oppervlakte langs de helling: we leggen een plat vlak door de 763 punten van het 3D-model binnen je vorm en meten de vorm in dat vlak.";
- the formula (section 4) with the input values filled in;
- the input points, local and in the original system (`E 671842,32 · N 5702113,89 · h 69,72`), with the difference between the light and the full model and any flag;
- for areas: along the slope and from above, the pitch, the flatness (RMS in mm), which path was used (plane or mesh surface) and any steep part;
- the uncertainty: σ per point and its source, the ± per value;
- the control measurements of this measurement and the overall statistics;
- the model file (short SHA-256), the projection scale, the algorithm version, who measured and when, and the revision history.

### 8.2 Customers: customer page and inspection report

A short explanation per measurement, in Dutch and addressed with "u", plus a screenshot of the model with the measured shape highlighted. Templates (the variable parts are filled in):

- Roof area: "Gemeten op het 3D-model van uw dak, gemaakt met een RTK-drone. Oppervlakte langs de helling van het dak. Nauwkeurigheid ongeveer ± 0,5 m²."
- Ground area: "Gemeten op het 3D-model van uw tuin, gemaakt met een RTK-drone. Oppervlakte van bovenaf gezien. Nauwkeurigheid ongeveer ± 0,4 m²."
- Length: "Gemeten op het 3D-model van uw woning, gemaakt met een RTK-drone. Lengte langs de dakrand. Nauwkeurigheid ongeveer ± 10 cm."
- Without a backed accuracy, the last sentence is left out.

The inspection report gets an appendix **"Meetverantwoording"**: for every measurement used in the quote, its screenshot, the method in one sentence, the values (along the slope and from above), the ± and its source, the date of the scan and the short model hash.

### 8.3 Quote lines

A quote mapping turns a measurement value into a quantity, in exact decimal arithmetic so every printed number can be checked by hand:

1. start from the measured value **as shown** (0,1 m² or 0,01 m);
2. add the extra percentage exactly, and round half up to the same precision: that is the "=" number in the text;
3. apply the rounding rule (`up`, `nearest` or `none`; step 1, 0,5 or 0,1) to that shown number;
4. apply the minimum last.

| Measured | Extra | Rule      | Minimum | Quantity | Line description                                                               |
| -------- | ----- | --------- | ------- | -------- | ------------------------------------------------------------------------------ |
| 48,6 m²  | 10 %  | up 1      | 5       | 54       | "Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²"            |
| 50,0 m²  | 10 %  | up 1      | 5       | 55       | "Vogelnet: 50,0 m² gemeten + 10% overlap = 55,0 m², afgerond 55 m²"            |
| 48,6 m²  | 10 %  | nearest 1 | 5       | 54       | "Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²"            |
| 20,1 m²  | 15 %  | up 0,5    | 5       | 23,5     | "Vogelnet: 20,1 m² gemeten + 15% overlap = 23,1 m², afgerond 23,5 m²"          |
| 3,2 m²   | 10 %  | up 1      | 5       | 5        | "Vogelnet: 3,2 m² gemeten + 10% overlap = 3,5 m², afgerond 4 m², minimum 5 m²" |
| 12,0 m²  | 0 %   | up 1      | 5       | 12       | "Vogelnet: 12,0 m² gemeten, afgerond 12 m²"                                    |

Plain floating point gets two of these wrong: `50 × 1,1` is `55,00000000000001`, which `Math.ceil` turns into 56, and rounding the raw 53,46 to the nearest whole number gives 53 while the text says 53,5. The reference script checks these and more.

## 9. Versions and parameters

Every revision stores the algorithm version and all of its parameters. `measure-1`:

| Parameter                               | Value                                      |
| --------------------------------------- | ------------------------------------------ |
| σ per point                             | 2 × resolution (texel median or Terra GSD) |
| shown ±                                 | 2σ, rounded up to 0,01 m, 0,1 m² or 0,1°   |
| plane band                              | 0,30 m                                     |
| edge margin for the plane fit           | 0,25 m                                     |
| minimum vertices for a plane fit        | 10                                         |
| flatness threshold                      | RMS 5 cm                                   |
| slab for a not-flat roof face           | ± 0,30 m around the fitted plane           |
| ground slab                             | lowest pick − 1 m to highest pick + 1 m    |
| steep                                   | normal more than 60° from the prism axis   |
| re-projection flag                      | difference > max(10 cm, 2σ)                |
| pitch σ floor                           | √2 · σ / extent along the slope            |
| gradient step for mesh-area σ           | 1 mm, central differences                  |
| control measurements before switch-over | 10 per kind                                |
| projection scale                        | stored and shown, not corrected            |

A new version is needed for any change to a method, a formula or a parameter that changes a value or a ±. Existing revisions keep their version; recalculating with the new one is an explicit operator action that creates a new revision.

Known limits of `measure-1`, to check on the first real exports:

- how the median texel size of a Terra export relates to its GSD, and whether Terra's quality report is in the OBJ output folder;
- the vertical datum Terra writes in `metadata.xml`;
- the real differences between a meshopt-simplified `web.glb` and `work.glb`, which set the 10 cm floor of the flag;
- whether the band and edge margin keep overhangs, gutters, ridge caps and solar panels out of the plane fit on real roofs (faces steeper than about 65° and soffits under overhangs can still leak in);
- how far correlated model deformation goes beyond the pitch floor.

## 10. Tests (M4)

In `packages/shared`, run by `pnpm check`, ported from the reference script:

- the synthetic house (section 7): every method on the noise-free mesh equal to the exact value within 10⁻⁶, and on the noisy mesh within the shown ±;
- the 45° face (area along the slope = √2 × area from above, pitch 45°), the 30° face, a flat driveway, a concave L-shape in both windings, a kerb inside a ground polygon, a lawn that must take the mesh path, a polygon touching a facade (the slab);
- the re-projection: a pick moves from the light to the full mesh, a large difference is flagged, a miss falls back and is flagged;
- Monte Carlo with a fixed seed: every σ formula within 3 % of the empirical spread;
- quote rounding (the table in 8.3 and float edge cases) and Dutch number formatting.

## Sources

- Pix4D, accuracy of aerial mapping (relative accuracy 1 to 3 GSD): https://www.pix4d.com/blog/accuracy-aerial-mapping
- PROJ and pyproj (`get_factors`): https://pyproj4.github.io/pyproj/stable/api/proj.html
- RDNAPTRANS2018 grids (`nl_nsgi_rdtrans2018.tif`, `nl_nsgi_nlgeo2018.tif`): https://cdn.proj.org
- DJI Terra `metadata.xml`: DJI's own sample export, read during the M1 benchmark (PLAN.md section 3).
