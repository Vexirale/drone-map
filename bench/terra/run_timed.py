import subprocess, sys, time, resource, os
t=time.time()
r=subprocess.run(sys.argv[1:],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=dict(os.environ,NODE_OPTIONS='--max-old-space-size=12000'))
dt=time.time()-t
ru=resource.getrusage(resource.RUSAGE_CHILDREN)
print(f'rc={r.returncode} wall={dt:.1f}s cpu={ru.ru_utime+ru.ru_stime:.1f}s peakRSS={ru.ru_maxrss/1024:.0f}MB')
if r.returncode: print(r.stdout.decode()[-1500:])
