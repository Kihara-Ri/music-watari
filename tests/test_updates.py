import hashlib
import io
import json
import os
from pathlib import Path
import ast
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from tools import update_release as updater
from storage import Store


def release(tag, **flags):
    return {'tag_name': tag, 'draft': False, 'prerelease': False, **flags,
            'assets': [{'name': name,
                        'browser_download_url': f'https://github.com/example/ledger/releases/download/{tag}/{name}'}
                       for name in (updater.PACKAGE, updater.CHECKSUM)]}


def package(version, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name in ('VERSION', 'app.py', 'rates.py', 'tools/deploy.sh', 'tools/update_release.py'):
            data = version.encode() if name == 'VERSION' else b'# application fixture\n'
            info = tarfile.TarInfo(name); info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if extra:
            archive.addfile(extra, io.BytesIO(b'') if extra.isfile() else None)
    return output.getvalue()


class UpdateTests(unittest.TestCase):
    def test_only_newer_stable_patch_in_current_series_is_selected(self):
        releases = [release('v3.0.0'), release('v2.2.0'), release('v2.1.2'),
                    release('v2.1.9', draft=True), release('v2.1.8', prerelease=True),
                    release('v2.1.3'), release('v2.1.3-rc1'), release('v2.1.0')]
        self.assertEqual(updater.choose_patch(releases, 'v2.1.1')['tag_name'], 'v2.1.3')
        self.assertIsNone(updater.choose_patch(releases[:2], 'v2.1.1'))
        self.assertIsNone(updater.choose_patch([release('v2.1.0')], 'v2.1.1'))
        with self.assertRaises(ValueError):updater.choose_patch(releases, 'dev')

    def test_package_roots_cover_every_packaged_root_module(self):
        # package_app.py 打包的每个根级 .py 模块都必须在 PACKAGE_ROOTS 里，
        # 否则旧校验器会拒收新包、自动补丁更新一直失败（v2.4.2 实际发生过）。
        source = (Path(updater.__file__).resolve().parent / 'package_app.py').read_text()
        modules = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Assign) and any(
                    getattr(t, 'id', None) == 'files' for t in node.targets):
                modules |= {sub.value for sub in ast.walk(node.value)
                            if isinstance(sub, ast.Constant) and isinstance(sub.value, str)
                            and sub.value.endswith('.py') and '/' not in sub.value}
        self.assertTrue({'app.py', 'musicbrainz.py'} <= modules)
        self.assertLessEqual(modules, updater.PACKAGE_ROOTS)

    def test_missing_or_foreign_assets_are_rejected(self):
        item = release('v2.1.2'); item['assets'].pop()
        with self.assertRaises(ValueError):updater.asset_url(item, 'example/ledger', updater.CHECKSUM)
        item = release('v2.1.2'); item['assets'][0]['browser_download_url'] = 'https://example.test/payload'
        with self.assertRaises(ValueError):updater.asset_url(item, 'example/ledger', updater.PACKAGE)

    def test_archive_rejects_private_paths_traversal_and_links(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / updater.PACKAGE
            for name, kind in [('data/albums.sqlite3', tarfile.REGTYPE),
                               ('../service.env', tarfile.REGTYPE),
                               ('/app.py', tarfile.REGTYPE),
                               ('static/link', tarfile.SYMTYPE),
                               ('tools/link', tarfile.LNKTYPE)]:
                with self.subTest(name=name):
                    extra=tarfile.TarInfo(name);extra.type=kind;extra.linkname='/tmp/target'
                    path.write_bytes(package('v2.1.2', extra))
                    with self.assertRaises(ValueError):updater.validate_package(path, 'v2.1.2')
            path.write_bytes(package('v2.1.1'))
            with self.assertRaises(ValueError):updater.validate_package(path, 'v2.1.2')

    def test_bad_checksum_leaves_service_and_installed_version_untouched(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);(base/'current').mkdir();(base/'current'/'VERSION').write_text('v2.1.1')
            responses=[json.dumps([release('v2.1.2')]).encode(),
                       ('0'*64+'  '+updater.PACKAGE).encode(), package('v2.1.2')]
            with patch.object(updater,'download',side_effect=responses), patch.object(updater.subprocess,'run') as run:
                with self.assertRaises(ValueError):updater.install_patch(base,'example/ledger','diedu',8765)
                run.assert_not_called()
            self.assertEqual((base/'current'/'VERSION').read_text(),'v2.1.1')

    def test_verified_patch_uses_existing_deploy_pipeline_and_expected_version(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);(base/'current').mkdir();(base/'current'/'VERSION').write_text('v2.1.1')
            raw=package('v2.1.2');digest=hashlib.sha256(raw).hexdigest()
            responses=[json.dumps([release('v2.1.2')]).encode(),
                       (digest+'  '+updater.PACKAGE).encode(),raw]
            def deploy(command, **kwargs):
                self.assertEqual(command,['bash',str(base/'current'/'tools'/'deploy.sh')])
                env=kwargs['env']
                self.assertEqual(env['EXPECTED_VERSION'],'v2.1.2')
                self.assertEqual(env['EXPECTED_PREVIOUS_VERSION'],'v2.1.1')
                self.assertEqual(env['EXPECTED_SHA256'],digest)
                self.assertEqual(env['DEPLOY_HOST'],'local')
                self.assertEqual(Path(env['PACKAGE_PATH']).read_bytes(),raw)
                return subprocess.CompletedProcess(command,0)
            with patch.object(updater,'download',side_effect=responses), patch.object(updater.subprocess,'run',side_effect=deploy) as run:
                self.assertTrue(updater.install_patch(base,'example/ledger','diedu',8765))
                self.assertEqual(run.call_count,1)

    def test_check_does_not_download_or_deploy(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);(base/'current').mkdir();(base/'current'/'VERSION').write_text('v2.1.1')
            with patch.object(updater,'download',return_value=json.dumps([release('v2.1.2')]).encode()) as download, patch.object(updater.subprocess,'run') as run:
                self.assertTrue(updater.install_patch(base,'example/ledger','diedu',8765,check=True))
                self.assertEqual(download.call_count,1);run.assert_not_called()


class DeployPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.base=Path(self.tmp.name)/'instance';old=self.base/'releases'/'old';old.mkdir(parents=True)
        (old/'VERSION').write_text('v2.1.0');(self.base/'current').symlink_to(old)
        self.database=self.base/'data'/'albums.sqlite3'
        Store(self.database).save({'title':'合成测试CD','artist':'测试艺人'})
        self.original=self.database.read_bytes()
        self.package=Path(self.tmp.name)/updater.PACKAGE;self.package.write_bytes(package('v2.1.1'))
        self.bin=Path(self.tmp.name)/'bin';self.bin.mkdir()
        fixtures={
            'sudo':'#!/bin/sh\n[ "$1" != -n ] || shift\nexec "$@"\n',
            'systemctl':'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\n',
            'sleep':'#!/bin/sh\nexit 0\n',
            'curl':'''#!/usr/bin/env python3
import json,os,pathlib
v=(pathlib.Path(os.environ['DEPLOY_DIR'])/'current'/'VERSION').read_text()
if os.environ.get('FIXTURE_FAILURE')=='health' and v=='v2.1.1':v='wrong-version'
print(json.dumps({'ok':True,'version':v}))
''',
            'cp':'''#!/bin/sh
if [ "$FIXTURE_FAILURE" = backup ]; then
  case "$2" in *pre-deploy-*) exit 1;; esac
fi
exec /bin/cp "$@"
''',
            # Linux's head -n -N is used by the server release cleanup.
            'head':'''#!/usr/bin/env python3
import sys
lines=sys.stdin.readlines();n=int(sys.argv[-1]);sys.stdout.writelines(lines[:n])
''',
        }
        for name,body in fixtures.items():
            path=self.bin/name;path.write_text(body);path.chmod(0o755)
        self.env={**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],
                  'DEPLOY_HOST':'local','DEPLOY_DIR':str(self.base),'SERVICE':'fixture',
                  'PACKAGE_PATH':str(self.package),'EXPECTED_VERSION':'v2.1.1',
                  'EXPECTED_SHA256':hashlib.sha256(self.package.read_bytes()).hexdigest(),
                  'FIXTURE_LOG':str(Path(self.tmp.name)/'service.log'),'FIXTURE_FAILURE':''}

    def tearDown(self):self.tmp.cleanup()

    def deploy(self, failure=''):
        self.env['FIXTURE_FAILURE']=failure
        script=Path(__file__).resolve().parents[1]/'tools'/'deploy.sh'
        return subprocess.run(['bash',str(script)],env=self.env,capture_output=True,text=True,timeout=10)

    def assert_preserved(self, version):
        self.assertEqual((self.base/'current'/'VERSION').read_text(),version)
        self.assertEqual(self.database.read_bytes(),self.original)
        self.assertFalse((self.base/'.deploy-lock').exists())

    def test_success_creates_snapshot_and_switches_to_expected_version(self):
        result=self.deploy();self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        snapshots=list((self.base/'data').glob('pre-deploy-*.sqlite3'))
        self.assertEqual(len(snapshots),1);self.assertEqual(snapshots[0].read_bytes(),self.original)
        self.assert_preserved('v2.1.1')

    def test_wrong_health_version_rolls_back(self):
        result=self.deploy('health');self.assertNotEqual(result.returncode,0)
        self.assertIn('已回滚',result.stdout+result.stderr);self.assert_preserved('v2.1.0')

    def test_snapshot_failure_restarts_previous_service_without_switching(self):
        result=self.deploy('backup');self.assertNotEqual(result.returncode,0)
        self.assertIn('快照失败',result.stdout+result.stderr);self.assert_preserved('v2.1.0')
        self.assertIn('restart fixture',(Path(self.tmp.name)/'service.log').read_text())

    def test_concurrent_manual_upgrade_is_not_overwritten(self):
        self.env['EXPECTED_PREVIOUS_VERSION']='v2.0.0'
        result=self.deploy();self.assertNotEqual(result.returncode,0)
        self.assertIn('运行版本已变更',result.stdout+result.stderr);self.assert_preserved('v2.1.0')
        self.assertFalse((Path(self.tmp.name)/'service.log').exists())
