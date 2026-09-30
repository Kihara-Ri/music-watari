"""iTunes album artwork search. Only Apple artwork hosts can be fetched."""
from contextlib import closing
import sqlite3
from pathlib import Path
from urllib.error import HTTPError
import base64
import json
import re
import threading
import time
import unicodedata
from difflib import SequenceMatcher
from urllib.parse import urlencode, urlsplit, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from domain import ValidationError


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def similarity(a, b):
    return SequenceMatcher(None, normalized(a), normalized(b)).ratio()


def artist_variants(artist):
    """Name forms worth trying: CV roles stripped, ＆/and members split, punctuation shed."""
    import re as _re
    base = unicodedata.normalize('NFKC', str(artist)).strip()
    out = [base]
    no_cv = _re.sub(r'\((?:CV\.?|cv)[:：]?\s*[^)]*\)', '', base)
    no_cv = _re.sub(r'\s+', ' ', no_cv).strip()
    if no_cv and no_cv != base: out.append(no_cv)
    for form in (no_cv or base, base):
        members = _re.split(r'[＆&]|※|、|/| x |×| X ', form)
        members = [m.strip() for m in members if m.strip()]
        if len(members) > 1:
            out.extend(members)
            out.append(' '.join(members))
    for v in list(out):
        shed = v.replace('!', '').replace('！', '').strip()
        if shed and shed not in out: out.append(shed)
    return [v for v in out if v]


def artist_matches(artist, who, loose=False):
    """Exact normalized equality, or fuzzy ≥ threshold against any variant."""
    who_n = normalized(who)
    if not who_n: return False
    threshold = 0.82 if loose else 0.9
    for v in artist_variants(artist):
        if normalized(v) == who_n: return True
        if similarity(v, who) >= threshold: return True
    return False


