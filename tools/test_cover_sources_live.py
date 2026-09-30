"""Read-only real-network smoke test: source matching and image decoding."""
import sys,time,io,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from covers import CoverService
from PIL import Image
s=CoverService('data/cover-cache.sqlite3')
for title,artist in [('Dookie','Green Day'),('American Idiot','Green Day'),('True','Avicii')]:
 start=time.monotonic();r=s.search(title,artist);exact=[c for c in r['candidates'] if c['exact']]
 print(title,'sources',r['checked'],'exact',len(exact),'seconds',round(time.monotonic()-start,2),'warnings',r['warnings'],flush=True)
 assert exact
 image=s.download(exact[0]['token']);Image.open(io.BytesIO(base64.b64decode(image['cover'].split(',')[1]))).load()
# Exercise the actual fallback provider independently of primary coverage.
r=s.archive_candidates('OK Computer','Radiohead');assert r
im=s.download(r[0]['token']);Image.open(io.BytesIO(base64.b64decode(im['cover'].split(',')[1]))).load()
print('MusicBrainz + CAA',r[0]['title'],im['coverSource']['provider'],'image decoded',flush=True)
