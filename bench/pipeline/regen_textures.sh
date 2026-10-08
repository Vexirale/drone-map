#!/bin/bash
# Regenerate only the texture pages of a sample (after tuning texgen.py), 4 in parallel.
# usage: regen_textures.sh <sample_dir>
D=$1; HERE=$(dirname "$(readlink -f "$0")")
N=$(python3 -I -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$D/pages.json")
seq 0 $((N-1)) | xargs -P 4 -I{} python3 -I "$HERE/texgen.py" "$D/pages.json" {} "$D/terra_obj/Block/Block_{}.jpg"
python3 -I -c "
import os,sys,statistics as st
d=sys.argv[1]+'/terra_obj/Block'; s=[os.path.getsize(os.path.join(d,f))/1e6 for f in os.listdir(d) if f.endswith('.jpg')]
print(f'{len(s)} textures, JPEG MB min/mean/max {min(s):.2f}/{st.mean(s):.2f}/{max(s):.2f}, total {sum(s):.0f} MB')" "$D"
