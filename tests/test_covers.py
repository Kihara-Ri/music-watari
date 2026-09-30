import json
import unittest
from unittest.mock import patch
from covers import CoverService, artwork_url, normalized
from domain import ValidationError

class CoverTests(unittest.TestCase):
    def test_normalization(self):
        self.assertEqual(normalized('Ｆirst Love'),normalized('First Love'))
    def test_only_apple_images(self):
        for url in ['http://is1-ssl.mzstatic.com/a.jpg','https://evil-mzstatic.com/a','https://127.0.0.1/a','file:///etc/passwd','https://is1-ssl.mzstatic.com:9000/a']:
            with self.assertRaises(ValidationError):artwork_url(url)
    def test_search_ranking_cache_download(self):
        service=CoverService()
        results={'results':[{'collectionId':1,'collectionName':'First Love','artistName':'宇多田ヒカル','artworkUrl100':'https://is1-ssl.mzstatic.com/a/100x100bb.jpg','releaseDate':'1999-03-10'}, {'collectionId':2,'collectionName':'First Love','artistName':'Other Artist','artworkUrl100':'https://is1-ssl.mzstatic.com/b/100x100bb.jpg'}]}
        with patch.object(service,'read',return_value=json.dumps(results).encode()) as read:
            result=service.search('First Love','宇多田ヒカル','JP');service.search('First Love','宇多田ヒカル','JP');self.assertEqual(read.call_count,1)
            self.assertTrue(result['candidates'][0]['exact']);self.assertFalse(result['candidates'][1]['exact'])
        with patch.object(service,'read',return_value=b'\xff\xd8\xfftest'):
            image=service.download('JP-1');self.assertTrue(image['cover'].startswith('data:image/jpeg;base64,'));self.assertEqual(image['coverSource']['title'],'First Love')
    def test_empty_and_bad_artwork(self):
        service=CoverService()
        with patch.object(service,'read',return_value=b'{"results":[]}'):
            self.assertEqual(service.search('Unknown','Nobody','JP')['candidates'],[])
        with self.assertRaises(ValidationError):service.download('JP-unknown')
    def test_download_rejects_html(self):
        service=CoverService();service.choices['x']={'url':'https://is1-ssl.mzstatic.com/a.jpg'}
        with patch.object(service,'read',return_value=b'<html>error</html>'):
            with self.assertRaises(ValidationError):service.download('x')
    def test_rate_limit(self):
        service=CoverService()
        with patch.object(service,'read',return_value=b'{"results":[]}'):
            service.search('A','B','JP')
            with self.assertRaises(ValidationError):service.search('C','D','JP')

if __name__=='__main__':unittest.main()

class ArtistVariantTests(unittest.TestCase):
    from covers import artist_variants, artist_matches
    def test_cv_roles_stripped(self):
        from covers import artist_variants, artist_matches
        v=artist_variants('雪ノ下雪乃(CV.早見沙織)＆由比ヶ浜結衣(CV.東山奈央)')
        self.assertIn('雪ノ下雪乃',v);self.assertIn('由比ヶ浜結衣',v)
        self.assertTrue(artist_matches('雪ノ下雪乃(CV.早見沙織)＆由比ヶ浜結衣(CV.東山奈央)','雪ノ下雪乃'))
        self.assertTrue(artist_matches('雪ノ下雪乃(CV.早見沙織)＆由比ヶ浜結衣(CV.東山奈央)','雪ノ下雪乃＆由比ヶ浜結衣'))
    def test_punct_and_fuzzy(self):
        from covers import artist_matches, artist_variants
        v=artist_variants('Godspeed You! Black Emperor')
        self.assertIn('Godspeed You Black Emperor',v)
        self.assertTrue(artist_matches('Godspeed You! Black Emperor','Godspeed You Black Emperor'))
        self.assertTrue(artist_matches('Godspeed You! Black Emperor','Godspeed You! Black Emperor!'))
        self.assertFalse(artist_matches('Godspeed You! Black Emperor','Oasis'))
    def test_loose_threshold(self):
        from covers import artist_matches
        self.assertTrue(artist_matches('ミセカイノヒミツ','ミセカイのヒミツ',loose=True))
        self.assertFalse(artist_matches('ヨルシカ','Mrs. GREEN APPLE'))

