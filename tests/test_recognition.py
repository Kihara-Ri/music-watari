"""视觉接入、草稿恢复、人工字段保护、任务并行及入库完整性。仅使用临时数据。"""
import base64
import copy
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from domain import ValidationError
from server.recognition import PROVIDERS, VisionService, clean_result, description
from storage import Store, uid

PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
RESULT = {'fields':{'title':'Fixture Album 2','artist':'Fixture Artist','version':'Jewel Case','pressing':'日版','obi':'带侧标',
                    'releaseInfo':{'catalogNumber':'TEST-002','barcode':'1234567890123','format':'CD','extras':'可见歌词册'}},
          'evidence':[{'field':'title','value':'Fixture Album 2','photo':1,'note':'封面文字'}],'warnings':[]}

def completion():
    return {'choices':[{'message':{'content':json.dumps(RESULT)}}]}

class RecognitionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.store=Store(self.root/'albums.sqlite3');self.service=VisionService(self.store)
        self.service.configure({'baseUrl':'http://127.0.0.1:9999/v1','model':'fixture-vision','lookup':False,'concurrency':3})
    def tearDown(self):
        self.service.executor.shutdown(wait=True,cancel_futures=True);self.temp.cleanup()
    def draft(self, count=2):
        d=self.store.create_import({'currency':'CNY','status':'domestic'})
        for i in range(count):d=self.store.upload_import_photo(d['id'],f'{i:03}.png',PHOTO)
        return d
    def wait_done(self, ident):
        self.service.executor.shutdown(wait=True)
        return self.store.read_import(ident)
    def test_config_key_not_exposed_exported_or_logged(self):
        public=self.service.configure({'baseUrl':'http://127.0.0.1:9999/v1','model':'fixture','apiKey':'fixture-token','lookup':False})
        self.assertTrue(public['hasKey']);self.assertNotIn('apiKey',public)
        self.assertNotIn('fixture-token',json.dumps(self.store.backup()))
        self.assertEqual(self.service.config_path.stat().st_mode & 0o777,0o600)
        self.service.configure({'baseUrl':public['baseUrl'],'model':'other','apiKey':''})
        self.assertEqual(self.service.config['apiKeys']['custom'],'fixture-token')
        self.service.configure({'baseUrl':public['baseUrl'],'model':'other','clearKey':True})
        self.assertFalse(self.service.public_config()['hasKey'])
        with self.assertRaises(ValidationError):self.service.configure({'baseUrl':'http://example.com/v1','model':'fixture'})
        with self.assertRaises(ValidationError):self.service.configure({'baseUrl':'https://user:pass@example.com/v1','model':'fixture'})
    def test_keys_are_stored_per_provider(self):
        self.service.configure({'provider':'zhipuai','model':'glm-4.6v','apiKey':'key-zhipu','lookup':False})
        self.service.configure({'provider':'openai','model':'gpt-4o','apiKey':'key-openai','lookup':False})
        self.assertEqual(self.service.config['apiKeys'],{'zhipuai':'key-zhipu','openai':'key-openai'})
        self.assertTrue(self.service.public_config()['hasKey'])
        self.service.configure({'provider':'zhipuai','model':'glm-4.6v','clearKey':True,'lookup':False})
        self.assertEqual(self.service.config['apiKeys'],{'openai':'key-openai'})
        self.assertFalse(self.service.public_config()['hasKey'])  # hasKey 只看当前供应商
        self.service.configure({'provider':'zhipuai','model':'glm-4.6v','lookup':False})
        self.assertEqual(self.service.public_config()['hasKey'],False)
    def test_model_cannot_write_accounting_or_links(self):
        output=copy.deepcopy(RESULT);output['fields'].update(price='0',date='2020-01-01',status='sold',apiKey='untrusted')
        output['sources']=[{'url':'https://evil.test','title':'untrusted'}]
        output['fields']['obi']='无侧标'
        output['evidence'].append({'photo':99,'value':'not a photo'})
        result=clean_result(output,2)
        self.assertNotIn('price',result['fields']);self.assertNotIn('status',result['fields'])
        self.assertEqual(result['fields']['obi'],'')
        self.assertEqual(result['sources'],[]);self.assertEqual(len(result['evidence']),1)
        fields=copy.deepcopy(RESULT['fields']);fields['releaseInfo']['matrix']='TEST MATRIX'
        self.assertIn('内圈刻码：TEST MATRIX',description(fields))
    def test_draft_roundtrip_partition_and_limits(self):
        d=self.draft();fresh=Store(self.store.path)
        self.assertEqual(fresh.read_import(d['id']),d)
        self.assertEqual(base64.b64decode(PHOTO.split(',')[1]),fresh.import_photo(d['id'],d['photos'][0]['id']).read_bytes())
        bad=copy.deepcopy(d);bad['groups'].append({**bad['groups'][0],'id':uid()})
        with self.assertRaisesRegex(ValidationError,'只能归属'):self.store.update_import(bad)
        with self.assertRaises(ValidationError):self.store.read_import('../outside')
        for _ in range(29):d=self.store.upload_import_photo(d['id'],'more.png',PHOTO)
        with self.assertRaisesRegex(ValidationError,'分组'):self.service.start({'id':d['id'],'groupIds':[d['groups'][0]['id']]})
    def test_commit_readback_unknown_cost_independent_copies_and_idempotency(self):
        d=self.draft(2);g=d['groups'][0]
        d['groups']=[{**g,'photoIds':g['photoIds'][:1],'fields':copy.deepcopy(RESULT['fields']),'protected':list(RESULT['fields']),'reviewed':True},
                     {**g,'id':uid(),'photoIds':g['photoIds'][1:],'fields':copy.deepcopy(RESULT['fields']),'protected':list(RESULT['fields']),'reviewed':True}]
        d=self.store.update_import(d)
        for g in d['groups']:g['reviewed']=True
        d=self.store.update_import(d);body={'id':d['id'],'groupIds':[g['id'] for g in d['groups']]}
        saved=self.store.commit_import(body);again=self.store.commit_import(body)
        self.assertEqual([g['savedId'] for g in saved['groups']],[g['savedId'] for g in again['groups']])
        state=self.store.state();self.assertEqual(len(state['records']),2)
        for r in state['records']:
            self.assertIsNone(r['cost']);self.assertEqual(r['photoCount'],1)
            self.assertEqual(r['releaseInfo']['catalogNumber'],'TEST-002')
            self.assertTrue((self.store.photos_dir/r['id']/'0.png').exists())
        # DB 已完成但照片复制中断时，重试恢复照片，不创建第二份副本。
        (self.store.photos_dir/state['records'][0]['id']/'0.png').unlink()
        self.store.commit_import(body)
        self.assertTrue((self.store.photos_dir/state['records'][0]['id']/'0.png').exists())
        self.store.delete_import(d['id']);self.assertEqual(len(self.store.state()['records']),2)
    def test_manual_input_survives_inflight_result(self):
        d=self.draft();entered=threading.Event();release=threading.Event()
        def response(*args,**kwargs):entered.set();release.wait(3);return completion()
        with patch('server.recognition.read_json',side_effect=response):
            self.service.start({'id':d['id'],'groupIds':[d['groups'][0]['id']]});self.assertTrue(entered.wait(2))
            editing=self.store.read_import(d['id']);editing['groups'][0]['fields']['title']='人工标题 2';editing['groups'][0]['protected']=['title']
            self.store.update_import(editing);release.set();done=self.wait_done(d['id'])
        self.assertEqual(done['groups'][0]['fields']['title'],'人工标题 2')
        self.assertEqual(done['groups'][0]['fields']['artist'],'Fixture Artist')
    def test_regroup_discards_inflight_identity(self):
        d=self.draft();entered=threading.Event();release=threading.Event()
        def response(*args,**kwargs):entered.set();release.wait(3);return completion()
        with patch('server.recognition.read_json',side_effect=response):
            self.service.start({'id':d['id'],'groupIds':[d['groups'][0]['id']]});self.assertTrue(entered.wait(2))
            editing=self.store.read_import(d['id']);g=editing['groups'][0]
            editing['groups']=[{**g,'photoIds':g['photoIds'][:1]},{'id':uid(),'photoIds':g['photoIds'][1:],'fields':{},'protected':[]}]
            self.store.update_import(editing);release.set();done=self.wait_done(d['id'])
        self.assertEqual(done['groups'][0]['status'],'idle');self.assertNotIn('result',done['groups'][0])
        self.assertFalse(done['groups'][0]['fields'])
    def test_parallel_is_bounded_to_configured_three(self):
        d=self.draft(8);g=d['groups'][0]
        d['groups']=[{**g,'id':uid(),'photoIds':[pid]} for pid in g['photoIds']];d=self.store.update_import(d)
        active=0;peak=0;lock=threading.Lock()
        def response(*args,**kwargs):
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            time.sleep(.12)
            with lock:active-=1
            return completion()
        with patch('server.recognition.read_json',side_effect=response):
            self.service.start({'id':d['id'],'groupIds':[g['id'] for g in d['groups']]});done=self.wait_done(d['id'])
        self.assertEqual(peak,3);self.assertTrue(all(g['status']=='done' for g in done['groups']))
    def test_bad_response_is_group_error_without_losing_photos(self):
        d=self.draft()
        with patch('server.recognition.read_json',return_value={'choices':[{'message':{'content':'not JSON'}}]}):
            self.service.start({'id':d['id'],'groupIds':[d['groups'][0]['id']]});done=self.wait_done(d['id'])
        self.assertEqual(done['groups'][0]['status'],'error');self.assertEqual(len(done['photos']),2)
        self.assertEqual(self.store.state()['records'],[])
    def test_collection_only_draft_and_disabled_purchase_guard(self):
        self.store.set_modules({'acquisition':False,'trading':False,'circulation':False})
        d=self.draft(1);g=d['groups'][0]
        g.update(fields={'title':'收藏专辑','artist':'测试艺人'},protected=['title','artist'],reviewed=True)
        d=self.store.update_import(d)
        d['common']['date']='2001-02-03';d=self.store.update_import(d)
        body={'id':d['id'],'groupIds':[g['id']]}
        with self.assertRaisesRegex(ValidationError,'购入记录'):self.store.commit_import(body)
        self.assertEqual(self.store.state()['records'],[])
        d['common']['date']='';self.store.update_import(d);self.store.commit_import(body)
        r=self.store.state()['records'][0]
        self.assertEqual(r['status'],'domestic');self.assertEqual(r['date'],'');self.assertIsNone(r['cost'])
    def test_restart_marks_interrupted_task_for_manual_retry(self):
        d=self.draft();d['groups'][0]['status']='running';self.store.write_import(d)
        service=VisionService(self.store)
        try:self.assertEqual(self.store.read_import(d['id'])['groups'][0]['status'],'error')
        finally:service.close()
    def test_release_candidates_use_physical_identifiers_and_filter_vinyl(self):
        self.service.catalog_at=0
        releases={'releases':[{'id':'11111111-1111-1111-1111-111111111111','title':'Fixture Album','barcode':'1234567890123',
            'artist-credit':[{'name':'Fixture Artist'}],'country':'JP','date':'2001-02-03','media':[{'format':'CD'}],
            'label-info':[{'catalog-number':'TEST-002','label':{'name':'Fixture Label'}}]},
            {'id':'22222222-2222-2222-2222-222222222222','media':[{'format':'Vinyl'}]}]}
        with patch('server.recognition.read_json',return_value=releases) as request:
            candidates=self.service.catalog(RESULT['fields'])
        self.assertEqual(len(candidates),1);self.assertTrue(candidates[0]['identifierMatch'])
        self.assertIn('barcode',request.call_args.args[0]);self.assertEqual(candidates[0]['releaseInfo']['country'],'JP')
    def test_release_detail_tracks_cache_and_cd_validation(self):
        ident='11111111-1111-1111-1111-111111111111'
        release={'barcode':'1234567890123','country':'JP','date':'2001-02-03',
                 'label-info':[{'catalog-number':'TEST-002','label':{'name':'Fixture Label'}}],
                 'media':[{'format':'CD','position':1,'tracks':[{'number':'1','title':'First track'}]},
                          {'format':'CD','position':2,'tracks':[{'number':'1','recording':{'title':'Second disc'}}]}]}
        with patch('server.recognition.read_json',return_value=release) as request:
            details=self.service.release_details(ident)
            self.assertEqual(details['tracklist'],['1-1 First track','2-1 Second disc'])
            self.assertEqual(details['discCount'],'2');self.assertEqual(details['catalogNumber'],'TEST-002')
            self.assertEqual(self.service.release_details(ident),details);self.assertEqual(request.call_count,1)
        with self.assertRaises(ValidationError):self.service.release_details('../outside')
        with patch('server.recognition.read_json',return_value={'media':[{'format':'Vinyl'}]}):
            with self.assertRaisesRegex(ValidationError,'CD'):self.service.release_details('22222222-2222-2222-2222-222222222222')
    def test_provider_catalog_endpoint_and_stored_key(self):
        rows=self.service.providers()['providers']
        self.assertTrue(rows and all(p['baseUrl'].startswith('https://') and (p['env'] or p['oauth']) and p['models'] for p in rows))
        codex=[p for p in rows if p['oauth']]
        self.assertEqual([p['id'] for p in codex],['openai-codex'])
        self.assertNotIn('fixture-token',json.dumps(rows))
        with patch('server.recognition.read_json',return_value=completion()) as request:
            self.service.configure({'provider':'zhipuai','model':'glm-4.6v','apiKey':'fixture-token','baseUrl':'https://evil.example/v1','lookup':False})
            self.assertEqual(self.service.public_config()['baseUrl'],'https://open.bigmodel.cn/api/paas/v4')
            self.service.recognize([PHOTO])
        self.assertEqual(request.call_args.args[0],'https://open.bigmodel.cn/api/paas/v4/chat/completions')
        self.assertEqual(request.call_args.args[2],'fixture-token')
        with self.assertRaisesRegex(ValidationError,'供应商'):self.service.configure({'provider':'nope','model':'x'})
    def test_env_var_key_fallback_stored_key_wins(self):
        with patch.dict('os.environ',{'ZHIPU_API_KEY':'env-token'}):
            self.service.configure({'provider':'zhipuai','model':'glm-4.6v','lookup':False})
            self.assertEqual(self.service.public_config()['keySource'],'env')
            with patch('server.recognition.read_json',return_value=completion()) as request:
                self.service.recognize([PHOTO])
            self.assertEqual(request.call_args.args[2],'env-token')
            self.service.configure({'provider':'zhipuai','model':'glm-4.6v','apiKey':'stored-token','lookup':False})
            with patch('server.recognition.read_json',return_value=completion()) as request:
                self.service.recognize([PHOTO])
            self.assertEqual(request.call_args.args[2],'stored-token')
        self.service.configure({'provider':'zhipuai','model':'glm-4.6v','clearKey':True,'lookup':False})
        self.assertEqual(self.service.public_config()['keySource'],'')
        self.assertEqual(self.service.public_config()['envName'],'ZHIPU_API_KEY')
    def test_legacy_config_file_migrates_to_custom_provider(self):
        self.service.config_path.write_text(json.dumps(
            {'baseUrl':'https://old.example/v1','model':'old-vision','apiKey':'old-key','concurrency':2,'lookup':False}),encoding='utf-8')
        service=VisionService(self.store)
        try:
            pub=service.public_config()
            self.assertEqual(pub['provider'],'custom');self.assertEqual(pub['baseUrl'],'https://old.example/v1')
            self.assertEqual(pub['model'],'old-vision');self.assertTrue(pub['hasKey']);self.assertTrue(pub['configured'])
        finally:service.close()

