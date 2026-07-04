#!/bin/sh
set -e

# ============================================================================
# 容器入口：CloakBrowser 浏览器注册引擎在 Linux 上以「Xvfb 有头」运行。
# 需要一个虚拟 X 显示，uvicorn 及其派生的 node 子进程共享 DISPLAY，
# 从而让 headless=false 的 Chromium 能在无物理显示的服务器上跑起来（反爬更稳）。
# 若确实要无头运行，把注册配置里的 headless 设为 true 即可（Xvfb 存在但不影响）。
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

# 选一个空闲的 X display 号（避免与残留锁冲突）。
DISPLAY_NUM=99
while [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; do
  DISPLAY_NUM=$((DISPLAY_NUM + 1))
done
export DISPLAY=":${DISPLAY_NUM}"

# 后台拉起虚拟显示；uvicorn 及其派生 node 子进程通过继承的 DISPLAY 共享它。
Xvfb "${DISPLAY}" -screen 0 1280x800x24 -ac -nolisten tcp &
XVFB_PID=$!

# 容器停止时一并清理 Xvfb。
trap 'kill "${XVFB_PID}" 2>/dev/null || true' TERM INT

# 简单等待 Xvfb 就绪（最多 ~5s），失败也不致命：headless=true 场景不需要它。
i=0
while [ "$i" -lt 50 ]; do
  if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

# uvicorn 成为 PID 1，正确接收信号、被 docker restart/stop 正常管理。
exec /app/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 80 --access-log
