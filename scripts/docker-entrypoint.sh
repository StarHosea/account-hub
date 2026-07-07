#!/bin/sh
set -e

# ============================================================================
# 容器入口：CloakBrowser 浏览器注册引擎在 Linux 上以「Xvfb 有头」运行。
# 需要一个虚拟 X 显示，uvicorn 及其派生的 node 子进程共享 DISPLAY，
# 从而让 headless=false 的 Chromium 能在无物理显示的服务器上跑起来（反爬更稳）。
# 若确实要无头运行，把注册配置里的 headless 设为 true 即可（Xvfb 存在但不影响）。
#
# 对齐 CloakBrowser 官方 Docker 入口：1920x1080 Xvfb + openbox（--start-maximized 生效）
# + xdotool 轮询确认 X 就绪；生产默认禁止静默回退到无 stealth 的 Chromium。
#
# 【为何不再用 `xvfb-run … uv run uvicorn`】
# 1) uv run 之坑：镜像构建期用 `uv sync --frozen --no-dev` 生成 .venv（不含 dev
#    依赖如 httpx）。运行期若用 `uv run`，uv 会重新校验/同步环境，发现 dev 组的
#    httpx 未安装便尝试联网到 PyPI 下载；服务器网络慢/镜像不可达时便长时间阻塞，
#    uvicorn 永远起不来 → 容器 Up 但 80 无监听 → 反代 502。改为直接执行 .venv 里的
#    uvicorn，完全跳过运行期 sync，起动不依赖网络。
# 2) xvfb-run 之坑：xvfb-run 用 `trap USR1 + wait` 等 Xvfb 就绪信号；当它作为容器
#    PID 1 运行时，该 wait 语义异常，脚本卡在等待处、永远到不了执行真正命令那一步
#    （现象同样是容器 Up 但无 uvicorn 子进程）。因此这里自己拉起 Xvfb 到后台，再用
#    exec 让 uvicorn 成为 PID 1，彻底绕开 xvfb-run 的 PID 1 陷阱。
# ============================================================================

export CLOAK_FALLBACK_CHROMIUM=false

# 清理上次容器残留的 X lock（/tmp 非 tmpfs 时 restart 会留下死锁）。
DISPLAY_NUM=99
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
export DISPLAY=":${DISPLAY_NUM}"

# 后台拉起虚拟显示；uvicorn 及其派生 node 子进程通过继承的 DISPLAY 共享它。
Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac -nolisten tcp &
XVFB_PID=$!
OPENBOX_PID=""

# 容器停止时一并清理 Xvfb / openbox。
trap 'kill "${OPENBOX_PID}" 2>/dev/null || true; kill "${XVFB_PID}" 2>/dev/null || true' TERM INT

# 用 xdotool 确认 X 已接受连接（最多 ~10s），避免 openbox/Chromium 抢跑。
i=0
while [ "$i" -lt 50 ]; do
  if DISPLAY="${DISPLAY}" xdotool getdisplaygeometry >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

# 窗口管理器：无 WM 时 Chromium --start-maximized 是 silent no-op。
DISPLAY="${DISPLAY}" openbox &
OPENBOX_PID=$!

# uvicorn 成为 PID 1，正确接收信号、被 docker restart/stop 正常管理。
exec /app/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 80 --access-log
