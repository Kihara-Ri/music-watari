#!/usr/bin/env python3
"""Install official patch releases through deploy.sh; standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
from urllib.request import Request, urlopen

PACKAGE = 'album-ledger.tar.gz'
CHECKSUM = PACKAGE + '.sha256'
VERSION_RE = re.compile(r'^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
# 必须覆盖 package_app.py 打包的每一个根级文件/目录，否则新包会被旧校验拒收
# （v2.4.0 加了 musicbrainz.py 却漏在这里，导致之后的补丁更新一直被拒）。
# tests/test_updates.py 有对账测试防止再次漏加。
PACKAGE_ROOTS = {'VERSION', 'app.py', 'domain.py', 'storage.py', 'covers.py',
                 'cjkvariants.py', 'musicbrainz.py', 'rates.py', 'security.py',
                 'backups.py', 'README.md', '使用说明.md', '部署说明.md',
                 'CHANGELOG.md', 'server', 'static', 'deploy', 'tools'}


def version_tuple(value):
    match = VERSION_RE.fullmatch(str(value))
    return tuple(map(int, match.groups())) if match else None


def choose_patch(releases, installed):
    current = version_tuple(installed)
    if current is None:
        raise ValueError('当前版本不是正式语义化版本，需先手动部署')
    candidates = []
    for release in releases:
        target = version_tuple(release.get('tag_name'))
        if (target and not release.get('draft') and not release.get('prerelease')
                and target[:2] == current[:2] and target > current):
            candidates.append((target, release))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def asset_url(release, repo, name):
    expected = f'https://github.com/{repo}/releases/download/{release["tag_name"]}/{name}'
    matches = [a for a in release.get('assets', []) if a.get('name') == name]
    if len(matches) != 1 or matches[0].get('browser_download_url') != expected:
        raise ValueError(f'正式发布缺少有效附件：{name}')
    return expected


def download(url, limit):
    request = Request(url, headers={'User-Agent': 'DieduPatchUpdater/1.0',
                                   'Accept': 'application/vnd.github+json'})
    with urlopen(request, timeout=30) as response:
        result = response.read(limit + 1)
    if len(result) > limit:
        raise ValueError('下载内容超过大小限制')
    return result


def validate_package(path, expected_version):
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        seen = set()
        for member in members:
            relative = PurePosixPath(member.name)
            if (relative.is_absolute() or '..' in relative.parts or not relative.parts
                    or relative.parts[0] not in PACKAGE_ROOTS
                    or not (member.isfile() or member.isdir()) or member.name in seen):
                raise ValueError('发布包包含不允许的路径或文件类型')
            seen.add(member.name)
        for required in ('VERSION', 'app.py', 'rates.py', 'tools/deploy.sh', 'tools/update_release.py'):
            if required not in seen or not archive.getmember(required).isfile():
                raise ValueError(f'发布包缺少 {required}')
        if archive.extractfile('VERSION').read(100).decode().strip() != expected_version:
            raise ValueError('发布包版本与 Release 标签不一致')


def install_patch(base, repo, service, port, check=False):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('UPDATE_REPOSITORY 需填写 owner/repository')
    installed = (base / 'current' / 'VERSION').read_text().strip()
    releases = json.loads(download(f'https://api.github.com/repos/{repo}/releases?per_page=100', 2 << 20))
    if not isinstance(releases, list):
        raise ValueError('版本接口返回格式不正确')
    release = choose_patch(releases, installed)
    if release is None:
        if check:
            print(f'当前 {installed}，没有同主次版本的新补丁；功能版本需手动部署')
        return False
    tag = release['tag_name']
    package_url = asset_url(release, repo, PACKAGE)
    checksum_url = asset_url(release, repo, CHECKSUM)
    if check:
        print(f'可更新补丁：{installed} → {tag}')
        return True
    checksum = download(checksum_url, 1024).decode('ascii').strip()
    match = re.fullmatch(r'([0-9a-f]{64})\s+\*?album-ledger\.tar\.gz', checksum)
    if not match:
        raise ValueError('发布包 SHA256 文件格式不正确')
    digest = match.group(1)
    with tempfile.TemporaryDirectory(prefix='diedu-patch-') as folder:
        package = Path(folder) / PACKAGE
        raw = download(package_url, 100 << 20)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('发布包 SHA256 校验失败，保留当前服务')
        package.write_bytes(raw)
        validate_package(package, tag)
        env = {**os.environ, 'DEPLOY_HOST': 'local', 'DEPLOY_DIR': str(base),
               'SERVICE': service, 'APP_PORT': str(port), 'PACKAGE_PATH': str(package),
               'EXPECTED_VERSION': tag, 'EXPECTED_SHA256': digest,
               'EXPECTED_PREVIOUS_VERSION': installed}
        subprocess.run(['bash', str(base / 'current' / 'tools' / 'deploy.sh')], env=env, check=True)
    print(f'补丁更新完成：{installed} → {tag}')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path(os.environ.get('DEPLOY_DIR', '/opt/diedu')))
    parser.add_argument('--repo', default=os.environ.get('UPDATE_REPOSITORY'))
    parser.add_argument('--service', default=os.environ.get('SERVICE', 'diedu'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('APP_PORT', '8765')))
    parser.add_argument('--check', action='store_true', help='只检查，不下载或更新')
    args = parser.parse_args()
    if not args.repo:
        parser.error('需配置 UPDATE_REPOSITORY 或 --repo')
    try:
        install_patch(args.base.resolve(), args.repo, args.service, args.port, args.check)
    except Exception as error:
        parser.exit(1, f'补丁更新失败，详情：{error}\n')


if __name__ == '__main__':
    main()
