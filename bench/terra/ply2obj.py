# Writes the Terra textured PLY as OBJ to estimate ASCII OBJ size (per-corner vt, deduped vt)
import sys, numpy as np, os, io
p, out = sys.argv[1], sys.argv[2]
f = open(p, 'rb'); hdr=[]
while True:
    l = f.readline().decode().strip(); hdr.append(l)
    if l == 'end_header': break
nv = int([l for l in hdr if l.startswith('element vertex')][0].split()[-1])
nf = int([l for l in hdr if l.startswith('element face')][0].split()[-1])
V = np.frombuffer(f.read(nv*12), dtype='<f4').reshape(nv,3)
rec = np.dtype([('n','u1'),('i','<u4',(3,)),('m','u1'),('uv','<f4',(6,)),('t','<i4')])
F = np.frombuffer(f.read(nf*rec.itemsize), dtype=rec)
uv = F['uv'].reshape(-1,2)
uq, inv = np.unique(uv, axis=0, return_inverse=True)
inv = inv.reshape(-1,3)
for mode in ('percorner','dedup'):
    path = out + '.' + mode + '.obj'
    with open(path, 'w') as o:
        o.write('mtllib Block.mtl\n')
        np.savetxt(o, V, fmt='v %.6f %.6f %.6f')
        if mode == 'percorner':
            np.savetxt(o, uv, fmt='vt %.6f %.6f')
            vti = np.arange(nf*3).reshape(-1,3)+1
        else:
            np.savetxt(o, uq, fmt='vt %.6f %.6f')
            vti = inv+1
        I = F['i'].astype(np.int64)+1
        for t in np.unique(F['t']):
            o.write(f'usemtl mat{t}\n')
            m = F['t']==t
            arr = np.stack([I[m,0],vti[m,0],I[m,1],vti[m,1],I[m,2],vti[m,2]],1)
            np.savetxt(o, arr, fmt='f %d/%d %d/%d %d/%d')
    print(mode, f'{os.path.getsize(path)/1e6:.1f} MB', f'{os.path.getsize(path)/nf:.0f} B/face', 'unique uv', len(uq))
