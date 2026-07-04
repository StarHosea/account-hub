#!/usr/bin/env node
// ============================================================================
// 构建期预下载 CloakBrowser 的 stealth Chromium 二进制（~200MB），
// 避免容器首次注册时才现场下载导致长时间阻塞/超时。
//
// CloakBrowser 不同版本的下载入口不统一，这里按已知形态逐一尝试：
//   1) 模块导出 ensureBinary() / installBinary() / install() / download()
//   2) 退化为 CLI：npx cloakbrowser install
// 全部失败也不让构建挂掉（打印警告，运行期再兜底下载）。
// 若下载需要授权，设置环境变量/构建 ARG：CLOAKBROWSER_LICENSE_KEY。
// ============================================================================

import { spawnSync } from 'node:child_process';

async function tryModuleInstall() {
  let mod;
  try {
    mod = await import('cloakbrowser');
  } catch (e) {
    console.warn(`[install-binary] 无法 import cloakbrowser：${e?.message || e}`);
    return false;
  }
  const candidates = ['ensureBinary', 'installBinary', 'install', 'download', 'ensureChromium'];
  const targets = [mod, mod.default].filter(Boolean);
  for (const t of targets) {
    for (const name of candidates) {
      if (typeof t[name] === 'function') {
        try {
          console.log(`[install-binary] 调用 cloakbrowser.${name}() 预下载 Chromium…`);
          await t[name]();
          console.log('[install-binary] Chromium 预下载完成');
          return true;
        } catch (e) {
          console.warn(`[install-binary] cloakbrowser.${name}() 失败：${e?.message || e}`);
        }
      }
    }
  }
  return false;
}

function tryCliInstall() {
  console.log('[install-binary] 退化尝试：npx cloakbrowser install');
  const r = spawnSync('npx', ['--yes', 'cloakbrowser', 'install'], {
    stdio: 'inherit',
    env: process.env,
  });
  return r.status === 0;
}

async function main() {
  const ok = (await tryModuleInstall()) || tryCliInstall();
  if (!ok) {
    console.warn('[install-binary] 未能在构建期预下载 CloakBrowser Chromium；运行期将按需下载。');
  }
  // 无论成功与否都以 0 退出，避免打断镜像构建
  process.exit(0);
}

main();
