# Measurements: how every number is calculated

Status: the design for M4 (phase 2), fixed before building so quotes can be trusted and checked. The inputs it needs are stored from the first upload in M1. This document describes algorithm version **`measure-1`**; a change to any method or parameter below is a new version (section 9). The code in `packages/shared` follows this document, not the other way around.

The numbers in section 7 come from a reference script that implements this document (`bench/measurements/worked-example.ts`, run with `node bench/measurements/worked-example.ts`); its Monte Carlo runs check every uncertainty formula.

## 1. Principles

- **Traceable.** Every value can be traced back to its picked points, the model file (by SHA-256), the method, the algorithm version and its parameters. Staff see all of it in the "Hoe berekend?" panel.
- **Frozen once issued.** A measurement is a list of revisions that are never changed. Quotes, reports and customer pages refer to one revision and keep a copy of what they showed. A better algorithm only changes old numbers when an operator recalculates, and then as a new revision; issued documents keep their values.
- **No unbacked accuracy.** A ± is only shown when it follows from the model's measured resolution or from real control measurements (section 6). Otherwise the value is shown without one.
- **Dutch formatting** everywhere: `12,4 m²`, `3,25 m`, `35°`, thousands with a dot (`1.250 m²`), a non-breaking space before the unit.

## 2. Frame and coordinates

**Local metric frame.** All math runs in the job-local frame: metres east (E), north (N) and up (U), equal to the model's projected coordinates minus the job origin (`docs/architecture.md` §8). The origin is stored in double precision, so the original coordinates of every point are exact: `X = E + origin.E`, `Y = N + origin.N`, `Z = U + origin.U`.

**Projected input.** DJI Terra exports in a projected system (UTM zone 31N by default, or RD New). Grid distances in a projected system differ from true distances by the projection's scale factor k:

@@GEO@@

**Geographic input.** A model in degrees (for example WGS 84 latitude/longitude) is reprojected with PROJ to the UTM zone of the job (zone 31 for nearly all of the Netherlands) before anything else, so it lands in the same kind of frame as a projected export. @@GEOGRAPHIC@@

**Up axis.** Terra and the stored data are Z-up. Only three.js uses Y-up, and the conversion exists in exactly one function (`enuToThree`). Heights below are always differences in U.

**Heights and NAP.** A height is a difference in U between two points, which needs no datum. An absolute height is shown as NAP only when the vertical datum is known:

- the model's heights are already NAP (vertical CRS EPSG:5709, or a compound system with it): NAP = U + origin.U;
- the heights are ellipsoidal (ETRS89/WGS 84): NAP = ellipsoidal height − N, with the geoid height N from the official NLGEO2018 model (RDNAPTRANS2018, grid `nl_nsgi_nlgeo2018.tif`, bundled with the RD grid). Over one property N changes by well under a millimetre, so it is stored once per job (`jobs.nap_offset`);
- otherwise (unknown vertical datum, or outside the Netherlands): relative heights only, and the panel says why.

Absolute NAP heights depend on the RTK fix and the geoid model, not on the model's resolution, so they are shown without a ± (section 6 only covers relative values).

## 3. Picking and re-projection

The browser shows the light mesh (`web.glb`, about 500k triangles), so points are picked there for speed. The final values are computed on the server on `work.glb`, the full-detail mesh (PLAN.md decision 11).

1. For every picked point the browser stores the **view ray**: origin = camera position, direction = the unit vector from the camera through the picked point, both in the local frame. In the 2D orthophoto view the ray is vertical (from 1000 m above, pointing down).
2. `measurement.compute` intersects each ray with `work.glb` (BVH, first hit, Möller-Trumbore) and uses that point.
3. Both points are stored, with their distance `d`. If `d` is larger than the **flag threshold** (@@FLAG@@), the point is flagged: the light mesh and the full mesh disagree there (a thin edge, an overhanging branch, a hole), and the operator checks it before the measurement can be used in a quote.
4. If the ray misses `work.glb` entirely (a hole in the full mesh), the closest point of `work.glb` to the picked point is used and the point is flagged.

## 4. Methods

Notation: points `p_i = (E, N, U)` in metres; `|v|` is the length of a vector.

### 4.1 Distance

The straight 3D distance between two points: `d = |p_2 − p_1|`.

### 4.2 Length

The sum of the 3D segment lengths of a polyline: `L = Σ_i |p_(i+1) − p_i|`.

### 4.3 Height

The vertical difference between two points: `h = U_2 − U_1` (shown as a positive number with "hoger" or "lager"). With a known vertical datum, both NAP heights are shown too (section 2).

### 4.4 Area on a roof face, and the pitch

The operator draws a polygon on a roof face. Steps:

