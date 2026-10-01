"""Single-owner authentication, persistent hashed sessions, and login throttling."""
import hashlib,hmac,json,secrets,sqlite3,time
from contextlib import closing
from http.cookies import SimpleCookie

class Auth:
    def __init__(self,path):
        self.path=path
        with closing(sqlite3.connect(path)) as db,db:
            db.executescript('CREATE TABLE IF NOT EXISTS owner(hash TEXT,salt TEXT); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires REAL); CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,count INTEGER,until REAL);')
    def configured(self):
        with closing(sqlite3.connect(self.path)) as db:return db.execute('SELECT 1 FROM owner').fetchone() is not None
    def set_password(self,password):
        if len(password)<12:raise ValueError('密码至少需要 12 个字符')
        salt=secrets.token_hex(16);digest=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),600000).hex()
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute('DELETE FROM owner');db.execute('INSERT INTO owner VALUES(?,?)',(digest,salt));db.execute('DELETE FROM sessions')
    def change_password(self,current,new,keep=None):
        """改密：先验证当前密码；keep 为要保留会话的 token 哈希（其余设备全部退出）。"""
        if len(new)<12:raise ValueError('新密码至少需要 12 个字符')
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT hash,salt FROM owner').fetchone()
            if not row or not hmac.compare_digest(row[0],hashlib.pbkdf2_hmac('sha256',current.encode(),bytes.fromhex(row[1]),600000).hex()):
                raise ValueError('当前密码不正确')
            salt=secrets.token_hex(16);digest=hashlib.pbkdf2_hmac('sha256',new.encode(),bytes.fromhex(salt),600000).hex()
            db.execute('UPDATE owner SET hash=?,salt=?',(digest,salt))
            if keep:db.execute('DELETE FROM sessions WHERE token<>?',(keep,))
            else:db.execute('DELETE FROM sessions')
    def login(self,password,ip):
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute('BEGIN IMMEDIATE')
            attempt=db.execute('SELECT count,until FROM attempts WHERE ip=?',(ip,)).fetchone()
            if attempt and attempt[0]>=5 and attempt[1]>time.time():raise ValueError('尝试次数较多，请 15 分钟后再试')
            row=db.execute('SELECT hash,salt FROM owner').fetchone()
            valid=row and hmac.compare_digest(row[0],hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(row[1]),600000).hex())
            if not valid:
                count=attempt[0]+1 if attempt and attempt[1]>time.time() else 1
                db.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',(ip,count,time.time()+900));db.commit()
                raise ValueError('密码不正确')
            db.execute('DELETE FROM attempts WHERE ip=?',(ip,));db.execute('DELETE FROM sessions WHERE expires<?',(time.time(),))
            token=secrets.token_urlsafe(32);db.execute('INSERT INTO sessions VALUES(?,?)',(hashlib.sha256(token.encode()).hexdigest(),time.time()+30*86400));return token
    def token(self,cookie):
        try:
            c=SimpleCookie();c.load(cookie or '');return c['album_session'].value if 'album_session' in c else ''
        except Exception:return ''
    def valid(self,cookie):
        token=self.token(cookie)
        with closing(sqlite3.connect(self.path)) as db,db:
            h=hashlib.sha256(token.encode()).hexdigest()
            row=db.execute('SELECT expires FROM sessions WHERE token=? AND expires>?',(h,time.time())).fetchone()
            if not row:return False
            if row[0]-time.time()<15*86400:  # 滑动续期：持续使用不掉线，闲置 30 天自然失效
                db.execute('UPDATE sessions SET expires=? WHERE token=?',(time.time()+30*86400,h))
            return True
    def logout(self,cookie):
        with closing(sqlite3.connect(self.path)) as db,db:db.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(self.token(cookie).encode()).hexdigest(),))
