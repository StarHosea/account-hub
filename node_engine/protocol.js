// ============================================================================
// NDJSON stdio 协议：Node 引擎 ↔ Python 编排器
// ----------------------------------------------------------------------------
// Node → Python（stdout，每行一个 JSON）：
//   { type:"log",  level:"info"|"warn"|"error", message }
//   { type:"need_code", purpose:"register"|"login"|"password"|"2fa", ts }
//   { type:"result", data:{...} }
//   { type:"error",  message, partial:{...} }
// Python → Node（stdin，每行一个 JSON）：
//   { type:"code", code:"123456"|null, received_at:"2026-07-06 13:05:50"|null }
//   { type:"stop" }
//
// 流程严格串行：任一时刻最多一个 requestCode 在等待。Python 收到 need_code 后
// 按 ts 过滤旧码并轮询（单轮约 90s）；超时回 code:null → Node 点「重新发送」再发下一轮 need_code。
// ============================================================================

import readline from 'node:readline';

let _pendingCode = null;   // { resolve, reject }
let _stopped = false;
const _stopHandlers = [];

// 写一行 NDJSON 到 stdout（stdout 只用于协议事件；调试信息一律走 stderr）。
export function emit(evt) {
  try {
    process.stdout.write(JSON.stringify(evt) + '\n');
  } catch {
    // stdout 断开（Python 已退出）——触发停止，避免悬挂
    triggerStop();
  }
}

export function log(message, level = 'info') {
  emit({ type: 'log', level, message: String(message) });
}

// 请求一个验证码：发 need_code 并阻塞，直到 Python 回一条 code。
// code 为 null 时抛错（取码超时），由上层流程决定失败。
export function requestCode(purpose = 'register') {
  if (_stopped) return Promise.reject(new Error('已收到停止指令'));
  emit({ type: 'need_code', purpose, ts: new Date().toISOString() });
  return new Promise((resolve, reject) => {
    _pendingCode = { resolve, reject };
  });
}

export function onStop(handler) {
  if (typeof handler === 'function') _stopHandlers.push(handler);
}

function triggerStop() {
  if (_stopped) return;
  _stopped = true;
  if (_pendingCode) {
    _pendingCode.reject(new Error('已收到停止指令'));
    _pendingCode = null;
  }
  for (const h of _stopHandlers) {
    try { h(); } catch { /* ignore */ }
  }
}

function handleCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  if (cmd.type === 'code') {
    if (_pendingCode) {
      const p = _pendingCode;
      _pendingCode = null;
      const code = cmd.code == null ? null : String(cmd.code);
      if (code) {
        p.resolve({
          code,
          receivedAt: cmd.received_at == null ? null : String(cmd.received_at),
        });
      } else {
        p.reject(new Error('取码超时（Python 侧未拿到验证码）'));
      }
    }
    return;
  }
  if (cmd.type === 'stop') {
    triggerStop();
  }
}

// 启动 stdin 读取器（在 worker 入口调用一次）。
export function startStdin() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = String(line || '').trim();
    if (!s) return;
    let cmd;
    try { cmd = JSON.parse(s); } catch { return; }
    handleCommand(cmd);
  });
  rl.on('close', () => triggerStop());
  return rl;
}

export function isStopped() {
  return _stopped;
}

export default { emit, log, requestCode, onStop, startStdin, isStopped };
