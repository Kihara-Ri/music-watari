"""HTTP 层：路由表、静态文件服务、CSV 导出。

app.py 仍是唯一入口（CLI 与服务组装）。导入本包不创建任何数据库、不启动
任何线程——所有依赖经 Services 注入，测试因此可以构造完全隔离的 handler。
"""
from .context import Services
from .http import make_handler

__all__ = ['Services', 'make_handler']
