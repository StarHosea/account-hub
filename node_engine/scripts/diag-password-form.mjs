// 只读诊断：走到登录密码页，填真实密码并提交，dump 提交后页面（判断 密码错 vs 提交没触发 vs 进 2FA/邮箱验证）。
// 用法：
//   node scripts/diag-password-form.mjs --email a@b.com --password <登录密码> [--proxy <代理URL>] [--seed 12345] [--headless]
import { parseArgs, logger, launch, snap, sleep } from './_harness.mjs';

const args = parseArgs();
const email = args.email || args._[0];
const pwd = args.password || args._[1];
if (!email || !pwd) {
  console.error('用法: node scripts/diag-password-form.mjs --email <email> --password <登录密码> [--proxy <代理URL>] [--seed <种子>] [--headless]');
  process.exit(1);
}
const log = logger('diag-pw');
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });

try {
  await page.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 90000 });
  await page.waitForFunction(() => /登录|log ?in/i.test(document.body?.innerText || ''), { timeout: 40000 }).catch(() => {});
  await sleep(2500);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button,a,[role=button]')].find((e) => /^登录$|log in|login/i.test((e.innerText || '').trim())); if (b) b.click(); });
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id*="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 50 });
  await sleep(500);
  await page.evaluate(() => {
    const oauth = ['google', 'apple', 'microsoft', 'phone', '电话', '手机', 'passkey', '通行密钥'];
    const c = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const t = (e) => (e.innerText || e.value || '').trim().toLowerCase();
    const h = c.find((e) => ['继续', 'continue'].includes(t(e)) && !oauth.some((w) => t(e).includes(w)));
    if (h) h.click();
  });
  await sleep(6000);
  log('到达密码页 URL=' + page.url());

  const pw = page.locator('input[type="password"]').first();
  await pw.waitFor({ state: 'visible', timeout: 10000 });
  await pw.click();
  await pw.pressSequentially(pwd, { delay: 60 });
  await sleep(500);
  const before = page.url();
  log(`已填密码(${pwd.length}位)，点"继续"提交…`);
  await page.locator('button[type="submit"]:has-text("继续"), button:has-text("继续"), button:has-text("Continue")').first().click({ timeout: 6000 }).catch((e) => log('点击异常:' + e.message, 'warn'));
  await page.waitForFunction((u) => location.href !== u, before, { timeout: 12000 }).catch(() => {});
  await sleep(4000);

  const after = await page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      url: location.href,
      heading: (document.querySelector('h1,h2')?.innerText || '').trim(),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder, inputmode: i.getAttribute('inputmode') })),
      buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis).map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 10),
    };
  });
  console.log('===== 密码提交后的页面 =====');
  console.log(JSON.stringify(after, null, 1));
  await snap(page, 'diag-after-password');
} catch (e) {
  log('ERROR ' + e.message, 'error');
  await snap(page, 'diag-pw-error');
} finally {
  await sleep(1500);
  await session.close();
  process.exit(0);
}
