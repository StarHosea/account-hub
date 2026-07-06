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

// CDP 联调端口：设 CLOAK_CDP_PORT 时浏览器暴露标准 CDP（供 cdp-drive.mjs connectOverCDP 逐步驱动）。
// 生产默认不设、零影响；仅注册机流程联调时开。见 skill: register-cdp-debug。
function cdpArgs() {
  const port = Number(process.env.CLOAK_CDP_PORT || 0);
  return port > 0 ? [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] : [];
}

let _launchContext = null;
let _loadError = null;

async function loadCloak() {
  if (_launchContext || _loadError) return _launchContext;
  try {
    const mod = await import('cloakbrowser');
    _launchContext = mod.launchContext || mod.default?.launchContext;
    if (!_launchContext) throw new Error('浏览器组件未就绪');
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

// 与 Python identity.region 对齐的 IANA 时区；显式 locale 时一并传入，避免 geoip 按代理出口（如本机 7890→CN）覆盖语言。
const LOCALE_IANA_TZ = {
  'en-US': 'America/New_York',
  'ja-JP': 'Asia/Tokyo',
  'en-IN': 'Asia/Kolkata',
};

function resolveLocale(locale, proxyUrl) {
  const v = String(locale || '').trim();
  if (v) return v;
  // 有代理且开 geoip 时不设 locale，让 CloakBrowser 按出口 IP 自动匹配；无代理则回退 en-US
  return proxyUrl ? null : 'en-US';
}

function resolveTimezone(timezone, locale) {
  const tz = String(timezone || '').trim();
  if (tz) return tz;
  const loc = String(locale || '').trim();
  return LOCALE_IANA_TZ[loc] || null;
}

/** 显式 locale 时同步 navigator.language，避免本机 zh-CN 泄漏到 auth 页。 */
async function applyNavigatorLocale(context, locale) {
  const loc = String(locale || '').trim();
  if (!loc) return;
  await context.addInitScript((l) => {
    try {
      Object.defineProperty(navigator, 'language', { get: () => l, configurable: true });
      Object.defineProperty(navigator, 'languages', {
        get: () => [l, l.split('-')[0], 'en-US', 'en'],
        configurable: true,
      });
    } catch { /* ignore */ }
  }, loc);
}

// 返回统一句柄 { mode, seed, browser, context, close() }。
// fingerprintSeed：固定指纹种子（10000-99999）。同一 seed = 同一指纹，跨会话可复现；
// 不传则生成一个，并在返回值里带出实际 seed 供存储与后续复用。
// locale：浏览器语言（如 en-US / ja-JP / en-IN），与 Python identity.region 对齐；显式传入时覆盖 geoip 自动检测。
export async function launchSession(proxyUrl, { headless = false, fingerprintSeed = null, locale = null, timezone = null, acceptLanguage = null, log = () => {} } = {}) {
  const launchContext = await loadCloak();
  const seed = Number.isInteger(fingerprintSeed) && fingerprintSeed > 0
    ? fingerprintSeed
    : Math.floor(Math.random() * 90000) + 10000;
  const resolvedLocale = resolveLocale(locale, proxyUrl);
  const resolvedTimezone = resolveTimezone(timezone, resolvedLocale);
  const resolvedAcceptLanguage = String(acceptLanguage || '').trim()
    || (resolvedLocale ? `${resolvedLocale},${resolvedLocale.split('-')[0]};q=0.9,en-US;q=0.8,en;q=0.7` : '');

  if (launchContext) {
    try {
      // 显式 locale 时关闭 geoip：本机 7890 出口常为 CN，geoip/WebRTC IP 会把 navigator.language 拉回 zh-CN。
      const useExplicitLocale = Boolean(resolvedLocale);
      const opts = {
        geoip: !useExplicitLocale,
        humanize: true,
        headless,
        viewport: { width: 1280, height: 800 },
        args: [`--fingerprint=${seed}`, ...HARDENING_ARGS, ...cdpArgs()],
      };
      if (resolvedLocale) opts.locale = resolvedLocale;
      if (resolvedTimezone) opts.timezone = resolvedTimezone;
      if (resolvedAcceptLanguage) {
        opts.contextOptions = {
          extraHTTPHeaders: { 'Accept-Language': resolvedAcceptLanguage },
        };
      }
      if (proxyUrl) opts.proxy = proxyUrl;
      const context = await launchContext(opts);
      if (resolvedLocale) await applyNavigatorLocale(context, resolvedLocale);
      if (resolvedAcceptLanguage) {
        await context.setExtraHTTPHeaders({ 'Accept-Language': resolvedAcceptLanguage });
      }
      const browser = context.browser();
      const localeNote = resolvedLocale || (proxyUrl ? 'geoip 自动' : 'en-US');
      const tzNote = resolvedTimezone ? `，tz=${resolvedTimezone}` : '';
      log(`浏览器已启动（seed=${seed}，locale=${localeNote}${tzNote}${proxyUrl ? '，出口走代理' : '，直连'}）`);
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
      log(`浏览器启动失败（${err?.message || err}），正在切换备用模式`);
    }
  } else if (!FALLBACK_ENABLED) {
    throw _loadError || new Error('浏览器不可用');
  } else {
    log(`浏览器加载失败（${_loadError?.message || _loadError}），正在切换备用模式`);
  }

  const fb = await launchFallbackChromium(proxyUrl, headless, resolvedLocale || 'en-US', resolvedTimezone, resolvedAcceptLanguage, log);
  fb.seed = seed; // 回退模式无真实指纹，仍记录 seed 保持数据结构一致
  return fb;
}

// 回退：playwright-core + 系统 Chrome / 自带 chromium（无 stealth 指纹，仅用于跑通链路）。
async function launchFallbackChromium(proxyUrl, headless, locale, timezone, acceptLanguage, log) {
  const { chromium } = await import('playwright-core');
  const pwProxy = toPlaywrightProxy(proxyUrl);
  const launchOpts = {
    headless,
    proxy: pwProxy,
    args: [
      ...HARDENING_ARGS,
      ...cdpArgs(),
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
      log(`浏览器启动失败（${e?.message || e}），尝试备用内核`);
      browser = await chromium.launch(launchOpts);
    }
  }
  const context = await browser.newContext({
    proxy: pwProxy,
    viewport: { width: 1280, height: 800 },
    locale: locale || 'en-US',
    ...(timezone ? { timezoneId: timezone } : {}),
    ...(acceptLanguage ? { extraHTTPHeaders: { 'Accept-Language': acceptLanguage } } : {}),
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  if (locale) await applyNavigatorLocale(context, locale);
  log('浏览器已启动（备用模式）');
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
