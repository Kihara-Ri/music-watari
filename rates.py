"""Historical JPY→CNY rates from the ECB mirror (frankfurter.dev), cached in SQLite.

Rates are quoted as CNY per 100 JPY. Weekends and ECB holidays have no quote;
a purchase on such a day uses the most recent earlier business day.
"""
import json
import sqlite3
import threading
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = 'AlbumLedger/2.0 (personal local album inventory)'
SOURCES = ('https://api.frankfurter.dev/v1', 'https://api.frankfurter.app/v1')


class RateUnavailable(Exception):
    pass


class RateService:
    """Thread-safe rate lookup with on-disk cache; failures return None, never raise."""

    def __init__(self, cache_path=None, fetch=None):
        self.cache_path = cache_path
        self.fetch = fetch or self._http_fetch
        self.lock = threading.Lock()
        self.mem = {}
        if cache_path:
            Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(cache_path)) as db, db:
                db.execute('CREATE TABLE IF NOT EXISTS rates(day TEXT PRIMARY KEY, per100 TEXT)')

    def _http_fetch(self, start, end):
        """Return {iso-day: Decimal-per-100} for the window, trying both mirrors."""
        query = urlencode({'from': 'JPY', 'to': 'CNY'})
        last = None
        for base in SOURCES:
            url = f'{base}/{start}..{end}?{query}'
            try:
                req = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
                with urlopen(req, timeout=15) as response:
                    payload = json.loads(response.read(1 << 20).decode())
                rates = payload.get('rates') or {}
                if not isinstance(rates, dict):
                    raise ValueError('unexpected payload')
                from decimal import Decimal
                return {day: Decimal(str(body['CNY'])) * 100 for day, body in rates.items() if isinstance(body, dict) and 'CNY' in body}
            except Exception as exc:  # try the next mirror
                last = exc
        raise RateUnavailable(str(last))

    def _cached(self, day):
        earlier = [d for d in self.mem if d <= day]
        if earlier:
            return self.mem[max(earlier)]
        if not self.cache_path:
            return None
        with closing(sqlite3.connect(self.cache_path)) as db:
            row = db.execute('SELECT per100 FROM rates WHERE day<=? ORDER BY day DESC LIMIT 1', (day,)).fetchone()
            return row[0] if row else None

    def _store(self, found):
        if not found:
            return
        self.mem.update({d: str(v) for d, v in found.items()})
        if self.cache_path:
            with closing(sqlite3.connect(self.cache_path)) as db, db:
                db.executemany('INSERT OR REPLACE INTO rates VALUES(?,?)', [(d, str(v)) for d, v in found.items()])

    def get(self, day):
        """Rate (str per-100) for the purchase date, or None when unavailable."""
        if not day:
            return None
        day = str(day)[:10]
        try:
            date.fromisoformat(day)
        except ValueError:
            return None
        with self.lock:
            hit = self._cached(day)
            if hit:
                return hit
            start = (date.fromisoformat(day) - timedelta(days=14)).isoformat()
            try:
                found = self.fetch(start, day)
            except RateUnavailable:
                return None
            self._store(found)
            hit = self._cached(day)
            return hit

    def warm(self, days):
        """Prefetch rates for many days with one request per distinct window."""
        days = sorted({str(d)[:10] for d in days if d})
        for i in range(0, len(days), 60):
            chunk = days[i:i + 60]
            start = (date.fromisoformat(chunk[0]) - timedelta(days=14)).isoformat()
            end = chunk[-1]
            with self.lock:
                try:
                    self._store(self.fetch(start, end))
                except RateUnavailable:
                    pass

    def status(self):
        if not self.cache_path:
            return {'days': len(self.mem), 'latest': max(self.mem) if self.mem else None}
        with closing(sqlite3.connect(self.cache_path)) as db:
            row = db.execute('SELECT COUNT(*), MAX(day) FROM rates').fetchone()
            return {'days': row[0], 'latest': row[1]}
