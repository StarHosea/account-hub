// ============================================================================
// CDP 联调 · 常驻浏览器（stealth，过风控）
// ----------------------------------------------------------------------------
// 用 cloakbrowser 启动过风控的 stealth 浏览器 + 暴露 CDP 端口 + 打开站点，然后「保持存活」，
// 供 cdp-drive.mjs 反复 connectOverCDP 连上逐步驱动。注册机流程联调时用它,
// 绝不用 chrome-devtools 的裸 Chrome（会被 OpenAI 风控）。见 skill: register-cdp-debug。
//
// 用法：
//   CLOAK_CDP_PORT=9222 node scripts/cdp-serve.mjs [--proxy <http://user:pass@host:port>] [--url <站点>] [--seed <指纹>] [--locale ja-JP] [--timezone Asia/Tokyo]
// 也可用环境变量 CLOAK_LOCALE / CLOAK_TIMEZONE（与生产 worker job.locale 对齐）。
// 保持前台运行；Ctrl-C 关闭浏览器退出。另开终端用 cdp-drive.mjs 驱动。
// ============================================================================
import { launchSession } from '../cloakbrowser.js';
import { parseArgs, logger } from './_harness.mjs';

const args = parseArgs();
const log = logger('cdp-serve');
const port = Number(process.env.CLOAK_CDP_PORT || 9222);
process.env.CLOAK_CDP_PORT = String(port); // 确保 cloakbrowser 读到，附加 --remote-debugging-port

const session = await launchSession(args.proxy || '', {
  headless: Boolean(args.headless),
  fingerprintSeed: args.seed ? Number(args.seed) : null,
  locale: args.locale || process.env.CLOAK_LOCALE || null,
  timezone: args.timezone || process.env.CLOAK_TIMEZONE || null,
  log,
});
const page = await session.context.newPage();
const url = args.url || 'https://chatgpt.com/';
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log(`打开 ${url} 异常：${e?.message || e}`, 'warn'));

log(`✅ 浏览器就绪（${session.mode}，seed=${session.seed}）`);
const resolvedLocale = args.locale || process.env.CLOAK_LOCALE || '';
if (resolvedLocale) log(`   locale=${resolvedLocale}（Accept-Language + navigator.language）`);
log(`   CDP endpoint: http://127.0.0.1:${port}`);
log(`   驱动示例：CLOAK_CDP_PORT=${port} node scripts/cdp-drive.mjs snapshot`);
log('   保持存活中，Ctrl-C 退出并关闭浏览器…');

let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  log('正在关闭浏览器…');
  await session.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await new Promise(() => {}); // 永久保持
