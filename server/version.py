"""构建版本：发布包里带 VERSION 文件（git describe 生成），本地无则为 dev。

用途：/api/health 与 /api/state 的 service.version，识别线上到底跑的哪一版。
"""
import time
from pathlib import Path

_START = time.time()


def version() -> str:
    f = Path(__file__).resolve().parents[1] / 'VERSION'
    return f.read_text().strip() if f.exists() else 'dev'


def uptime() -> int:
    """进程运行秒数（从本包导入时刻起算）。"""
    return int(time.time() - _START)
