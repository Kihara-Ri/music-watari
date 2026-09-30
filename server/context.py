"""每个服务器实例注入的依赖集合，路由函数只通过它访问业务模块。"""
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Services:
    store: Any                       # storage.Store —— 专辑/销售/包裹持久化
    auth: Optional[Any] = None       # security.Auth —— None 表示本机模式不启用登录
    backups: Optional[Any] = None    # backups.Backups —— 状态展示于 /api/state
    covers: Optional[Any] = None     # covers.CoverService —— /api/covers/*
    rates: Optional[Any] = None      # rates.RateService —— /api/rate
    public_origin: Optional[str] = None  # 反向代理场景下放行的 HTTPS 根地址
