// ============================================================================
// 手动浏览器探查脚本共享脚手架（node_engine/scripts/*）
// ----------------------------------------------------------------------------
// 这些脚本用于「离线手动」驱动 CloakBrowser 探查 ChatGPT 站点规律 / 迭代选择器，
// 不经过 Python 编排、不依赖邮箱池。验证码由「操作员手动输入」或「取件地址自动轮询」提供。
//
// 与 node_engine/worker.js 的区别：worker 由 Python 通过 NDJSON 驱动、验证码走 requestCode；
// 这里把 requestCode 换成一个「终端交互 / HTTP 取件」的本地实现，其余复用同一套 flows。
//
// 通用参数（--key value 或布尔 --flag）：
//   --email <邮箱>            必填
//   --proxy <代理URL>         可选，http://user:pass@host:port（Chromium 不支持带认证 socks5）
//   --mail-url <取件地址>     可选，HTML 收件页 URL；给了就自动轮询取码，超时回退手动输入
//   --seed <指纹种子>         可选，10000-99999，同 seed=同指纹
//   --password <登录密码>     老账号登录用（可选）
//   --totp-secret <base32>    老账号已开 2FA 时登录用（可选）
//   --headless                无头运行（默认有头，探查建议有头）
//   --no-2fa                  只设密码、跳过 2FA
// ============================================================================

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { launchSession } from '../cloakbrowser.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function logger(tag) {
  return (m, level = 'info') => {
    const t = new Date().toISOString().slice(11, 19);
    const mark = level === 'error' ? '❌ ' : level === 'warn' ? '⚠️ ' : level === 'ok' ? '✅ ' : '';
    console.log(`[${tag}] ${t} ${mark}${m}`);
  };
}

export function diagDir() {
  const dir = process.env.REG_DIAG_DIR || path.resolve(process.cwd(), 'diag');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function snap(page, tag) {
  const file = path.join(diagDir(), `${tag}-${Date.now()}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

// 读取整页可见 UI（按钮/输入/含关键字提示）+ 截图，供探查 DOM 结构。只读。
export async function dumpUi(page, tag, log = console.log) {
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const txt = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return {
      url: location.href,
      title: document.title,
      buttons: [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab]')].filter(vis).map(txt).filter(Boolean).slice(0, 40),
      inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder, al: i.getAttribute('aria-label') })),
      dialogs: [...document.querySelectorAll('[role=dialog],dialog')].filter(vis).length,
      hints: [...new Set([...document.querySelectorAll('h1,h2,h3,label,span,p,div,button,a')].filter(vis).map(txt).filter((t) => /密码|password|多重|两步|验证器|authenticator|2fa|mfa|multi-factor|two-factor|安全|security|恢复码|recovery/i.test(t) && t.length < 60))].slice(0, 25),
    };
  }).catch((e) => ({ err: e.message }));
  const file = await snap(page, tag);
  console.log(`\n===== DUMP: ${tag} =====`);
  console.log(JSON.stringify(info, null, 1));
  log(`已截图 ${file}`);
  return info;
}

// 探查用 DOM 点击（快速可靠，仅用于本地勘察脚本；正式流程用 flows 里的 humanClickByText）。
export async function domClick(page, texts) {
  return page.evaluate((wanted) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const els = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab],[role=link]')].filter(vis);
    const t = els.find((e) => { const x = (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase(); return wanted.some((w) => x === w.toLowerCase() || x.includes(w.toLowerCase())); });
    if (t) { t.click(); return (t.innerText || t.getAttribute('aria-label') || '').trim(); }
    return null;
  }, texts);
}

// 本地验证码提供器：优先从取件地址自动轮询，超时/未配置则终端手动输入。
export function makeCodeProvider({ mailUrl = '', pollMs = 5000, timeoutMs = 180000, log = console.log } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q) => new Promise((res) => rl.question(q, (a) => res(String(a || '').trim())));
  const priorCodes = new Set();

  async function fetchCode() {
    try {
      const res = await fetch(mailUrl, { headers: { 'User-Agent': 'Mozilla/5.0 node_engine-recon' } });
      const html = await res.text();
      let text = html;
      for (let i = 0; i < 2; i += 1) {
        text = text
          .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/gi, '&');
      }
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const patterns = [
        /输入此临时验证码以继续[：:]\s*(\d{6})/,
        /(?:验证码|临时验证码|代码为|code is|verification code|enter this code|your chatgpt code is)[^0-9#]{0,24}(\d{6})/i,
      ];
      for (const re of patterns) {
        const m = text.match(re);
        if (m && m[1] && !priorCodes.has(m[1])) return m[1];
      }
      const fallback = text.match(/(?<![#\d])\b(\d{6})\b/);
      if (fallback && !priorCodes.has(fallback[1])) return fallback[1];
    } catch { /* ignore */ }
    return '';
  }

  async function requestCode(purpose = 'register') {
    if (mailUrl) {
      log(`需要验证码[${purpose}]，从取件地址轮询中…（超时后可手动输入）`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const code = await fetchCode();
        if (code) { priorCodes.add(code); log(`已自动取到验证码 ${code}`); return code; }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      log('自动取码超时，改为手动输入', 'warn');
    }
    const code = await prompt(`🔑 需要验证码[${purpose}]，请输入 6 位码后回车: `);
    if (code) priorCodes.add(code);
    return code;
  }

  return { requestCode, close: () => rl.close() };
}

// 启动 CloakBrowser 并开一个新页面。
export async function launch({ proxy = '', seed = null, headless = false, log = console.log } = {}) {
  const session = await launchSession(proxy, {
    headless,
    fingerprintSeed: seed != null && seed !== '' ? Number(seed) : null,
    log,
  });
  const page = await session.context.newPage();
  page.setDefaultTimeout(45000);
  return { session, page };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
