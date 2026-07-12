#!/usr/bin/env node
// ============================================================================
// 单账号 CloakBrowser 注册 worker（CLI 入口）
// ----------------------------------------------------------------------------
// 用法：node worker.js '<job-json>'      （job 也可从 stdin 首行读入）
// job JSON 字段：
//   { email, proxyUrl, fingerprintSeed, enable2fa, autoSetPassword, headless,
//     chatgptUrl, timeoutMs, locale, loginPassword, existingTotpSecret,
//     forceReset2fa, mode, dryRun }
// 通过 NDJSON 与 Python 编排器通信（见 protocol.js）。验证码由 Python 经 requestCode 回传。
// 无论成功/失败，退出前必发一条终态事件（result / error），避免 Python 悬挂。
// ============================================================================

import { emit, log, requestCode, onStop, startStdin } from './protocol.js';
import { launchSession } from './cloakbrowser.js';
import { sleep } from './utils.js';
import { registerChatGPT, secureExistingChatGPT, loginChatGPT } from './flows/openai/register.js';
import { createRecorder } from './flows/openai/dom-recorder.js';
import { attachStaticCache } from './static-cache.js';

// DOM 记录：优先读 job.recordDir / job.recordKeep（注册设置下发），CLI 联调可退化环境变量。
function recordDirFor(job) {
  const root = String(job.recordDir || '').trim()
    || process.env.REG_RECORD_DIR
    || (process.env.REG_DIAG_DIR ? `${process.env.REG_DIAG_DIR}/recordings` : '');
  if (!root) return '';
  const safe = String(job.email || 'acct').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
  return `${root}/${safe}-${Date.now()}`;
}

// 只要主 frame 浏览器地址变化，就单独打一行 [URL] 日志（不与业务日志混行），
// 便于按页面路径精准定位当前步骤/卡点。ChatGPT 是 SPA：很多跳转走 history.pushState/
// 改 hash（如 #settings、/log-in/password 内部路由），不触发 framenavigated——
// 故 framenavigated 即时打真实跳转，再叠一个轻量轮询兜底 SPA/hash 变化，零遗漏。
function attachUrlLogger(page, log) {
  let last = '';
  const emitIfChanged = () => {
    let url = '';
    try { url = page.url(); } catch { return; }
    if (!url || url === 'about:blank' || url === last) return;
    last = url;
    try {
      const u = new URL(url);
      log(`[页面] ${u.pathname}${u.search}`);
    } catch {
      log(`[页面] ${url}`);
    }
  };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) emitIfChanged(); });
  const timer = setInterval(emitIfChanged, 500);
  if (timer.unref) timer.unref(); // 不因轮询定时器阻止进程退出
  page.on('close', () => clearInterval(timer));
  return () => clearInterval(timer);
}

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
  const result = await requestCode('register');
  const code = result?.code || result;
  log('dryRun：收到验证码');
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
  let recorder = null;
  let staticCache = null;
  let tracing = false;
  const recDir = recordDirFor(job); // DOM 记录 + Playwright Trace 同目录（存一次，避免 Date.now 漂移）
  onStop(() => { if (session) session.close().catch(() => {}); });

  const flow = (async () => {
    session = await launchSession(job.proxyUrl || '', {
      headless: Boolean(job.headless),
      fingerprintSeed: Number.isInteger(job.fingerprintSeed) ? job.fingerprintSeed : null,
      locale: job.locale || null,
      timezone: job.timezone || null,
      acceptLanguage: job.acceptLanguage || null,
      log: (m) => log(m),
    });
    const seed = session.seed;
    // Playwright Trace：整轮连续录制（每个动作前后 DOM 快照 + 截图 + 网络），零插桩、完整回放。
    // cloakbrowser 的 context 若不支持 tracing 则自动跳过，不影响主流程。仅在开了记录目录时录。
    if (recDir) {
      try {
        await session.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        tracing = true;
        log('已开启 Playwright Trace 完整录制（成功即删、失败留 trace.zip）');
      } catch (e) { log(`Trace 不可用（${e?.message || e}），仅用每步 DOM 记录`, 'warn'); }
    }
    const page = await session.context.newPage();
    page.setDefaultTimeout(45000);
    staticCache = await attachStaticCache(session.context, {
      log: (m, level) => log(m, level),
      config: job.staticCache,
    });
    attachUrlLogger(page, (m) => log(m)); // 地址一变就单独打一行 [URL]，覆盖 register/login/existing 全流程

    recorder = createRecorder({
      dir: recDir,
      page,
      log: (m, level) => log(m, level),
      keep: job.recordKeep || process.env.REG_RECORD_KEEP || 'fail',
    });
    if (recorder.enabled) log('已开启每步 DOM 记录（成功即删、失败留证）');

    const common = {
      page,
      email: job.email,
      chatgptUrl: job.chatgptUrl || 'https://chatgpt.com/',
      enable2fa: job.enable2fa !== false,
      autoSetPassword: job.autoSetPassword !== false,
      requestCode,
      log: (m, level) => log(m, level),
      recorder,
    };

    let data;
    if (job.mode === 'login') {
      // 老账号仅登录取 token（刷新/重登主流程用；用存的 password+totp 过 2FA，
      // 无密码/密码错时 loginChatGPT 内部走邮箱 OTP / 忘记密码兜底）。
      data = await loginChatGPT({
        ...common,
        password: job.loginPassword || '',
        totpSecret: job.existingTotpSecret || '',
      });
    } else if (job.mode === 'existing') {
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
        log('该邮箱已注册，改为登录并加固账号');
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

  // 停止 Trace：失败保留 trace.zip 到记录目录（下到本地用 npx playwright show-trace 回放）；成功丢弃。
  const stopTrace = async (keep) => {
    if (!tracing || !session) return;
    try {
      if (keep && recDir) {
        await session.context.tracing.stop({ path: `${recDir}/trace.zip` });
        log(`Trace 已保存：${recDir}/trace.zip`);
      } else {
        await session.context.tracing.stop();
      }
    } catch { /* ignore */ }
    tracing = false;
  };

  try {
    const data = await Promise.race([flow, timeout]);
    await stopTrace(false); // 成功：丢弃 trace
    if (recorder) await recorder.finalize({ success: true }).catch(() => {});
    emit({ type: 'result', data });
  } catch (err) {
    // 失败现场：不管在哪抛错，先补记一帧当前页面（DOM+截图+状态机），再收尾——
    // 保证「失败时刻」总有记录，不依赖各抛错点手动插桩。
    let recordingDir = '';
    if (recorder) {
      await recorder.record('final-error-scene', { note: String(err?.message || err) }).catch(() => {});
    }
    await stopTrace(true); // 失败：保留 trace.zip（须在 finalize 之前）
    if (recorder) {
      const fin = await recorder.finalize({ success: false }).catch(() => ({ kept: false, dir: '' }));
      recordingDir = fin?.kept && fin?.dir ? String(fin.dir) : (recDir || '');
    } else if (recDir) {
      recordingDir = recDir;
    }
    emit({
      type: 'error',
      message: String(err?.message || err),
      partial: err?._partial || {},
      recordingDir,
    });
  } finally {
    if (staticCache) await staticCache.logSummary().catch(() => {});
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