1. **Provisional plane** through the polygon's points (least squares, as in step 3).
2. **Vertex selection:** the vertices of `work.glb` whose projection onto the provisional plane lies inside the polygon, and whose distance to that plane is less than the band (@@BAND@@). The band keeps walls, gutters below the eaves and trees out of the fit.
3. **Plane fit (total least squares):** centroid `c` of the selected vertices; covariance `C = (1/n) Σ (q_j − c)(q_j − c)ᵀ`; the plane normal `n` is the eigenvector of the smallest eigenvalue of `C`, turned so it points up (`n_U > 0`).
4. **Refit once:** select again with the fitted plane (step 2), and fit again (step 3).
5. **Flatness:** `RMS = sqrt((1/n) Σ ((q_j − c) · n)²)`, the root mean square distance of the selected vertices to the plane.
6. **Area along the slope:** project the polygon onto the plane, express it in an orthonormal basis `(u, v)` of the plane (`u` horizontal, `v = n × u`), and apply the shoelace formula to the 2D coordinates `(x_i, y_i)`:
   `A_slope = ½ |Σ_i (x_i · y_(i+1) − x_(i+1) · y_i)|`.
7. **Area from above:** the shoelace formula on the E/N coordinates of the plane-projected polygon: `A_plan = ½ |Σ_i (E_i · N_(i+1) − E_(i+1) · N_i)|`. For a plane, `A_plan = A_slope · cos θ`.
8. **Pitch:** `θ = arccos(n_U)` in degrees: the angle between the plane's normal and vertical.
9. **Not flat:** if `RMS` is above the flatness threshold (5 cm), the surface is not one plane (a dormer, a chimney, two faces, a bulging net). Then `A_slope` is replaced by the mesh surface area clipped to the polygon (4.6, with the prism along the provisional plane's normal), the panel and the customer text say so ("geen vlak dak: oppervlakte van het 3D-model zelf"), and no pitch is given.

### 4.5 Area on the ground (tuin, oprit)

1. **Surface area:** the mesh surface area of `work.glb` clipped to the vertical prism over the polygon (4.6). Bumps, mole hills and kerbs make it larger than the area from above.
2. **Area from above:** the shoelace formula on the E/N coordinates of the polygon's points.

Both are shown, labeled. Quotes for ground work normally use the area from above (that is what a lawn treatment or a mesh roll covers); the quote mapping chooses which one.

### 4.6 Mesh surface area clipped to a polygon

The polygon is cut into triangles (ear clipping; any simple polygon, concave or not, either winding). Every mesh triangle whose bounding box touches the polygon is clipped against the prism of each polygon triangle: the prism's three side planes run along the prism axis (the plane normal for a roof face, vertical for the ground). The clipping is Sutherland-Hodgman on the 3D triangle, one side plane at a time, and the area of every clipped piece is summed.

Clipping in 3D, instead of projecting to 2D and dividing by the cosine of the slope, counts vertical faces correctly: a 30 cm kerb or a low wall inside a ground polygon adds its real area, where a projection would divide by zero.

## 5. Effective resolution

The resolution says how much detail the model holds, and sets the point uncertainty.

- **Texel size (always available):** for every textured triangle of `work.glb`, `t = sqrt(A_3D / (A_UV · W · H))`, with `A_3D` its area in m², `A_UV` its area in texture coordinates and `W × H` the texture size in pixels. The resolution is the area-weighted median of `t` over all triangles, in cm. Computed once at import (M1) and stored with the scan.
- **GSD from the DJI Terra quality report**, when the export folder contains one: preferred over the texel size, because it is what Terra measured on the photos. The stored scan says which one was used.

## 6. Uncertainty

### 6.1 Point uncertainty

@@SIGMA_SECTION@@

### 6.2 Propagation to every value

With independent point errors of σ per axis:

| Value                | Formula                                      | Note                                                                        |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Distance             | `σ_d = σ · √2`                               | the error along the line of each end point counts                           |
| Length               | `σ_L = σ · sqrt(Σ_i \|u_(i−1) − u_i\|²)`     | `u_i` = unit direction of segment i; an end point has one term, `\|u\| = 1` |
| Height               | `σ_h = σ · √2`                               | vertical errors of both points                                              |
| Area along the slope | `var(A) = σ²/4 · Σ_i \|v_(i+1) − v_(i−1)\|²` | in the plane's 2D coordinates; independent in-plane vertex errors           |
| Area from above      | the same formula on the E/N coordinates      |                                                                             |
| Pitch                | @@PITCH_SIGMA@@                              |                                                                             |

For a rectangle the area formula reduces to `σ_A = σ · diagonal`, since every vertex sees the diagonal `v_(i+1) − v_(i−1)`.

### 6.3 What is shown

- The ± shown is **2σ, rounded up** (lengths and heights to whole cm, areas to 0,1 m², pitch to whole degrees). 2σ covers about 95 % of normal errors.
- The source is always stated: "op basis van de resolutie van het model (1,2 cm)" or "op basis van 14 controlemetingen".
- Without a resolution (no texture and no quality report) and without enough control measurements, no ± is shown at all.

### 6.4 Control measurements ("controlemetingen")

- The operator can enter a tape-measured value for any measurement value (a gutter length, a flat roof part, a driveway). Stored: the tape value, the model value of that revision, the deviation `model − tape`, the relative deviation, the instrument and who and when.
- Settings show per kind (lengths and heights in cm; areas in %): the number of control measurements, the average deviation (signed, which shows a scale problem), the average and the maximum absolute deviation.
- **Switch-over:** from 10 control measurements of a kind on (setting), the ± shown for that kind comes from them: `± = 2 · RMS(deviation)` in cm for lengths and heights, and `± = 2 · RMS(relative deviation) · value` for areas. The resolution estimate is no longer used for that kind.
- The ± and its source are stored in each revision when it is computed, so a later control measurement does not change an issued number.

## 7. Worked example

@@WORKED@@

## 8. What people see

### 8.1 Staff: "Hoe berekend?"

Every measurement has a panel with:

- the method in plain Dutch, for example "Oppervlakte langs de helling: we leggen een plat vlak door de 1.284 punten van het 3D-model binnen je vorm en meten de vorm in dat vlak.";
- the formula (section 4), with the input values filled in;
- the input points, local and in the original system (`X 158.214,37 · Y 385.002,11 · Z 24,86`), with the difference between the light and the full model and any flag;
- for areas: along the slope and from above, the pitch, the flatness (RMS in cm) and which path was used (plane or mesh surface);
- the uncertainty: σ per point, its source, ± per value;
- the control measurements of this measurement and the overall statistics;
- the model file (short SHA-256), the algorithm version, who measured and when, and the revision history.

### 8.2 Customers: customer page and inspection report

A short explanation per measurement, in Dutch and addressed with "u", plus a screenshot of the model with the measured shape highlighted. Templates (the variable parts are filled in):

- Roof area: "Gemeten op het 3D-model van uw dak, gemaakt met een RTK-drone. Oppervlakte langs de helling van het dak. Nauwkeurigheid ongeveer ± 0,4 m²."
- Ground area: "Gemeten op het 3D-model van uw tuin, gemaakt met een RTK-drone. Oppervlakte van bovenaf gezien. Nauwkeurigheid ongeveer ± 0,3 m²."
- Length: "Gemeten op het 3D-model van uw woning, gemaakt met een RTK-drone. Lengte langs de dakrand. Nauwkeurigheid ongeveer ± 3 cm."
- Without a backed accuracy, the last sentence is left out.

The inspection report gets an appendix **"Meetverantwoording"**: for every measurement used in the quote its screenshot, the method in one sentence, the values (along the slope and from above), the ± and its source, the date of the scan and the short model hash.

### 8.3 Quote lines

A quote mapping turns a measurement value into a quantity:

```
quantity = max(minimum, round_rule(value × (1 + extra / 100), step))
```

- `round_rule` is `up` (default), `nearest` or `none`; `step` is 1, 0,5 or 0,1.
- Floating point: `50 × 1,1` is `55,00000000000001` in floating point, which would round up to 56. So the product is first rounded to 6 decimals, and 55 stays 55.
- The line description in Odoo shows the calculation: "Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²". When the minimum applies: "… = 3,3 m², minimum 5 m²". Without extra: "Pinnen: 12,40 m gemeten, afgerond 13 m".

## 9. Versions and parameters

Every revision stores the algorithm version and all of its parameters. `measure-1`:

@@PARAMS@@

A new version is needed for any change to a method, a formula or a parameter that changes a value or a ±. Existing revisions keep their version; recalculating with the new one is an explicit operator action that creates a new revision.

## 10. Tests (M4)

In `packages/shared`, run by `pnpm check`:

- the synthetic house with known dimensions (section 7): every value equal to the exact value within 1 mm or 0,001 m²;
- the 45° face: area along the slope = √2 × area from above, pitch 45°;
- a 30° face; a flat driveway; a concave (L-shaped) polygon in both windings; a kerb inside a ground polygon; a non-flat lawn that must take the mesh path;
- the re-projection: a pick on the light mesh moves onto the full mesh, a large difference is flagged, a miss falls back and is flagged;
- Monte Carlo (fixed seed): the empirical spread of every value under simulated point noise matches its formula within a few percent;
- quote rounding edge cases and Dutch number formatting.