class PrefixScoringTests(unittest.TestCase):
    """候选打分：标题与官方发行名互为前缀按强匹配计（exact 仍要求全等）。"""

    def setUp(self):
        self.svc = CoverService()
        self.url = 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/x/jacket.jpg/100x100bb.jpg'

    def test_short_title_prefix_of_full_release_is_strong(self):
        c = self.svc.candidate('歌物語2', '物語シリーズ', '歌物語2 -〈物語〉シリーズ主題歌集-',
                               '物語シリーズ', 'JP-1537811231', self.url, '2015', country='JP')
        self.assertGreaterEqual(c['score'], 0.65)  # 曾经 0.639 被门槛过滤
        self.assertFalse(c['exact'])  # 不自动带入，只进候选

    def test_reverse_prefix_also_strong(self):
        c = self.svc.candidate('歌物語2 -〈物語〉シリーズ主題歌集-', '物語シリーズ', '歌物語2',
                               '物語シリーズ', 'JP-2', self.url, '2015', country='JP')
        self.assertGreaterEqual(c['score'], 0.65)

    def test_exact_scoring_unchanged(self):
        c = self.svc.candidate('歌物語2', '物語シリーズ', '歌物語2',
                               '物語シリーズ', 'JP-3', self.url, '2015', country='JP')
        self.assertEqual(c['score'], 1.0)
        self.assertTrue(c['exact'])

    def test_unrelated_title_stays_low(self):
        c = self.svc.candidate('まちカドまぞく', '物語シリーズ', '歌物語2 -〈物語〉シリーズ主題歌集-',
                               '物語シリーズ', 'JP-4', self.url, '2015', country='JP')
        self.assertLess(c['score'], 0.65)

    def test_single_char_prefix_not_boosted(self):
        c = self.svc.candidate('歌', '物語シリーズ', '歌物語2 -〈物語〉シリーズ主題歌集-',
                               '物語シリーズ', 'JP-5', self.url, '2015', country='JP')
        self.assertLess(c['score'], 0.65)

class GroupCdFrontTests(unittest.TestCase):
    def test_prefers_cd_release_front(self):
        from covers import CoverService
        s=CoverService()
        def meta(url):
            if 'ws/2/release?' in url:
                return {'releases':[{'id':'vinyl-rel','media':[{'format':'Vinyl'}]},{'id':'cd-rel','media':[{'format':'CD'}]}]}
            if url.endswith('/release/cd-rel'):
                return {'images':[{'front':True,'approved':True,'thumbnails':{'500':'https://coverartarchive.org/release/cd-rel/f-500.jpg'}}]}
            if url.endswith('/release/vinyl-rel'):
                return {'images':[{'front':True,'approved':True,'thumbnails':{'500':'https://coverartarchive.org/release/vinyl-rel/v-500.jpg'}}]}
            raise AssertionError('unexpected '+url)
        with patch.object(s,'metadata',side_effect=meta):
            u=s.group_cd_front('g' * 36)
            self.assertEqual(u,'https://coverartarchive.org/release/cd-rel/f-500.jpg')
    def test_falls_back_to_no_cd(self):
        from covers import CoverService
        s=CoverService()
        def meta(url):
            if 'ws/2/release?' in url: return {'releases':[{'id':'r1','media':[{'format':'Vinyl'}]}]}
            if url.endswith('/release/r1'): return {'images':[]}
            raise AssertionError('unexpected '+url)
        with patch.object(s,'metadata',side_effect=meta):
            self.assertIsNone(s.group_cd_front('g' * 36))
