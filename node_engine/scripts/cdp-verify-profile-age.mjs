// CDP 实机验证：日文资料页 age 填写 + isOnCodePage 不误判
// 用法：CLOAK_CDP_PORT=9222 node scripts/cdp-verify-profile-age.mjs
import { chromium } from 'playwright-core';
import { __test } from '../flows/openai/register.js';

const { isOnCodePage, fillBirthday, readProfileFields, assertProfileReady } = __test;
const port = Number(process.env.CLOAK_CDP_PORT || 9222);
const log = (msg) => console.log(`[verify] ${msg}`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0]?.pages()?.slice(-1)[0];
if (!page) {
  console.error('无可用页面，先启动 cdp-serve.mjs');
  process.exit(1);
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const url = page.url();
const title = await page.title().catch(() => '');
log(`当前页：${url} | ${title}`);

const snap = await page.evaluate(() => {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  return {
    hasAge: Boolean(document.querySelector('input[name="age"]') && vis(document.querySelector('input[name="age"]'))),
    hasName: Boolean(document.querySelector('input[name="name"]') && vis(document.querySelector('input[name="name"]'))),
    hasCode: Boolean(document.querySelector('input[name="code"]') && vis(document.querySelector('input[name="code"]'))),
    buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 8),
  };
});
log(`DOM：age=${snap.hasAge} name=${snap.hasName} code=${snap.hasCode} buttons=${snap.buttons.join(' | ')}`);

if (!snap.hasAge) {
  record('资料页 age 控件存在', false, '当前页无可见 input[name=age]，可能未进入 about-you 或会话已过期');
  console.log('\n=== 摘要 ===');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(2);
}

record('资料页 age 控件存在', true, 'input[name=age] 可见');

const onCodeBefore = await isOnCodePage(page);
record('isOnCodePage 在资料页为 false', !onCodeBefore, onCodeBefore ? '误判为验证码页' : 'ok');

const filled = await fillBirthday(page, { year: 1996, month: 7, day: 6 }, log);
const fieldsAfterFill = await readProfileFields(page);
record('fillBirthday 写入 age', filled && Boolean(fieldsAfterFill.age), `age=${fieldsAfterFill.age || '(空)'} birthday=${fieldsAfterFill.birthday || '(空)'}`);

try {
  await assertProfileReady(page, log);
  record('assertProfileReady 通过', true, `name=${fieldsAfterFill.name || 'William Test'}`);
} catch (e) {
  // name 可能空，补填后再测
  if (!fieldsAfterFill.name) {
    await page.locator('input[name="name"]').first().fill('CDP Verify').catch(() => {});
  }
  try {
    await assertProfileReady(page, log);
    record('assertProfileReady 通过（补填姓名后）', true, '');
  } catch (e2) {
    record('assertProfileReady 通过', false, e2.message);
  }
}

// 模拟 OTP 填进 age 后 detectInvalidCode 不应误报（旧 bug）
await page.locator('input[name="age"]').first().fill('123456').catch(() => {});
const { detectInvalidCode } = await import('../flows/openai/code-errors.js');
const invalidAfterFakeOtp = await detectInvalidCode(page);
record('detectInvalidCode 不把 age 当验证码错误', !invalidAfterFakeOtp, invalidAfterFakeOtp ? '仍误判' : 'ok');

// 恢复合法 age
await fillBirthday(page, { year: 1996, month: 7, day: 6 }, log);

await page.screenshot({ path: '/tmp/cdp-verify-profile-age.png' }).catch(() => {});
log('截图：/tmp/cdp-verify-profile-age.png');

console.log('\n=== CDP 验证摘要 ===');
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
await browser.close();
process.exit(failed.length ? 1 : 0);
