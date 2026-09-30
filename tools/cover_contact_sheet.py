from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,math
root=Path('data/cover-audit');font=ImageFont.truetype('/System/Library/Fonts/STHeiti Light.ttc',15)
rows=json.loads(Path('data/albums.json').read_text());entries=[]
for p in root.glob('*.json'):
 d=json.loads(p.read_text());im=p.with_suffix('.jpg')
 if im.exists():entries.append((d['title']+' / '+d['artist'],im))
for p in (root/'overrides').glob('*.jpg'):entries.append((p.stem,p))
for start in range(0,len(entries),20):
 sheet=Image.new('RGB',(1000,1400),'white');draw=ImageDraw.Draw(sheet)
 for n,(label,path) in enumerate(entries[start:start+20]):
  x=(n%4)*250;y=(n//4)*280;im=Image.open(path);im.thumbnail((230,230));sheet.paste(im,(x+(240-im.width)//2,y));label=f'{start+n}: '+label
  draw.text((x+4,y+232),label[:28],font=font,fill='black');draw.text((x+4,y+252),label[28:56],font=font,fill='black')
 sheet.save(root/f'sheet-{start//20}.jpg')
(root/'sheet-index.json').write_text(json.dumps([(i,l,str(p)) for i,(l,p) in enumerate(entries)],ensure_ascii=False,indent=2))
print(len(entries))
