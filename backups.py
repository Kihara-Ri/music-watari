"""Daily consistent SQLite snapshots; seven rotating local copies."""
from pathlib import Path
from contextlib import closing
import sqlite3,threading,datetime,json,logging

class Backups:
    def __init__(self,source):
        self.source=Path(source);self.folder=self.source.parent/'daily-backups';self.folder.mkdir(exist_ok=True);self.error='';self.lock=threading.Lock()
    def run(self):
        with self.lock:
            target=self.folder/(datetime.date.today().isoformat()+'.sqlite3')
            if target.exists():return
            temp=target.with_suffix('.tmp')
            try:
                with closing(sqlite3.connect(self.source)) as src,closing(sqlite3.connect(temp)) as dst:
                    src.backup(dst)
                    if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('备份完整性检查失败')
                temp.chmod(0o600);temp.replace(target)
                for old in sorted(self.folder.glob('*.sqlite3'))[:-7]:old.unlink()
                self.error=''
            except Exception as e:
                self.error='自动备份失败，请检查磁盘空间和权限';logging.exception('Daily backup failed')
                if temp.exists():temp.unlink()
    def status(self):
        copies=sorted(self.folder.glob('*.sqlite3'));return {'last':copies[-1].stem if copies else None,'count':len(copies),'error':self.error}
    def start(self):
        def loop():
            while True:self.run();threading.Event().wait(3600)
        threading.Thread(target=loop,daemon=True).start()
