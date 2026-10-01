"""Reproducible application-only archive; never includes private data/passwords.

打包内容 = 后端（app.py + server/ + 根模块）+ 已构建的 static/ 产物 + deploy/ 配置
+ VERSION（git describe 生成，/api/health 与设置页显示的就是它）。
前端源码（web/）与 node_modules 不进包：改前端后在 Mac 上重新 `npm run build` 再打包。
"""
import io
import hashlib
import subprocess
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / 'dist'
out.mkdir(exist_ok=True)

try:
    version = subprocess.run(['git', 'describe', '--tags', '--always', '--dirty'],
                             capture_output=True, text=True, check=True,
                             cwd=root).stdout.strip()
except Exception:
    version = 'untagged'

files = [root / n for n in ['app.py', 'domain.py', 'storage.py', 'covers.py', 'cjkvariants.py',
                            'rates.py', 'security.py', 'backups.py', 'README.md', '使用说明.md',
                            '部署说明.md', 'CHANGELOG.md']]
files += list((root / 'server').rglob('*.py'))
files += list((root / 'static').rglob('*'))
files += list((root / 'deploy').glob('*'))
files += [root / 'tools' / name for name in ('deploy.sh', 'update_release.py')]

with tarfile.open(out / 'album-ledger.tar.gz', 'w:gz') as tar:
    for path in sorted(files):
        if path.is_file():
            tar.add(path, arcname=str(path.relative_to(root)))
    info = tarfile.TarInfo('VERSION')
    data = version.encode()
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))

print(f'Application package: {out / "album-ledger.tar.gz"} (VERSION={version})')
digest = hashlib.sha256((out / 'album-ledger.tar.gz').read_bytes()).hexdigest()
(out / 'album-ledger.tar.gz.sha256').write_text(f'{digest}  album-ledger.tar.gz\n')
print(f'SHA256: {digest}')
