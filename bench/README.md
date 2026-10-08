# Processing benchmark (2026-10-08)

Scripts behind the numbers in `PLAN.md` section 3. Not part of the app; they move into the M1 pipeline tests.

- `pipeline/`: synthetic DJI-Terra-like whole-property export and the planned pipeline, timed step by step.
  - `gen_property.py` and `texgen.py`: OBJ + MTL + metadata.xml + 4096 px JPG atlas pages (`--tris N --pages N --out DIR`).
  - `run_bench.py <sample_dir> [--steps a,b,c,d,e,f,g]`: runs each step under `/usr/bin/time -v`: (a) obj2gltf, (b) web.glb, (c) render.glb, (d) crop + texture mask, (e) web.glb from the crop, (f, g) headless Chromium load.
  - `crop.mjs`: polygon crop with page pruning and texel masking.
  - `bench_browser.mjs`, `viewer.html`: three.js load and first-frame timing in Chromium (SwiftShader).
  - `ktx2_test.mjs`: KTX2 ETC1S encoding with the WASM encoder.
  - `make_table.py`, `glbstats.mjs`: reporting helpers.
- `terra/`: helpers used on DJI's own Terra sample export (PLY stats, PLY to OBJ, synthetic upscaling, timing).
- `cadastral/`: `prefill_demo.py` (model footprint to PDOK cadastral parcel to crop polygon in model-local metres) and `cmp.py` (RD New / UTM transform comparison). Needs `pyproj`, `shapely` and the RDNAPTRANS2018 grid `nl_nsgi_rdtrans2018.tif` in the grid directory you pass in.

Setup:

```bash
cd bench/node && npm install          # tools pinned to the benchmarked versions
cd ../node-ktx && npm install         # optional, KTX2 test only
sudo apt-get install time             # GNU time for peak RSS
python3 pipeline/gen_property.py --tris 6000000 --pages 32 --out data/M
python3 pipeline/run_bench.py data/M
```

Run the same steps on the first real whole-property export (copy it to `data/real/`, never commit it).
