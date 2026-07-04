#!/usr/bin/env node
// ============================================================================
// 单账号 CloakBrowser 注册 worker（CLI 入口）
// ----------------------------------------------------------------------------
// 用法：node worker.js '<job-json>'      （job 也可从 stdin 首行读入）
// job JSON 字段：
//   { email, proxyUrl, fingerprintSeed, enable2fa, headless,
//     chatgptUrl, timeoutMs, locale, loginPassword, existingTotpSecret,
//     forceReset2fa, mode, dryRun }
// 通过 NDJSON 与 Python 编排器通信（见 protocol.js）。验证码由 Python 经 requestCode 回传。
// 无论成功/失败，退出前必发一条终态事件（result / error），避免 Python 悬挂。
// ============================================================================

import { emit, log, requestCode, onStop, startStdin } from './protocol.js';
import { launchSession } from './cloakbrowser.js';
import { sleep } from './utils.js';
import { registerChatGPT, secureExistingChatGPT } from './flows/openai/register.js';

function parseJob() {
  const raw = process.argv[2];
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { throw new Error(`job JSON 解析失败：${e.message}`); }
  }
  return null; // 允许从 stdin 首行读入（见 main）
}

function readJobFromStdin(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('等待 stdin job JSON 超时')), timeoutMs);
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl).trim();
        try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`stdin job JSON 解析失败：${e.message}`)); }
      }
    });
  });
}

// dryRun：不启浏览器，回放 log → need_code → result，用于协议/集成测试。
async function runDryRun(job) {
  log('dryRun：开始（不启动浏览器）');
  const code = await requestCode('register');
  log(`dryRun：收到验证码 ${code}`);
  emit({
    type: 'result',
    data: {
      email: job.email || 'dry@example.com',
      accessToken: 'dry-access-token',
      password: 'DryRunPassw0rd!',
      passwordSet: true,
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      twoFactorUri: 'otpauth://totp/ChatGPT:dry?secret=JBSWY3DPEHPK3PXP&issuer=OpenAI',
      recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'],
      twoFactorSet: true,
      fingerprintSeed: job.fingerprintSeed || 12345,
      mode: 'register',
      user: { email: job.email || 'dry@example.com' },
      expires: null,
    },
  });
}

async function runReal(job) {
  const timeoutMs = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : 300000;
  let session = null;
  onStop(() => { if (session) session.close().catch(() => {}); });

  const flow = (async () => {
    session = await launchSession(job.proxyUrl || '', {
      headless: Boolean(job.headless),
      fingerprintSeed: Number.isInteger(job.fingerprintSeed) ? job.fingerprintSeed : null,
      log: (m) => log(m),
    });
    const seed = session.seed;
    const page = await session.context.newPage();
    page.setDefaultTimeout(45000);

    const common = {
      page,
      email: job.email,
      chatgptUrl: job.chatgptUrl || 'https://chatgpt.com/',
      enable2fa: job.enable2fa !== false,
      requestCode,
      log: (m, level) => log(m, level),
    };

    let data;
    if (job.mode === 'existing') {
      // 明确的老账号加固流程
      data = await secureExistingChatGPT({
        ...common,
        loginPassword: job.loginPassword || '',
        existingTotpSecret: job.existingTotpSecret || '',
        forceReset2fa: Boolean(job.forceReset2fa),
      });
    } else {
      // 默认走注册；若邮箱已注册，自动切换到老账号加固流程
      const reg = await registerChatGPT(common);
      if (reg && reg.emailExists) {
        log('邮箱已注册，切换到老账号（登录 → 设密码 → 2FA）流程');
        data = await secureExistingChatGPT({
          ...common,
          loginPassword: job.loginPassword || '',
          existingTotpSecret: job.existingTotpSecret || '',
          forceReset2fa: Boolean(job.forceReset2fa),
        });
      } else {
        data = reg;
      }
    }
    data.fingerprintSeed = seed;
    return data;
  })();

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`整轮超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  });

  try {
    const data = await Promise.race([flow, timeout]);
    emit({ type: 'result', data });
  } catch (err) {
    emit({ type: 'error', message: String(err?.message || err), partial: err?._partial || {} });
  } finally {
    if (session) { try { await session.close(); } catch { /* ignore */ } }
  }
}

async function main() {
  startStdin();
  let job;
  try {
    job = parseJob();
    if (!job) job = await readJobFromStdin();
  } catch (e) {
    emit({ type: 'error', message: String(e?.message || e), partial: {} });
    await sleep(50);
    process.exit(0);
  }

  try {
    if (job.dryRun) await runDryRun(job);
    else await runReal(job);
  } catch (e) {
    // runReal 内部已兜底 emit；这里再兜一层，确保任何异常都有终态事件
    emit({ type: 'error', message: String(e?.message || e), partial: e?._partial || {} });
  }

  await sleep(50); // 给 stdout flush 一点时间
  process.exit(0);
}

process.on('uncaughtException', (e) => {
  emit({ type: 'error', message: `uncaughtException: ${e?.message || e}`, partial: {} });
  setTimeout(() => process.exit(0), 50);
});
process.on('unhandledRejection', (e) => {
  emit({ type: 'error', message: `unhandledRejection: ${e?.message || e}`, partial: {} });
  setTimeout(() => process.exit(0), 50);
});

main();
