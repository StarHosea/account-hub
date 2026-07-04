// ============================================================================
// CloakBrowser 启动适配器（account-hub node_engine 版，无内部 config 依赖）
// ----------------------------------------------------------------------------
// CloakBrowser（cloakhq/CloakBrowser）是 "Playwright 直插替代"：
//   import { launchContext } from 'cloakbrowser'
//   const context = await launchContext({ proxy, geoip, humanize, headless, args })
// 它启动的是一个在 C++ 源码层改过指纹的真实 stealth Chromium，能过 Cloudflare
// Turnstile / FingerprintJS 等检测。每次 launch = 一个独立浏览器实例（独立指纹）。
//
// 与 browserregister 的差异：
//   - proxy 由 Python 侧解析好，作为完整 http(s):// URL 字符串传入（Chromium 无法做
//     带认证的 SOCKS5，故 Python 强制转 http）。
//   - Docker 内 Chromium 必须 --no-sandbox --disable-dev-shm-usage。
//   - 回退到 playwright-core 由环境变量 CLOAK_FALLBACK_CHROMIUM 控制（默认 true）。
// ============================================================================

const FALLBACK_ENABLED = String(process.env.CLOAK_FALLBACK_CHROMIUM || 'true').toLowerCase() !== 'false';
const HARDENING_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

let _launchContext = null;
let _loadError = null;

async function loadCloak() {
  if (_launchContext || _loadError) return _launchContext;
  try {
    const mod = await import('cloakbrowser');
    _launchContext = mod.launchContext || mod.default?.launchContext;
    if (!_launchContext) throw new Error('cloakbrowser 未导出 launchContext');
  } catch (err) {
    _loadError = err;
  }
  return _launchContext;
}

// 把 http(s)://user:pass@host:port 解析成 playwright 的 proxy 对象（回退路径用）。
function toPlaywrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const server = `${u.protocol}//${u.host}`;
    const proxy = { server };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return { server: proxyUrl };
  }
}

// 返回统一句柄 { mode, seed, browser, context, close() }。
// fingerprintSeed：固定指纹种子（10000-99999）。同一 seed = 同一指纹，跨会话可复现；
// 不传则生成一个，并在返回值里带出实际 seed 供存储与后续复用。
export async function launchSession(proxyUrl, { headless = false, fingerprintSeed = null, log = () => {} } = {}) {
  const launchContext = await loadCloak();
  const seed = Number.isInteger(fingerprintSeed) && fingerprintSeed > 0
    ? fingerprintSeed
    : Math.floor(Math.random() * 90000) + 10000;

  if (launchContext) {
    try {
      const opts = {
        geoip: true,             // 按出口 IP 匹配时区/语言（需 mmdb-lib）
        humanize: true,          // 拟人化鼠标/键盘/滚动
        headless,                // 反爬场景建议 false（服务器上用 Xvfb 有头）
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        // 固定指纹种子 + Docker 加固参数（buildArgs 按键去重，用户 args 覆盖默认）
        args: [`--fingerprint=${seed}`, ...HARDENING_ARGS],
      };
      if (proxyUrl) opts.proxy = proxyUrl; // 带账号密码的完整代理地址
      const context = await launchContext(opts);
      const browser = context.browser();
      log(`CloakBrowser 已启动（stealth 指纹 seed=${seed}${proxyUrl ? '，出口走代理' : '，直连'}）`);
      return {
        mode: 'cloakbrowser',
        seed,
        browser,
        context,
        async close() {
          try { await context.close(); } catch { /* ignore */ }
          try { await browser?.close(); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      if (!FALLBACK_ENABLED) throw err;
      log(`CloakBrowser 启动失败（${err?.message || err}），回退到本地 chromium`);
    }
  } else if (!FALLBACK_ENABLED) {
    throw _loadError || new Error('cloakbrowser 不可用且未开启回退');
  } else {
    log(`cloakbrowser 加载失败（${_loadError?.message || _loadError}），回退到本地 chromium`);
  }

  const fb = await launchFallbackChromium(proxyUrl, headless, log);
  fb.seed = seed; // 回退模式无真实指纹，仍记录 seed 保持数据结构一致
  return fb;
}

// 回退：playwright-core + 系统 Chrome / 自带 chromium（无 stealth 指纹，仅用于跑通链路）。
async function launchFallbackChromium(proxyUrl, headless, log) {
  const { chromium } = await import('playwright-core');
  const pwProxy = toPlaywrightProxy(proxyUrl);
  const launchOpts = {
    headless,
    proxy: pwProxy,
    args: [
      ...HARDENING_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
  const chromePath = process.env.CLOAK_CHROME_PATH || '';
  let browser;
  if (chromePath) {
    browser = await chromium.launch({ ...launchOpts, executablePath: chromePath });
  } else {
    try {
      browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch (e) {
      log(`系统 Chrome 启动失败（${e?.message || e}），尝试 playwright 自带 chromium`);
      browser = await chromium.launch(launchOpts);
    }
  }
  const context = await browser.newContext({
    proxy: pwProxy,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  log('已启动 playwright-core chromium（回退模式，无 stealth 指纹）');
  return {
    mode: 'chromium-fallback',
    browser,
    context,
    async close() {
      try { await context.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    },
  };
}

export default { launchSession };
