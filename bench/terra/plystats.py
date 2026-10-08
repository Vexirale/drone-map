import sys, numpy as np, os
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
p = sys.argv[1]
f = open(p, 'rb')
hdr = []
while True:
    line = f.readline().decode('ascii', 'replace').strip()
    hdr.append(line)
    if line == 'end_header': break
nv = int([l for l in hdr if l.startswith('element vertex')][0].split()[-1])
nf = int([l for l in hdr if l.startswith('element face')][0].split()[-1])
textured = any('texcoord' in l for l in hdr)
texfiles = [l.split()[-1] for l in hdr if l.startswith('comment TextureFile')]
V = np.frombuffer(f.read(nv*12), dtype='<f4').reshape(nv, 3)
if textured:
    rec = np.dtype([('n','u1'),('i','<u4',(3,)),('m','u1'),('uv','<f4',(6,)),('t','<i4')])
else:
    rec = np.dtype([('n','u1'),('i','<u4',(3,))])
F = np.frombuffer(f.read(nf*rec.itemsize), dtype=rec)
assert (F['n'] == 3).all()
I = F['i'].astype(np.int64)
a, b, c = V[I[:,0]].astype(np.float64), V[I[:,1]].astype(np.float64), V[I[:,2]].astype(np.float64)
cr = np.cross(b - a, c - a)
area3d = 0.5*np.linalg.norm(cr, axis=1)
area_xy = 0.5*np.abs(cr[:,2])
mn, mx = V.min(0), V.max(0)
print(f'file {os.path.basename(p)} size {os.path.getsize(p)/1e6:.1f} MB  verts {nv}  faces {nf}')
print(f'bbox min {mn} max {mx} extent {mx-mn}')
print(f'surface area 3D {area3d.sum():.0f} m2, projected XY {area_xy.sum():.0f} m2, bbox XY {(mx-mn)[0]*(mx-mn)[1]:.0f} m2')
print(f'faces per m2 (3D surface) {nf/area3d.sum():.2f}; median tri area {np.median(area3d)*1e4:.1f} cm2; mean edge ~ {np.sqrt(np.median(area3d)*4/np.sqrt(3))*100:.1f} cm')
if textured:
    d = os.path.dirname(p); tot_px = 0
    for k, t in enumerate(texfiles):
        im = Image.open(os.path.join(d, t)); w, h = im.size; tot_px += w*h
        print(f'  texture {t}: {w}x{h} {im.mode} {os.path.getsize(os.path.join(d,t))/1e6:.1f} MB; faces using it {(F["t"]==k).sum()}')
    # texel density: texture pixels per m2 of 3D surface (assuming full atlas usage)
    print(f'texture px total {tot_px/1e6:.1f} MP; px per m2 surface (upper bound) {tot_px/area3d.sum():.0f} -> ~{100/np.sqrt(tot_px/area3d.sum()):.2f} cm/texel')
if textured:
    uv = F['uv'].reshape(-1,3,2).astype(np.float64)
    e1 = uv[:,1]-uv[:,0]; e2 = uv[:,2]-uv[:,0]
    uvarea = 0.5*np.abs(e1[:,0]*e2[:,1]-e1[:,1]*e2[:,0])
    used_px = 0
    for k, t in enumerate(texfiles):
        im = Image.open(os.path.join(os.path.dirname(p), t)); w, h = im.size
        m = F['t']==k
        fill = uvarea[m].sum()
        used_px += fill*w*h
        print(f'  {t}: UV fill {fill*100:.1f}%')
    print(f'used texels {used_px/1e6:.1f} MP -> {used_px/area3d.sum():.0f} texels/m2 -> {100/np.sqrt(used_px/area3d.sum()):.2f} cm/texel')
