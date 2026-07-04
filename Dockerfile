ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH

FROM --platform=$BUILDPLATFORM node:22-alpine AS web-build

WORKDIR /app/web

COPY web/package.json ./
RUN npm install

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN VERSION="$(cat /app/VERSION)" npm run build


FROM --platform=$TARGETPLATFORM python:3.13-slim AS app

ARG TARGETPLATFORM
ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# 安装系统依赖
# - git: Git 存储后端需要
# - libpq-dev: PostgreSQL 客户端库
# - gcc: 编译 psycopg2-binary 需要
# - xvfb + xdotool + Chromium 运行库/多语言字体: CloakBrowser 浏览器注册引擎在 Linux 上以「Xvfb 有头」运行
#   （系统库/字体对齐 CloakBrowser 官方 Dockerfile，避免有头 Chromium 缺库/缺字体导致启动失败或指纹异常）
# - nodejs 20 (NodeSource): 运行 node_engine（playwright-core >=1.53 需较新 Node）
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libpq-dev \
    gcc \
    openssl \
    ca-certificates \
    curl \
    gnupg \
    xvfb xdotool \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 libdrm2 \
    libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libcairo-gobject2 libasound2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxshmfence1 libfontconfig1 \
    libglib2.0-0 libgtk-3-0 libgdk-pixbuf-2.0-0 libxss1 libxtst6 \
    fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-freefont-ttf \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY main.py ./
COPY VERSION ./
COPY api ./api
COPY services ./services
COPY utils ./utils
COPY scripts ./scripts
COPY --from=web-build /app/web/dist ./web_dist

# CloakBrowser 浏览器注册引擎：安装 Node 依赖并在构建期预下载 stealth Chromium（~200MB），
# 避免容器首次注册时才现场下载导致长时间阻塞/超时。若下载需授权，构建时传入：
#   docker build --build-arg CLOAKBROWSER_LICENSE_KEY=xxxx ...
ARG CLOAKBROWSER_LICENSE_KEY=""
COPY node_engine ./node_engine
RUN cd node_engine \
    && npm install --omit=dev --no-audit --no-fund \
    && CLOAKBROWSER_LICENSE_KEY="$CLOAKBROWSER_LICENSE_KEY" node scripts/install-binary.js

EXPOSE 80

# 入口：先起 Xvfb（有头虚拟显示），再拉起 uvicorn；注册派生的 node 子进程共享 DISPLAY。
CMD ["sh", "/app/scripts/docker-entrypoint.sh"]