def artwork_url(url):
    p = urlsplit(url)
    if p.scheme != 'https' or not p.hostname or not (p.hostname.endswith('.mzstatic.com') or p.hostname == 'archive.org' or p.hostname.endswith('.archive.org') or p.hostname == 'coverartarchive.org') or p.username or p.password or p.port not in (None,443):
        raise ValidationError('封面来源不是受支持的图片地址')
    return url


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(req.full_url).hostname in ('itunes.apple.com','musicbrainz.org'):
            if urlsplit(newurl).hostname != urlsplit(req.full_url).hostname or urlsplit(newurl).scheme != 'https':
                raise ValidationError('封面服务返回了不支持的跳转')
        else:
            artwork_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class CoverService:
    def __init__(self, cache_path=None):
        self.cache_path = cache_path
        self.catalog_lock = threading.Lock()
        self.network_lock = threading.Lock()
        self.responses = {}
        self.last_request = {}
        if cache_path:
            Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(cache_path)) as db, db:
                db.execute("CREATE TABLE IF NOT EXISTS responses(url TEXT PRIMARY KEY, at REAL, data TEXT)")
        self.cache = {}
        self.choices = {}
        self.images = {}
        # RLock：search 持锁期间会调用 candidate，candidate 内也要登记 choices
        self.lock = threading.RLock()
        self.last_search = 0
        self.opener = build_opener(SafeRedirect())

    def read(self, url, limit):
        try:
            with self.opener.open(Request(url, headers={'User-Agent':'AlbumLedger/1.1 (personal local album inventory)','Accept':'application/json,image/*'}), timeout=12) as response:
                data = response.read(limit + 1)
                if len(data) > limit: raise ValidationError('封面文件过大，请改用手动上传')
                return data
        except HTTPError as exc:
            if exc.code == 404 and urlsplit(url).hostname == 'coverartarchive.org': return b'{}'
            raise ValidationError('封面资料库暂时不可用，请稍后重试') from exc
        except ValidationError:
            raise
        except Exception as exc:
            raise ValidationError('暂时无法连接封面服务，请稍后重试或手动上传') from exc

    def search(self, title, artist, country='AUTO'):
        title, artist = str(title).strip(), str(artist).strip()
        if not title or not artist: raise ValidationError('请先填写专辑名和艺人')
        if max(len(title),len(artist)) > 500: raise ValidationError('专辑名或艺人过长')
        if country == 'AUTO': return self.layered_search(title, artist)
        if country not in ('JP','US'): raise ValidationError('请选择日本或美国资料库')
        key=(title, artist, country)
        with self.lock:
            hit=self.cache.get(key)
            if hit and time.monotonic()-hit[0]<3600: return hit[1]
            if time.monotonic()-self.last_search<3.1: raise ValidationError('查询较频繁，请稍等几秒后重试')
            self.last_search=time.monotonic()
            raw=self.read('https://itunes.apple.com/search?'+urlencode({'term':title+' '+artist,'country':country,'media':'music','entity':'album','limit':8}), 1024*1024)
            try: results=json.loads(raw).get('results',[])
            except (ValueError,AttributeError): raise ValidationError('封面服务返回的数据无法读取，请重试')
            candidates=[]
            for item in results:
                url=item.get('artworkUrl100','')
                if not url: continue
                try: artwork_url(url)
                except ValidationError: continue
                candidates.append(self.candidate(title,artist,item.get('collectionName',''),item.get('artistName',''),
                    f"{country}-{item.get('collectionId')}",url,str(item.get('releaseDate',''))[:4],country=country))
            candidates.sort(key=lambda x:x['score'],reverse=True)
            result={'candidates':candidates[:6],'source':'iTunes','country':country}
            self.cache[key]=(time.monotonic(),result)
            return result

    def download(self, token):
        with self.lock:
            if token in self.images: return self.images[token]
            item=self.choices.get(token)
        if not item: raise ValidationError('候选封面已过期，请重新查找')
        data=self.read(artwork_url(item['url']),2*1024*1024)
        if data.startswith(b'\xff\xd8\xff'): mime='image/jpeg'
        elif data.startswith(b'\x89PNG\r\n\x1a\n'): mime='image/png'
        elif data.startswith(b'RIFF') and data[8:12]==b'WEBP': mime='image/webp'
        else: raise ValidationError('返回的文件不是受支持的封面图片')
        result={'cover':f'data:{mime};base64,'+base64.b64encode(data).decode(),
            'coverSource':{'provider':item.get('provider','iTunes'),'page':item.get('page',''),'title':item['title'],'artist':item['artist'],'url':item['url'],'country':item['country']}}
        with self.lock:self.images[token]=result
        return result

    def metadata(self, url):
        """Cache source responses across albums/restarts; pace only real network calls."""
        with self.network_lock:
            hit = self.responses.get(url)
            if not hit and self.cache_path:
                with closing(sqlite3.connect(self.cache_path)) as db, db:
                    row = db.execute('SELECT at,data FROM responses WHERE url=?',(url,)).fetchone()
                    if row: hit = (row[0],json.loads(row[1]))
            if hit and time.time()-hit[0] < 7*86400: return hit[1]
            host=urlsplit(url).hostname
            interval=3.1 if host=='itunes.apple.com' else 1.1
            time.sleep(max(0,interval-(time.monotonic()-self.last_request.get(host,0))))
            self.last_request[host]=time.monotonic()
            try:
                result=json.loads(self.read(url,4*1024*1024))
                if not isinstance(result,dict): raise ValueError()
            except ValidationError:
                raise
            except (ValueError,TypeError) as exc:
                raise ValidationError('封面资料库返回了无效数据') from exc
            self.responses[url]=(time.time(),result)
            if self.cache_path:
                with closing(sqlite3.connect(self.cache_path)) as db, db:
                    db.execute('INSERT OR REPLACE INTO responses VALUES(?,?,?)',(url,time.time(),json.dumps(result)))
            return result

    def artist_catalog(self, artist, country):
        base='https://itunes.apple.com/'
        matches=self.metadata(base+'search?'+urlencode({'term':artist,'entity':'musicArtist','limit':5,'country':country,'lang':'ja_jp' if country=='JP' else 'en_us'})).get('results',[])
        # Never silently adopt the first homonymous/unrelated artist.
        matches=[a for a in matches if artist_matches(artist, a.get('artistName',''), loose=True)]
        albums=[]
        for a in matches[:2]:
            data=self.metadata(base+'lookup?'+urlencode({'id':a['artistId'],'entity':'album','limit':200,'country':country,'lang':'ja_jp' if country=='JP' else 'en_us'}))
            albums.extend(x for x in data.get('results',[]) if x.get('collectionId'))
        return albums

    def candidate(self, title, artist, name, who, token, url, year='', provider='iTunes', page='', country='AUTO'):
        artwork_url(url)
        tk, nk = album_key(title), album_key(name)
        t_sim = similarity(tk, nk)
        # 标题是官方发行名的前缀（或反之）＝刻意用短名指代全名发行，按强匹配计；
        # 如「歌物語2」对应「歌物語2 -〈物語〉シリーズ主題歌集-」。exact 仍要求全等。
        if len(tk) >= 2 and len(nk) >= 2 and (nk.startswith(tk) or tk.startswith(nk)):
            t_sim = max(t_sim, .95)
        exact = tk == nk and artist_matches(artist, who)
        c={'token':token,'title':name,'artist':who,'thumbnail':url,'year':year,'provider':provider,
           'score':round(.65*t_sim+.35*similarity(artist,who),3),'exact':exact}
        with self.lock: self.choices[token]={**c,'url':re.sub(r'/100x100bb\.', '/600x600bb.',url),'country':country,'page':page}
        return c

    def group_cd_front(self, gid):
        """Prefer a CD-format release's front art; vinyl covers often own the group slot."""
        try:
            releases=self.metadata('https://musicbrainz.org/ws/2/release?'+urlencode({'release-group':gid,'fmt':'json','limit':25,'inc':'media'})).get('releases',[])
        except ValidationError:
            return None
        cd=[r['id'] for r in releases if any('CD' in (m.get('format') or '') for m in r.get('media',[]))]
        for rid in cd[:2]:
            try:
                art=self.metadata('https://coverartarchive.org/release/'+rid)
                front=next((i for i in art.get('images',[]) if i.get('front') and i.get('approved')),None)
                if front:
                    u=front.get('thumbnails',{}).get('500') or front.get('thumbnails',{}).get('large') or front.get('image','')
                    if u.startswith('http://'):u='https://'+u[7:]
                    return u
            except ValidationError:
                continue
        return None

    def archive_candidates(self,title,artist):
        # Quoted Lucene values keep punctuation in album/artist names literal.
        lucene_quote=lambda v:'"'+v.replace('\\','\\\\').replace('"','\\"')+'"'
        url='https://musicbrainz.org/ws/2/release-group/?'+urlencode({'query':f'releasegroup:{lucene_quote(title)} AND artist:{lucene_quote(artist)}','fmt':'json','limit':5}, quote_via=quote)
        groups=self.metadata(url).get('release-groups',[])
        # Artist spellings vary wildly (CV roles, ！/!, ø); retry title-only and gate by score.
        if not groups:
            time.sleep(1.2)
            url='https://musicbrainz.org/ws/2/release-group/?'+urlencode({'query':f'releasegroup:{lucene_quote(title)}','fmt':'json','limit':10}, quote_via=quote)
            groups=self.metadata(url).get('release-groups',[])
        candidates=[]
        for g in groups[:4]:
            name=g.get('title','');who=''.join(c.get('name',c.get('artist',{}).get('name',''))+c.get('joinphrase','') for c in g.get('artist-credit',[]))
            if similarity(title,name)<.65 or not artist_matches(artist,who,loose=True):continue
            gid=g.get('id','')
            if not re.fullmatch(r'[0-9a-f-]{36}',gid):continue
            url=self.group_cd_front(gid)
            if not url:
                art=self.metadata('https://coverartarchive.org/release-group/'+gid)
                front=next((i for i in art.get('images',[]) if i.get('front') and i.get('approved')),None)
                if not front:continue
                url=front.get('thumbnails',{}).get('500') or front.get('thumbnails',{}).get('large') or front.get('image','')
                if url.startswith('http://'):url='https://'+url[7:]
            try:c=self.candidate(title,artist,name,who,'CAA-'+gid,url,g.get('first-release-date','')[:4],'MusicBrainz / Cover Art Archive','https://musicbrainz.org/release-group/'+gid)
            except ValidationError:continue
            # A group can represent different editions; multiple matches remain manual.
            if 'Live' in g.get('secondary-types',[]) and 'live' not in title.casefold():c['exact']=False
            candidates.append(c)
        return candidates

    def term_candidates(self, title, artist, country):
        """艺人目录查不中时的兜底腿：按「标题+艺人」关键词直搜 iTunes 目录（如合辑、
        艺人署名与目录不一致的发行）。候选走同一打分与 0.65 门槛。"""
        base='https://itunes.apple.com/'
        results=self.metadata(base+'search?'+urlencode({'term':title+' '+artist,'entity':'album','limit':8,'country':country,'lang':'ja_jp' if country=='JP' else 'en_us'})).get('results',[])
        out=[]
        for a in results:
            if not a.get('artworkUrl100'):continue
            c=self.candidate(title,artist,a.get('collectionName',''),a.get('artistName',''),f"{country}-{a['collectionId']}",a['artworkUrl100'],a.get('releaseDate','')[:4],page=a.get('collectionViewUrl',''),country=country)
            if c['score']>=.65:out.append(c)
        return out

    def layered_search(self,title,artist):
        with self.catalog_lock:
            candidates=[];warnings=[];checked=[]
            for country in ('JP','US'):
                checked.append('iTunes '+country)
                try:
                    for a in self.artist_catalog(artist,country):
                        if not a.get('artworkUrl100'):continue
                        c=self.candidate(title,artist,a.get('collectionName',''),a.get('artistName',''),f"{country}-{a['collectionId']}",a['artworkUrl100'],a.get('releaseDate','')[:4],page=a.get('collectionViewUrl',''),country=country)
                        if c['score']>=.65:candidates.append(c)
                except ValidationError as exc:warnings.append(f'iTunes {country}：{exc}')
                if any(c['exact'] for c in candidates):break
            if not any(c['exact'] for c in candidates):
                for country in ('JP','US'):
                    checked.append(f'iTunes 关键词（{country}）')
                    try:candidates.extend(self.term_candidates(title,artist,country))
                    except ValidationError as exc:warnings.append(f'iTunes 关键词（{country}）：{exc}')
                    if any(c['exact'] for c in candidates):break
            if not any(c['exact'] for c in candidates):
                checked.append('MusicBrainz / Cover Art Archive')
                try:candidates.extend(self.archive_candidates(title,artist))
                except ValidationError as exc:warnings.append(str(exc))
            candidates.sort(key=lambda c:(c['exact'],c['score']),reverse=True)
            # Repeated catalog entries with the same title and image need one choice.
            unique={}
            for c in candidates:
                key=(normalized(c['artist']),album_key(c['title']),c['thumbnail'])
                unique.setdefault(key,c)
            return {'candidates':list(unique.values())[:6],'source':'自动多源','country':'AUTO','checked':checked,'warnings':warnings}


def album_key(title):
    """Ignore format/remaster labels, but preserve live/remix/deluxe identity."""
    title=re.sub(r'\s+-\s+(?:EP|Single)$','',title,flags=re.I)
    title=re.sub(r'\s*[\[(](?:(?:\d{4}\s+)?Remaster(?:ed)?(?:\s+\d{4})?)[\])]','',title,flags=re.I)
    return normalized(title)
