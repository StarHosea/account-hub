// 拉取 auth.openai.com 各语言 locale 包，打印验证码错误相关 i18n 文案（供 code-errors.js 校对）。
import { launchSession } from '../cloakbrowser.js';
import { logger } from './_harness.mjs';

const log = logger('probe-i18n');
const LOCALES = ['en-US', 'zh-CN', 'ja-JP'];

const session = await launchSession('', { headless: true, log });
const page = await session.context.newPage();

for (const locale of LOCALES) {
  const captured = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/\/assets\/[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+\.js/.test(url)) return;
    if (!url.includes(locale.split('-')[0])) return;
    try {
      const text = await resp.text();
      if (text.startsWith('<!')) return;
      captured.push({ url, text });
    } catch { /* ignore */ }
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9,en;q=0.8` });
  await page.goto('https://auth.openai.com/log-in', { waitUntil: 'networkidle', timeout: 120000 }).catch((e) => {
    log(`${locale} 打开失败：${e?.message || e}`, 'warn');
  });
  await page.waitForTimeout(3000);
  const keys = [
    'emailVerification.incorrectCode',
    'authErrors.wrongEmailOtpCode.subtitle',
    'authErrors.incorrectCode.subtitle',
    'mfaChallenge.incorrectCode',
    'authErrors.invalidInput.subtitle',
  ];
  console.log(`\n=== ${locale} (captured ${captured.length} locale chunks) ===`);
  for (const { url, text } of captured) {
    let hit = false;
    for (const key of keys) {
      const re = new RegExp(`"${key.replace(/\./g, '\\.')}":"([^"]+)"`);
      const m = text.match(re);
      if (m) {
        console.log(`  ${key}: ${m[1]}`);
        hit = true;
      }
    }
    if (hit) console.log(`  source: ${url}`);
  }
}

await session.close();