class ProviderProtocolTests(unittest.TestCase):
    def test_real_http_multimodal_request_and_credential_redaction(self):
        captured=[]
        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                captured.append((self.path,json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                data=json.dumps(completion()).encode();self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def log_message(self,*args):pass
        provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);threading.Thread(target=provider.serve_forever,daemon=True).start()
        with tempfile.TemporaryDirectory() as folder:
            service=VisionService(Store(Path(folder)/'albums.sqlite3'))
            try:
                service.configure({'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fixture','lookup':False})
                result=service.recognize([PHOTO,PHOTO]);self.assertEqual(result['fields']['title'],'Fixture Album 2')
                self.assertEqual(captured[0][0],'/v1/chat/completions')
                parts=captured[0][1]['messages'][1]['content'];self.assertEqual(sum(p['type']=='image_url' for p in parts),2)
            finally:service.close()
        provider.shutdown();provider.server_close()

def b64url(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()

def fake_jwt(account='acct-123'):
    return b64url({'alg':'none','typ':'JWT'})+'.'+b64url({'https://api.openai.com/auth':{'chatgpt_account_id':account}})+'.sig'

def sse(events):
    out=b''
    for kind,payload in events:
        out+=f'event: {kind}\ndata: {json.dumps({"type":kind, **payload})}\n\n'.encode()
    return out

class CodexSubscriptionTests(unittest.TestCase):
    """ChatGPT 订阅（Codex）OAuth 登录与 Responses SSE 识别全流程，均打本地桩。"""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.store=Store(self.root/'albums.sqlite3');self.service=VisionService(self.store)
        self.service.configure({'provider':'openai-codex','model':'gpt-5.5','lookup':False})
        grants=[];sse_calls=[]
        class TokenHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                fields=dict(pair.split('=',1) for pair in self.rfile.read(int(self.headers['Content-Length'])).decode().split('&'))
                grants.append(fields.get('grant_type'))
                access=fake_jwt('acct-refreshed') if fields.get('grant_type')=='refresh_token' else fake_jwt()
                data=json.dumps({'access_token':access,'refresh_token':'rt-new','expires_in':3600}).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def log_message(self,*args):pass
        sse_statuses=[200,200,401,200]  # 正常 → 刷新后正常 → 401 触发强制刷新重试 → 重试成功
        class SseHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                status=sse_statuses.pop(0) if sse_statuses else 200
                if status == 200: sse_calls.append((dict(self.headers),body))
                if status == 200:
                    data=sse([('response.output_text.delta',{'delta':'{"fields":{"title":"Fix'}),
                             ('response.output_text.delta',{'delta':'ture"},"warnings":[]}'}),
                             ('response.completed',{'response':{'output':[]}})])
                else:
                    data=b'{"error":{"message":"token expired"}}'
                self.send_response(status);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def log_message(self,*args):pass
        self.grants=grants;self.sse_calls=sse_calls
        self.token_server=ThreadingHTTPServer(('127.0.0.1',0),TokenHandler)
        self.sse_server=ThreadingHTTPServer(('127.0.0.1',0),SseHandler)
        for srv in (self.token_server,self.sse_server): threading.Thread(target=srv.serve_forever,daemon=True).start()
        patches=[patch('server.recognition.CODEX_TOKEN_URL',f'http://127.0.0.1:{self.token_server.server_port}/oauth/token'),
                 patch('server.recognition.CODEX_AUTHORIZE_URL',f'http://127.0.0.1:{self.token_server.server_port}/oauth/authorize'),
                 patch.dict('server.recognition.PROVIDERS',{'openai-codex':{
                     **PROVIDERS['openai-codex'],
                     'baseUrl':f'http://127.0.0.1:{self.sse_server.server_port}'}})]
        for p in patches: p.start();self.addCleanup(p.stop)
    def tearDown(self):
        self.service.executor.shutdown(wait=True,cancel_futures=True)
        self.token_server.shutdown();self.token_server.server_close()
        self.sse_server.shutdown();self.sse_server.server_close()
        self.temp.cleanup()
    def draft(self):
        d=self.store.create_import({'currency':'CNY','status':'domestic'})
        return self.store.upload_import_photo(d['id'],'000.png',PHOTO)
    def wait_group(self, ident, timeout=10):
        deadline=time.time()+timeout
        while time.time()<deadline:
            g=self.store.read_import(ident)['groups'][0]
            if g['status'] in ('done','error'): return g
            time.sleep(0.05)
        raise AssertionError('识别任务超时未完成')
    def login(self):
        flow=self.service.start_login()
        state=parse_qs(urlsplit(flow['url']).query)['state'][0]
        self.service.complete_login(f'http://localhost:1455/auth/callback?code=abc&state={state}')
    def test_login_url_and_paste_back_exchange(self):
        flow=self.service.start_login()
        self.assertIn('/oauth/authorize?',flow['url'])
        for piece in ('client_id=app_EMoamEEZ73f0CkXaXp7hrann','scope=openid+profile+email+offline_access',
                      'code_challenge_method=S256','code_challenge=','state=','codex_cli_simplified_flow=true'):
            self.assertIn(piece,flow['url'])
        with self.assertRaisesRegex(ValidationError,'状态不匹配'):
            self.service.complete_login('http://localhost:1455/auth/callback?code=abc&state=wrong')
        pub=self.service.complete_login(f"http://localhost:1455/auth/callback?code=abc&state={flow['url'].split('state=')[1].split('&')[0]}")
        self.assertEqual(pub['login']['state'],'ok');self.assertTrue(pub['login']['expires']>0)
        self.assertNotIn('access',json.dumps(pub))
        self.assertEqual(self.service.config['tokens']['openai-codex']['accountId'],'acct-123')
        self.assertEqual(self.service.config_path.stat().st_mode & 0o777,0o600)
        self.assertEqual(self.grants,['authorization_code'])
    def test_recognize_over_sse_with_refresh_retry_and_logout(self):
        self.login()
        d=self.draft();self.service.start({'id':d['id'],'groupIds':[d['groups'][0]['id']]})
        done=self.wait_group(d['id'])
        self.assertEqual(done['status'],'done');self.assertEqual(done['fields']['title'],'Fixture')
        headers,body=self.sse_calls[0]
        lower={k.lower():v for k,v in headers.items()}
        self.assertEqual(lower['authorization'],'Bearer '+fake_jwt())
        self.assertEqual(lower['chatgpt-account-id'],'acct-123');self.assertEqual(lower['originator'],'pi')
        self.assertFalse(body['store']);self.assertTrue(body['stream'])
        self.assertIn('你负责根据同一个实体 CD',body['instructions'])
        self.assertEqual([p['type'] for p in body['input'][0]['content']],['input_text','input_image'])
        self.assertTrue(body['input'][0]['content'][1]['image_url'].startswith('data:image/png;base64,'))
        # 令牌过期 → 识别前自动刷新（refresh_token），无需人工干预
        with self.service.config_lock: self.service.config['tokens']['openai-codex']['expires']=0
        d2=self.draft();self.service.start({'id':d2['id'],'groupIds':[d2['groups'][0]['id']]})
        self.assertEqual(self.wait_group(d2['id'])['status'],'done')
        self.assertEqual(self.service.config['tokens']['openai-codex']['accountId'],'acct-refreshed')
        # 服务端 401 → 强制刷新后自动重试一次成功
        d3=self.draft();self.service.start({'id':d3['id'],'groupIds':[d3['groups'][0]['id']]})
        self.assertEqual(self.wait_group(d3['id'])['status'],'done')
        self.assertIn('refresh_token',self.grants)
        pub=self.service.logout()
        self.assertEqual(pub['login']['state'],'none')

if __name__=='__main__':unittest.main()
