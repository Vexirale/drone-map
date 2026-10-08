# Build synthetic larger Terra-like OBJ by midpoint-subdividing the real Terra mesh (keeps real UVs/textures)
import sys, numpy as np, os, shutil
p, outdir, levels, ntex = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
f = open(p,'rb'); hdr=[]
while True:
    l=f.readline().decode().strip(); hdr.append(l)
    if l=='end_header': break
nv=int([l for l in hdr if l.startswith('element vertex')][0].split()[-1]); nf=int([l for l in hdr if l.startswith('element face')][0].split()[-1])
V=np.frombuffer(f.read(nv*12),dtype='<f4').reshape(nv,3).astype(np.float64)
rec=np.dtype([('n','u1'),('i','<u4',(3,)),('m','u1'),('uv','<f4',(6,)),('t','<i4')])
F=np.frombuffer(f.read(nf*rec.itemsize),dtype=rec)
I=F['i'].astype(np.int64); UV=F['uv'].reshape(-1,3,2).astype(np.float64); T=F['t'].astype(np.int64)
for _ in range(levels):
    # edges
    e=np.concatenate([I[:,[0,1]],I[:,[1,2]],I[:,[2,0]]]); e.sort(1)
    ue,inv=np.unique(e,axis=0,return_inverse=True); inv=inv.reshape(3,-1).T
    mid=len(V)+np.arange(len(ue)); V=np.vstack([V,(V[ue[:,0]]+V[ue[:,1]])/2])
    m01,m12,m20=mid[inv[:,0]],mid[inv[:,1]],mid[inv[:,2]]
    a,b,c=I[:,0],I[:,1],I[:,2]
    uva,uvb,uvc=UV[:,0],UV[:,1],UV[:,2]; u01=(uva+uvb)/2; u12=(uvb+uvc)/2; u20=(uvc+uva)/2
    I=np.concatenate([np.stack([a,m01,m20],1),np.stack([m01,b,m12],1),np.stack([m20,m12,c],1),np.stack([m01,m12,m20],1)])
    UV=np.concatenate([np.stack([uva,u01,u20],1),np.stack([u01,uvb,u12],1),np.stack([u20,u12,uvc],1),np.stack([u01,u12,u20],1)])
    T=np.concatenate([T,T,T,T])
# spread faces over ntex materials (spatially contiguous chunks by original texture id), all pointing to 8192 atlas copies
mat=(T*ntex//3 + (np.arange(len(T))%max(1,ntex//3)))%ntex
os.makedirs(outdir,exist_ok=True)
src=os.path.join(os.path.dirname(p),'Block_0_0.jpg')
with open(os.path.join(outdir,'Block.mtl'),'w') as m:
    for k in range(ntex):
        shutil.copy(src,os.path.join(outdir,f'Block_0_{k}.jpg'))
        m.write(f'newmtl mat{k}\nKd 1 1 1\nmap_Kd Block_0_{k}.jpg\n')
uvf=UV.reshape(-1,2); uq,uinv=np.unique(uvf.astype(np.float32),axis=0,return_inverse=True); uinv=uinv.reshape(-1,3)
path=os.path.join(outdir,'Block.obj')
with open(path,'w') as o:
    o.write('mtllib Block.mtl\n')
    np.savetxt(o,V,fmt='v %.6f %.6f %.6f'); np.savetxt(o,uq,fmt='vt %.6f %.6f')
    for k in range(ntex):
        sel=mat==k
        o.write(f'usemtl mat{k}\n')
        arr=np.stack([I[sel,0]+1,uinv[sel,0]+1,I[sel,1]+1,uinv[sel,1]+1,I[sel,2]+1,uinv[sel,2]+1],1)
        np.savetxt(o,arr,fmt='f %d/%d %d/%d %d/%d')
print('faces',len(I),'verts',len(V),'obj MB',round(os.path.getsize(path)/1e6,1),'textures',ntex,'x 8192^2')
