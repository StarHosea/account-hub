#!/bin/sh
set -e

# ============================================================================
# 容器入口：CloakBrowser 浏览器注册引擎在 Linux 上以「Xvfb 有头」运行。
# 用 xvfb-run 提供一个虚拟 X 显示，uvicorn 及其派生的 node 子进程共享 DISPLAY，
# 从而让 headless=false 的 Chromium 能在无物理显示的服务器上跑起来（反爬更稳）。
# 若确实要无头运行，把注册配置里的 headless 设为 true 即可（Xvfb 存在但不影响）。
# ============================================================================

exec xvfb-run -a --server-args="-screen 0 1280x800x24 -ac -nolisten tcp" \
  uv run uvicorn main:app --host 0.0.0.0 --port 80 --access-log
