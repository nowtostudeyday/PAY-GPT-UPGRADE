# ============================================================
# ChatGPT Plus 自动化开通工具 — Docker 镜像
# Node.js 20 + Playwright Chromium + hCaptcha Python solver
# ============================================================
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HCAPTCHA_SOLVER_PYTHON=/usr/bin/python3 \
    HCAPTCHA_SOLVER_SCRIPT=/app/hcaptcha/solver.py \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# 系统依赖：Playwright Chromium + Python3 + OpenCV 运行时库
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl ca-certificates fonts-liberation fonts-noto-cjk \
    python3 python3-pip python-is-python3 \
    xvfb x11vnc fluxbox novnc websockify \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
    libxshmfence1 xdg-utils procps \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node 依赖
COPY package.json package-lock.json* ./
RUN npm install --production --ignore-scripts

# Playwright Chromium（Node 自动化 + Python solver 共用同一路径）
RUN npx playwright install chromium

# hCaptcha solver Python 依赖（CPU 版 PyTorch，体积较大，首次 build 需数分钟）
COPY requirements-hcaptcha.txt ./
RUN pip install -r requirements-hcaptcha.txt \
    && python3 -m playwright install chromium

# 复制源码（含 hcaptcha solver）
COPY . .

RUN mkdir -p debug_screenshots product_files /tmp/hcaptcha_auto_solver_live \
    && chmod +x docker_entrypoint.sh

ENV NODE_ENV=production \
    RUNNING_IN_DOCKER=1 \
    PORT=3000 \
    HEADFUL=0 \
    CDP_PORT=9222 \
    CDP_URL=http://127.0.0.1:9222

EXPOSE 3000 6080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/api/public/runtime || exit 1

ENTRYPOINT ["/app/docker_entrypoint.sh"]
CMD ["node", "server.js"]
