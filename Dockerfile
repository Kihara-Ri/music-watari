# 碟渡 · 多阶段构建：Node 构建前端 → 纯标准库 Python 运行时
# 镜像内零第三方 Python 依赖；数据全部在 /data 卷，与代码解耦。

# ── 阶段 1：前端构建 ──
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# vite outDir=../static → 产物输出到 /static
RUN npm run build

# ── 阶段 2：运行时 ──
FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py domain.py storage.py covers.py cjkvariants.py rates.py security.py backups.py ./
COPY server/ server/
COPY static/ static/
COPY --from=web /static/index.html static/index.html
COPY --from=web /static/assets/ static/assets/

ENV HOST=0.0.0.0 PORT=8765 DATA_DIR=/data TZ=Asia/Shanghai
VOLUME /data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python3", "-c", "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=4).getcode()==200 else 1)"]

CMD ["python3", "app.py"]
