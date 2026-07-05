import { sleep, generateRandomName, generateRandomBirthday, generatePassword, generateTotpNow } from '../../utils.js';
import * as S from './selectors.js';

// ============================================================================
// ChatGPT 注册/登录/账号加固流程（Playwright/CloakBrowser 版）
// 移植自 browserregister src/flows/openai/register.js，主要改动：
//   1) 验证码不再由本进程轮询邮箱，而是通过注入的 requestCode(purpose) 向 Python 请求；
//      Python（mail_provider）持有邮箱池并负责新鲜度（baseline）判定。
//   2) 「邮箱已注册」不再 throw，而是 registerChatGPT 返回 { emailExists:true }，
//      由 worker 分流到 secureExistingChatGPT（OTP 登录 → 设新密码 → 开 2FA → 取 token）。
//   3) enable2fa=false 时 step8 只设密码、跳过 2FA。
//   4) 诊断截图默认关闭，仅当设置环境变量 REG_DIAG_DIR 时落盘。
// ============================================================================

// 提交类按钮要排除的第三方登录/其它入口，避免把"使用 Google 账户继续"当成邮箱"继续"
const OAUTH_EXCLUDE = [
  'google', 'apple', 'microsoft', 'okta', 'sso', 'saml', 'passkey', '通行密钥',
  'phone', '电话', '手机', '号码', 'facebook', 'github', 'linkedin',
];

const DIAG_DIR = process.env.REG_DIAG_DIR || '';

// 在按钮/链接里按文案找可点击元素，然后用 Playwright 真实（humanize）点击。
async function humanClickByText(page, texts, { timeout = 15000, poll = 400, exclude = [] } = {}) {
  const lower = texts.map((t) => t.toLowerCase());
  const ex = exclude.map((t) => t.toLowerCase());
  const deadline = Date.now() + timeout;
  const MARK = 'data-reg-click';
  while (Date.now() < deadline) {
    const found = await page.evaluate(({ wanted, mark, exWords }) => {
      const cands = Array.from(
        document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"], input[type="submit"], input[type="button"]')
      );
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
          && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
      };
      const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
      const vis = cands.filter(visible).map((el) => ({ el, txt: textOf(el) })).filter((x) => x.txt);
      const notExcluded = (txt) => !exWords.some((w) => txt.includes(w));
      let hit = vis.find((x) => notExcluded(x.txt) && wanted.some((w) => x.txt === w));
      if (!hit) hit = vis.find((x) => notExcluded(x.txt) && wanted.some((w) => x.txt.includes(w)));
      if (hit) { hit.el.setAttribute(mark, '1'); return hit.txt; }
      return null;
    }, { wanted: lower, mark: MARK, exWords: ex });

    if (found) {
      try {
        await page.click(`[${MARK}="1"]`, { timeout: 5000 });
        await page.evaluate((mark) => document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark)), MARK);
        return found;
      } catch {
        // 目标可能刚被遮挡/重绘，继续轮询重试
      }
    }
    await sleep(poll);
  }
  return null;
}

// 轮询等待某选择器可见后返回其 locator（等待窗口弹出，不是绕过）。
async function firstVisible(page, selector, { timeout = 15000 } = {}) {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout });
    return loc;
  } catch {
    return null;
  }
}

// 按 data-testid 真实点击。OpenAI 设置面板每个 tab 都带稳定 testid（如 security-tab），
// 远比中文文案可靠：不受本地化/文案改动影响，也不会被新增的“内容安全”(safety-setting-tab) 抢词。
async function clickByTestId(page, testid, { timeout = 6000 } = {}) {
  try {
    const loc = page.locator(`[data-testid="${testid}"]`).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click({ timeout: 5000 });
    return testid;
  } catch {
    return null;
  }
}

// 设置弹窗是否已打开（存在 dialog 且能看到设置 tab）。
async function settingsDialogOpen(page) {
  return page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const hasDialog = [...document.querySelectorAll('[role=dialog]')].some(vis);
    const hasTab = !!document.querySelector('[data-testid="security-tab"],[data-testid="account-tab"],[data-testid="data-controls-tab"]');
    return hasDialog && hasTab;
  }).catch(() => false);
}


// 模拟人输入：点击聚焦 -> 全选清空 -> 逐字符带延迟输入（humanize 接管键盘节奏）。
async function humanType(locator, value) {
  await locator.click({ delay: 40 });
  await sleep(120 + Math.floor(Math.random() * 180));
  try {
    await locator.press('ControlOrMeta+A');
    await locator.press('Backspace');
  } catch { /* ignore */ }
  await locator.pressSequentially(String(value), { delay: 60 + Math.floor(Math.random() * 60) });
  await sleep(150 + Math.floor(Math.random() * 200));
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

// 提交邮箱后，轮询等待页面真正跳转（"继续"按钮会先 loading）。返回 'password' | 'code' | 'unknown'。
async function waitForPostEmailLanding(page, log, { timeoutMs = 120000, poll = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  while (Date.now() < deadline) {
    let state = 'pending';
    try {
      state = await page.evaluate((sel) => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const code = document.querySelector(sel.code);
        if (visible(code)) return 'code';
        const seg = document.querySelectorAll(sel.seg);
        if (seg.length >= 4 && visible(seg[0])) return 'code';
        const pwd = document.querySelector(sel.pwd);
        if (visible(pwd)) return 'password';
        return 'pending';
      }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED, pwd: S.PASSWORD_INPUT });
    } catch {
      state = 'navigating';
    }

    if (state === 'code') { log('已跳转到验证码页'); return 'code'; }
    if (state === 'password') { log('已跳转到密码页'); return 'password'; }
    if (!logged) { log('「继续」处理中（loading/跳转中），等待验证码页…'); logged = true; }
    await sleep(poll);
  }
  log('等待跳转超时，按未知状态继续尝试');
  return 'unknown';
}

// 等待跳转到验证码页（密码提交后同样会 loading）。
async function waitForCodePage(page, log, { timeoutMs = 120000 } = {}) {
  const loc = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: timeoutMs });
  if (loc) log('已跳转到验证码页');
  return Boolean(loc);
}

// 判断当前是否停在"验证码输入页"（含 auth.openai.com 裸 CSS 的 email-verification）。
async function isOnCodePage(page) {
  try {
    const url = page.url();
    const urlHit = /\/email-verification(?:[/?#]|$)|auth\.openai\.com/i.test(url);
    if (!urlHit) return false;
    const dom = await page.evaluate((sel) => {
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const one = document.querySelector(sel.code);
      const seg = document.querySelectorAll(sel.seg);
      const hasInput = visible(one) || (seg.length >= 4 && visible(seg[0]));
      const txt = document.body?.innerText || '';
      const hasHint = /检查你的收件箱|输入.*验证码|check your inbox|enter the code|verification code/i.test(txt);
      return hasInput || hasHint;
    }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED });
    return dom;
  } catch {
    return false;
  }
}

// 注册成功的 URL 判定：https + host∈chatgpt.com 且 path 不在 auth/create-account/email-verification/log-in/add-phone。
function isLoggedInUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (!/(^|\.)chatgpt\.com$/i.test(u.hostname)) return false;
    if (/\/auth\/|\/create-account\/|\/email-verification|\/log-in|\/add-phone/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// 失败现场快照：默认关闭；仅当设置 REG_DIAG_DIR 时截图落盘 + 记录 URL/输入框/按钮。
async function snapshot(page, tag, log) {
  if (!DIAG_DIR) return;
  try {
    const file = `${DIAG_DIR}/diag-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file }).catch(() => {});
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      inputs: [...document.querySelectorAll('input')].map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder })),
      buttons: [...document.querySelectorAll('button,a,[role="button"]')].map((b) => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 20),
    })).catch(() => ({}));
    log(`现场快照[${tag}]：${file} | URL=${info.url} | inputs=${JSON.stringify(info.inputs)} | buttons=${JSON.stringify(info.buttons)}`);
  } catch { /* ignore */ }
}

// 打开页面（住宅代理慢/抖动时重试）。先等 commit（首字节），再等 body 出现。
async function openWithRetry(page, url, log, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 90000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
      await page.waitForFunction(
        () => /免费注册|sign up|登录|log ?in/i.test(document.body?.innerText || ''),
        { timeout: 30000 }
      ).catch(() => {});
      const txt = await pageText(page);
      if (txt && txt.length > 20) {
        log(`已打开页面（第 ${i} 次），标题：${await page.title().catch(() => '')}`);
        return true;
      }
      log(`页面内容过少，重试打开…（第 ${i} 次）`);
    } catch (err) {
      lastErr = err;
      log(`打开页面失败（第 ${i}/${attempts} 次）：${err?.message || err}`);
      await sleep(2500);
    }
  }
  throw new Error(`多次打开 ChatGPT 失败：${lastErr?.message || lastErr}`);
}

// 读取当前会话的 accessToken（fetch('/api/auth/session')）。
async function readAccessToken(page) {
  return page.evaluate(async () => {
    try {
      const res = await fetch('/api/auth/session', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return { error: `session ${res.status}` };
      const txt = await res.text();
      if (/^\s*</.test(txt)) return { error: '会话端点返回HTML（可能未登录）' };
      let data;
      try { data = JSON.parse(txt); } catch { return { error: '会话响应非JSON' }; }
      return {
        accessToken: String(data?.accessToken || '').trim(),
        user: data?.user || null,
        expires: data?.expires || null,
      };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  });
}

// 填生日：优先 date/age，其次 react-aria 下拉/spinbutton（三种 UI 形态）。
async function fillBirthday(page, { year, month, day }, log) {
  const kind = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    for (let i = 0; i < 100; i += 1) {
      const age = document.querySelector('input[name="age"]');
      if (age && visible(age)) return 'age';
      const yr = document.querySelector('[role="spinbutton"][data-type="year"]');
      const mo = document.querySelector('[role="spinbutton"][data-type="month"]');
      const dy = document.querySelector('[role="spinbutton"][data-type="day"]');
      if (yr && mo && dy && visible(yr)) return 'spinbutton';
      const selects = document.querySelectorAll('.react-aria-Select');
      if (selects.length >= 3 && visible(selects[0])) return 'react-aria';
      await sleep(100);
    }
    return 'none';
  });

  if (kind === 'none') {
    log('未发现生日输入控件，跳过');
    return false;
  }

  if (kind === 'react-aria') {
    const ok = await page.evaluate(async ({ y, m, d }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const findSelect = (labels) => {
        const roots = document.querySelectorAll('.react-aria-Select');
        for (const root of roots) {
          const labelEl = Array.from(root.querySelectorAll('span')).find((el) => labels.includes(norm(el.textContent)));
          if (!labelEl) continue;
          const item = root.closest('[class*="selectItem"]') || root.parentElement;
          const nativeSelect = item?.querySelector('[data-testid="hidden-select-container"] select') || null;
          return { root, nativeSelect };
        }
        return null;
      };
      const setSel = (ctrl, value) => {
        if (!ctrl?.nativeSelect) return false;
        const desired = String(value);
        const opt = Array.from(ctrl.nativeSelect.options).find((o) => o.value === desired);
        if (!opt) return false;
        ctrl.nativeSelect.value = desired;
        opt.selected = true;
        ctrl.nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
        ctrl.nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const yearSel = findSelect(['年', 'Year']);
      const monthSel = findSelect(['月', 'Month']);
      const daySel = findSelect(['天', '日', 'Day']);
      if (!yearSel || !monthSel || !daySel) return { ok: false, reason: '未找到年/月/日下拉' };
      const r1 = setSel(yearSel, y); await sleep(200);
      const r2 = setSel(monthSel, m); await sleep(200);
      const r3 = setSel(daySel, d); await sleep(200);
      if (!r1 || !r2 || !r3) return { ok: false, reason: '下拉无对应选项' };
      const hidden = document.querySelector('input[name="birthday"]');
      const desired = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (hidden) {
        const start = Date.now();
        while (Date.now() - start < 2000) {
          if ((hidden.value || '') === desired) break;
          await sleep(100);
        }
      }
      return { ok: true };
    }, { y: year, m: month, d: day });
    if (ok?.ok) { log(`已选择生日 ${year}-${month}-${day}（react-aria 下拉）`); return true; }
    log(`生日下拉填写失败：${ok?.reason || '未知'}`);
    return false;
  }

  if (kind === 'spinbutton') {
    const seq = [
      ['[role="spinbutton"][data-type="month"]', month],
      ['[role="spinbutton"][data-type="day"]', day],
      ['[role="spinbutton"][data-type="year"]', year],
    ];
    for (const [sel, val] of seq) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ delay: 40 }).catch(() => {});
        await loc.pressSequentially(String(val), { delay: 90 }).catch(() => {});
        await sleep(200);
      }
    }
    log(`已键入生日 ${year}-${month}-${day}（spinbutton）`);
    return true;
  }

  if (kind === 'age') {
    const nowYear = new Date().getFullYear();
    const age = Math.max(18, nowYear - Number(year));
    const loc = page.locator('input[name="age"]').first();
    await loc.click({ delay: 40 }).catch(() => {});
    await loc.pressSequentially(String(age), { delay: 80 }).catch(() => {});
    log(`已填写年龄 ${age}`);
    return true;
  }
  return false;
}

// ---------------- 主流程 ----------------

// 等 auth.openai.com 页面 hydrate 完成再交互（否则按钮 onClick 未绑定，点击无效）。
// 信号：样式表已加载（styleSheets>0）+ readyState 非 loading。
async function waitForAuthReady(page, { timeout = 12000 } = {}) {
  await page.waitForFunction(() => {
    try { return document.styleSheets.length > 0 && document.readyState !== 'loading'; }
    catch { return false; }
  }, { timeout }).catch(() => {});
  await sleep(600);
}

// 可靠点击 auth.openai.com 的按钮/链接（Remix 页面对标记点击不稳）：
// 原生 locator 派发真实指针事件 + 滚动入视图 + 多次重试 + 等待导航；
// 兜底 form.requestSubmit；仍不动可 reload 重新 hydrate。同时匹配 button/a/[role=button]
// （"忘记了密码？"是 <a> 链接）。移植自 browserregister clickButtonRobust。
async function clickButtonRobust(page, textRe, { timeout = 10000, tries = 3, reloadOnFail = false } = {}) {
  await waitForAuthReady(page);
  const before = page.url();
  for (let i = 0; i < tries; i += 1) {
    const btn = page.locator('button, a, [role="button"]').filter({ hasText: textRe }).first();
    try {
      await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await btn.click({ timeout: 4000 });
    } catch {
      try { await btn.focus({ timeout: 1500 }); await page.keyboard.press('Enter'); } catch { /* ignore */ }
    }
    let moved = await page.waitForFunction((u) => location.href !== u, before, { timeout: Math.round(timeout / tries) }).then(() => true).catch(() => false);
    if (moved) return true;
    const src = textRe.source;
    await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const btns = [...document.querySelectorAll('button,[type="submit"]')].filter(vis);
      const b = btns.find((x) => re.test((x.innerText || x.value || '').trim()));
      const form = b?.closest('form') || document.querySelector('form');
      if (form) (form.requestSubmit ? form.requestSubmit(b && b.type === 'submit' ? b : undefined) : form.submit());
    }, src).catch(() => {});
    moved = await page.waitForFunction((u) => location.href !== u, before, { timeout: 3000 }).then(() => true).catch(() => false);
    if (moved) return true;
    if (reloadOnFail && i < tries - 1) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForAuthReady(page);
    }
  }
  return page.url() !== before;
}

// 忘记密码重设兜底：点"忘记了密码？"→"重置密码"确认 → 邮箱收码（requestCode）→ 设新密码 → 登录。
// 绕开不响应自动化的 Remix 密码登录表单。返回新设的密码（存储用）。
// 移植自 browserregister forgotPasswordFlow，改动：取码走注入的 requestCode('login')（Python 持邮箱池）。
async function forgotPasswordFlow({ page, email, requestCode, log }) {
  const newPassword = generatePassword();
  // 1) 点"忘记了密码？"
  const moved1 = await clickButtonRobust(page, /忘记了密码|忘记密码|forgot/i, { timeout: 8000 });
  log(`忘记密码1：点击"忘记密码"→${moved1 ? '已跳转' : '未跳转'}，URL=${page.url()}`);
  await sleep(2000);
  await snapshot(page, 'forgot-01-after-click', log);

  // 2) 重置密码确认页："点击继续以重置 X 的密码" → 点"继续"发送重置码
  if (/reset-password/i.test(page.url())) {
    const moved2 = await clickButtonRobust(page, /继续|continue|发送|send/i, { timeout: 12000, tries: 4, reloadOnFail: true });
    log(`忘记密码1b：点重置确认"继续"→${moved2 ? '已跳转' : '未跳转'}，URL=${page.url()}`);
    await sleep(2500);
    await snapshot(page, 'forgot-02-after-continue', log);
  }

  // 3) 收码页 → 向 Python 请求重置码填码
  const codeReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 40000 });
  if (codeReady) {
    log('忘记密码2：收码页就绪，取重置码');
    const code = await requestCode('login');
    await fillCode(page, code, log);
    await submitCodeForm(page, log);
    await sleep(3500);
    await snapshot(page, 'forgot-03-after-code', log);
  } else {
    log(`忘记密码2：未见收码页，URL=${page.url()}`);
    await snapshot(page, 'forgot-02b-no-code', log);
  }

  // 4) 新密码页：必须确认在"新密码/重置"页（避免把登录密码框误当新密码框）
  await firstVisible(page, 'input[type="password"], input[autocomplete="new-password"]', { timeout: 20000 }).catch(() => null);
  const onNewPwdPage = await page.evaluate(() => {
    const url = location.href;
    if (/new-password|reset-password\/|create-password/i.test(url)) return true;
    const pw = document.querySelectorAll('input[type="password"]');
    const t = document.body.innerText || '';
    return pw.length >= 2 || /新密码|设置密码|重新输入.*密码|create.*password|new password/i.test(t);
  }).catch(() => false);
  if (!onNewPwdPage) {
    await snapshot(page, 'forgot-no-pwd-form', log);
    throw new Error(`忘记密码流程：未到新密码页（当前 ${page.url()}），重置码/确认步骤可能失败`);
  }
  const all = page.locator('input[type="password"]');
  const n = await all.count();
  await humanType(all.nth(0), newPassword);
  if (n > 1) await humanType(all.nth(1), newPassword);
  log(`忘记密码3：已填新密码（${n} 个密码框），提交`);
  const beforeSet = page.url();
  await all.nth(Math.max(0, n - 1)).press('Enter').catch(() => {});
  await page.waitForFunction((u) => location.href !== u, beforeSet, { timeout: 5000 }).catch(() => {});
  if (page.url() === beforeSet) await clickButtonRobust(page, /继续|保存|重置|确认|continue|save|reset|confirm/i, { timeout: 8000 });
  await sleep(3500);
  await snapshot(page, 'forgot-04-after-set', log);

  // 5) 重设成功页（/reset-password/success）不会自动登录：需点"登录"回登录页，再用新密码登录。
  //    每次跳转后先 waitForAuthReady 等页面 hydrate 完成再操作（避免点击/输入落空）。
  await waitForAuthReady(page);
  const onResetDone = /reset-password\/success/i.test(page.url())
    || await page.evaluate(() => /重置.*成功|密码.*(已|修改|重置).*成功|password.*(reset|changed|updated)/i.test(document.body?.innerText || '')).catch(() => false);
  if (onResetDone || /reset-password/i.test(page.url())) {
    log(`忘记密码4：密码已重设（${page.url()}），点"登录"回到登录页`);
    const movedLogin = await clickButtonRobust(page, /^登录$|登 ?录|log ?in|sign ?in/i, { timeout: 8000, tries: 3 });
    if (!movedLogin || !/\/log-in/i.test(page.url())) {
      // 兜底：直接点 href 指向 /log-in 的链接
      await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find((x) => /\/log-in/i.test(x.getAttribute('href') || ''));
        if (a) a.click();
      }).catch(() => {});
      await page.waitForFunction(() => /\/log-in/i.test(location.href), { timeout: 8000 }).catch(() => {});
    }
    await waitForAuthReady(page);
  }

  // 6) 登录页用刚设的新密码登录（session 记得邮箱，通常直达 /log-in/password）。
  //    2FA / 最终成功由 loginChatGPT 后续 handleLoginTotpPrompt + waitForSuccess 接管。
  if (/\/log-in\/password/i.test(page.url())) {
    const pwd = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 12000 });
    if (pwd) {
      log('忘记密码5：登录页用新密码登录');
      await humanType(pwd, newPassword);
      const beforeLogin = page.url();
      await pwd.press('Enter').catch(() => {});
      await page.waitForFunction((u) => location.href !== u, beforeLogin, { timeout: 8000 }).catch(() => {});
      if (page.url() === beforeLogin) {
        await humanClickByText(page, ['继续', 'continue', '登录', 'log in', 'sign in'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
        await page.waitForFunction((u) => location.href !== u, beforeLogin, { timeout: 8000 }).catch(() => {});
      }
      await sleep(2500);
    }
  } else if (/\/log-in(\/|$|\?)/i.test(page.url())) {
    // 兜底：落到邮箱输入页 → 重填邮箱再进密码页登录
    const emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 8000 });
    if (emailInput) {
      await humanType(emailInput, email);
      await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      await waitForAuthReady(page);
      const pwd2 = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 12000 });
      if (pwd2) {
        log('忘记密码5b：重填邮箱后用新密码登录');
        await humanType(pwd2, newPassword);
        const b2 = page.url();
        await pwd2.press('Enter').catch(() => {});
        await page.waitForFunction((u) => location.href !== u, b2, { timeout: 8000 }).catch(() => {});
        await sleep(2500);
      }
    }
  }
  await snapshot(page, 'forgot-06-after-relogin', log);
  return newPassword;
}

// 老账号登录（OTP 收码登录）。验证码通过 requestCode('login') 向 Python 请求。
// totpSecret：若账号已开 2FA，登录后会要求验证器码，传入 secret 则自动生成 TOTP 填入。
export async function loginChatGPT({ page, email, chatgptUrl = 'https://chatgpt.com/', password = '', totpSecret = '', requestCode, log }) {
  let landing = null;

  // 快路径：若调用前页面已停在 auth 登录密码页（注册流程检测到"邮箱已注册"后直接转来），
  // 跳过重开官网 / 重点登录 / 重填邮箱，直接在当前密码页登录，节省一整轮邮箱输入。
  if (/auth\.openai\.com\/log-in\/password/i.test(page.url())) {
    await waitForAuthReady(page); // 等页面 hydrate 完成再判定/操作，稳定性
    const pwdReady = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 3000 });
    if (pwdReady) {
      log('登录1：已在登录密码页（承接注册流程），跳过重开官网/重填邮箱，直接填密码');
      landing = 'password';
    }
  }

  if (landing === null) {
    log('登录1：打开 ChatGPT 官网');
    await openWithRetry(page, chatgptUrl, log);
    await sleep(2500);

    if (isLoggedInUrl(page.url())) {
      const t0 = await readAccessToken(page);
      if (t0.accessToken) { log('登录：已是登录态'); return { accessToken: t0.accessToken, user: t0.user, expires: t0.expires }; }
    }

    log('登录2：进入登录入口');
    let emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 2500 });
    for (let attempt = 1; attempt <= 3 && !emailInput; attempt += 1) {
      const clicked = await humanClickByText(page, ['登录', 'log in', 'login', 'sign in', 'ログイン'], { timeout: 15000, exclude: OAUTH_EXCLUDE });
      log(`登录2：点击登录入口「${clicked || '未命中'}」（第 ${attempt} 次），等待邮箱框…`);
      emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 20000 });
      if (!emailInput) {
        await humanClickByText(page, ['continue with email', 'use email', '使用邮箱', 'メールで続ける'], { timeout: 6000, exclude: OAUTH_EXCLUDE });
        emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 10000 });
      }
    }
    if (!emailInput) { await snapshot(page, 'login-no-email', log); throw new Error('登录：未找到邮箱输入框'); }

    await humanType(emailInput, email);
    log(`登录2：已填邮箱 ${email}，点继续`);
    await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE });
    landing = await waitForPostEmailLanding(page, log, { timeoutMs: 120000 });
  }

  // 老账号可能有密码页：有密码就登录；密码错/无密码/提交卡住 →
  // 先尝试"改用验证码"(OTP)，仍不行则走"忘记密码"重设兜底（绕开不响应的 Remix 密码表单）。
  let resetPassword = ''; // 若走了忘记密码流程，这里是新设的密码，需回传存储
  if (landing === 'password') {
    let passwordSubmitted = false;
    if (password) {
      // auth.openai.com 表单提交 flaky：提交没前进就 reload 重试（reload=全新 hydration），最多 3 轮
      for (let attempt = 1; attempt <= 3 && !passwordSubmitted; attempt += 1) {
        log(`登录3：密码页，填写密码（第 ${attempt} 次）`);
        await waitForAuthReady(page);
        const pwdInput = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 10000 });
        if (!pwdInput) break;
        await humanType(pwdInput, password);
        const beforeUrl = page.url();
        await pwdInput.fill(password).catch(() => {});
        await sleep(300);
        await pwdInput.press('Enter').catch(() => {});
        await page.waitForFunction((u) => location.href !== u, beforeUrl, { timeout: 6000 }).catch(() => {});
        if (page.url() === beforeUrl) {
          const btn = page.locator('button:has-text("继续"), button:has-text("Continue")').first();
          await btn.click({ timeout: 6000 }).catch(() => {});
          await page.waitForFunction((u) => location.href !== u, beforeUrl, { timeout: 8000 }).catch(() => {});
        }
        passwordSubmitted = page.url() !== beforeUrl;
        if (!passwordSubmitted && attempt < 3) {
          // 密码明确错误（有报错文案）→ 不再重试，直接走忘记密码
          const wrongPwd = await page.evaluate(() => /密码.*(不正确|错误|无效)|incorrect|invalid password|wrong password/i.test(document.body.innerText || '')).catch(() => false);
          if (wrongPwd) { log('登录3：密码明确不正确，转忘记密码'); break; }
          log('登录3：提交未生效，reload 重试');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(2000);
        }
      }
      log(passwordSubmitted ? '登录3：密码已提交，页面已前进' : '登录3：密码提交多次未生效');
    } else {
      log('登录3：密码页但无密码，尝试改用验证码登录');
      await humanClickByText(page, ['改用验证码', '使用验证码', '通过电子邮件', 'email a code', 'send code', '发送验证码', 'use a code', 'verification code'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    }
    // 密码未提交成功且没进到收码页 → 忘记密码重设兜底
    if (!passwordSubmitted) {
      const otpReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 8000 });
      if (!otpReady && !isLoggedInUrl(page.url())) {
        log('登录3b：无密码/密码错/无 OTP 入口，走"忘记密码"重设流程');
        resetPassword = await forgotPasswordFlow({ page, email, requestCode, log });
      }
    }
  }

  // 登录4a：先处理 2FA 验证器（TOTP）页——密码提交后若账号已开 2FA 会弹此页（URL /mfa-challenge/），
  // 它也有验证码输入框，必须在"邮箱收码块"之前处理，否则会被误当邮箱码而去等永远不来的邮件（空等超时）。
  const did2fa = await handleLoginTotpPrompt(page, totpSecret, log);

  // 收码页 → 取码填码（裸 auth 页可能需 resend 重试，最多 3 轮）。
  // 若已处理 2FA / 已登录 / 忘记密码已完成，则跳过，避免空等。
  const alreadyResolved = did2fa || isLoggedInUrl(page.url()) || Boolean(resetPassword);
  const codeReady = alreadyResolved
    ? null
    : await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 60000 });
  if (codeReady) {
    log('登录4：收码页就绪，取码填码');
    const code = await requestCode('login');
    await fillCode(page, code, log);
    await submitCodeForm(page, log);
    await sleep(4000);
    for (let r = 1; r <= 2; r += 1) {
      if (!(await isOnCodePage(page))) break;
      log(`登录4：仍在收码页，点重新发送取新码（第 ${r} 轮）`);
      await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend email', 'resend'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      const c2 = await requestCode('login');
      await fillCode(page, c2, log);
      await submitCodeForm(page, log);
      await sleep(4000);
    }
    // 邮箱码之后可能再要 2FA（部分账号先邮箱验证再验证器）
    await handleLoginTotpPrompt(page, totpSecret, log);
  } else {
    log('登录4：未见邮箱收码页（已登录/已处理2FA/密码直登）');
  }

  await waitForSuccess(page, log, 90000);
  let t = await readAccessToken(page);
  for (let i = 0; i < 5 && !t.accessToken; i += 1) { await sleep(2000); t = await readAccessToken(page); }
  if (!t.accessToken) throw new Error(`登录后未取到 accessToken：${t.error || '未知'}`);
  log(`登录成功，已取到 accessToken${resetPassword ? '（经忘记密码重设，新密码已生成）' : ''}`);
  return { accessToken: t.accessToken, user: t.user, expires: t.expires, resetPassword };
}

// 登录时若弹出"输入验证器验证码"(2FA TOTP)页，用 secret 生成 6 位码填入。
// 判定以 URL path /mfa-challenge/ 为主，辅以 #totp_otp / 验证器·一次性密码 文案。
// - 确在 2FA 页但无 secret → 明确抛错（无法自动通过，快速失败而非去空等永不到来的邮箱码）。
// - 填码后仍停在 2FA 页 → 抛"2FA 密钥不正确"（存储 secret 与账号不匹配）。
// 返回 true=已处理并通过 2FA；false=当前不是 2FA 页（无需处理）。
async function handleLoginTotpPrompt(page, totpSecret, log) {
  try {
    let isTotp = false;
    for (let i = 0; i < 8; i += 1) {
      isTotp = await page.evaluate(() => {
        const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        // 2FA 验证器登录页 URL 为 /mfa-challenge/...（path 为最确定信号）
        if (/\/mfa-challenge\//i.test(location.href)) return true;
        if (vis(document.querySelector('#totp_otp, input[name="totp_otp"]'))) return true;
        const t = document.body?.innerText || '';
        // "验证你的身份 / 一次性验证码 / 一次性密码程序 / 验证器应用 / authenticator"
        return /验证器应用|输入验证器|authenticator|two-factor|双重验证|验证你的身份|一次性验证码|一次性密码/i.test(t) && vis(document.querySelector('input'));
      }).catch(() => false);
      if (isTotp) break;
      if (isLoggedInUrl(page.url())) return false; // 已登录，无需 2FA
      await sleep(800);
    }
    if (!isTotp) return false;

    // 确在 2FA 页：无 secret 无法自动通过 → 快速明确失败（不再去空等邮箱码）
    if (!totpSecret) {
      throw new Error('账号已开启 2FA，但本地没有该账号的 2FA 密钥(totp_secret)，无法自动通过验证器登录');
    }

    await snapshot(page, 'login-2fa-page', log);
    const code = generateTotpNow(totpSecret);
    log(`登录5：检测到 2FA 验证器页，用 secret 生成 TOTP 填入`);
    const before = page.url();
    // 2FA 页输入框：#totp_otp 或 name=code（inputmode=numeric），优先具体选择器
    const totpInput = await firstVisible(page, '#totp_otp, input[name="totp_otp"], input[name="code"][inputmode="numeric"], input[name="code"]', { timeout: 3000 });
    if (totpInput) { await humanType(totpInput, code); await totpInput.press('Enter').catch(() => {}); }
    else await fillCode(page, code, log);
    await page.waitForFunction((u) => location.href !== u, before, { timeout: 5000 }).catch(() => {});
    if (page.url() === before) {
      await humanClickByText(page, ['继续', 'confirm', 'verify', '确认', '验证', 'continue', 'next', '下一步'], { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      await page.waitForFunction((u) => location.href !== u, before, { timeout: 6000 }).catch(() => {});
    }
    if (page.url() === before) {
      await page.evaluate(() => { const f = document.querySelector('input')?.closest('form'); if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()); }).catch(() => {});
    }
    await sleep(2000);

    // 校验 TOTP 是否被接受：轮询几秒等跳转；仍停在 2FA 页 → 密钥不匹配，明确报错
    let stillOn2fa = true;
    for (let i = 0; i < 6; i += 1) {
      if (isLoggedInUrl(page.url())) { stillOn2fa = false; break; }
      stillOn2fa = await page.evaluate(() => {
        const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        if (/\/mfa-challenge\//i.test(location.href)) return true;
        return vis(document.querySelector('#totp_otp, input[name="totp_otp"]'));
      }).catch(() => false);
      if (!stillOn2fa) break;
      await sleep(1000);
    }
    if (stillOn2fa) {
      throw new Error('2FA 密钥不正确：用存储的 2FA 密钥(totp_secret)生成的验证码被拒，密钥与账号不匹配');
    }
    return true;
  } catch (e) {
    // 明确的 2FA 失败（无密钥 / 密钥不正确）往上抛，让整轮以清晰原因失败；其余异常按原逻辑吞掉
    if (/2FA|totp_secret|验证器|密钥/i.test(String(e && e.message))) throw e;
    log(`登录5：2FA 处理异常：${e.message}`);
    return false;
  }
}

// 老账号：登录已注册账号 → 设密码 + 开 2FA → 取 token。复用 loginChatGPT + step8。
export async function secureExistingChatGPT({ page, email, loginPassword = '', enable2fa = true, forceReset2fa = false, existingTotpSecret = '', chatgptUrl = 'https://chatgpt.com/', requestCode, log }) {
  const newPassword = generatePassword();

  log('老账号1：登录');
  const login = await loginChatGPT({ page, email, password: loginPassword, totpSecret: existingTotpSecret, chatgptUrl, requestCode, log });

  log(`老账号2：设置密码 + ${enable2fa ? (forceReset2fa ? '强制重设' : '开启') : '（跳过）'} TOTP 2FA`);
  let secure;
  try {
    secure = await step8_setupPasswordAnd2FA(page, { email, password: newPassword, enable2fa, forceReset2fa, existingTotpSecret, requestCode, log });
  } catch (e) {
    const partial = e._secure || {};
    e._partial = {
      email,
      // 最终密码：忘记密码重设 > step8 真正新设 > 用于登录的原密码（passwordChanged 才是"确实改了"）
      password: login.resetPassword || (partial.passwordChanged ? newPassword : (loginPassword || '')),
      passwordSet: Boolean(login.resetPassword) || partial.passwordSet || false,
      // 2FA：step8 新开用新 secret；未改则回传注入的 existingTotpSecret，避免存空覆盖库里已有密钥
      twoFactorSecret: partial.twoFactorSecret || existingTotpSecret || '',
      twoFactorUri: partial.twoFactorUri || '',
      recoveryCodes: partial.recoveryCodes || [],
      twoFactorSet: partial.twoFactorSet || false,
      accessToken: login.accessToken,
      user: login.user,
      expires: login.expires,
      mode: 'existing',
    };
    throw e;
  }

  return {
    email,
    // 最终密码：忘记密码重设 > step8 真正新设 > 用于登录的原密码（passwordChanged 才是"确实改了"）
    password: login.resetPassword || (secure.passwordChanged ? newPassword : (loginPassword || '')),
    passwordSet: Boolean(login.resetPassword) || secure.passwordSet,
    // 2FA：step8 新开用新 secret；未改则回传注入的 existingTotpSecret，避免存空覆盖库里已有密钥
    twoFactorSecret: secure.twoFactorSecret || existingTotpSecret,
    twoFactorUri: secure.twoFactorUri,
    recoveryCodes: secure.recoveryCodes,
    twoFactorSet: secure.twoFactorSet,
    accessToken: login.accessToken,
    user: login.user,
    expires: login.expires,
    mode: 'existing',
  };
}

// 新注册：register → password → code → profile → success → token → step8。
// 若检测到「邮箱已注册」，返回 { emailExists:true } 让 worker 分流到 secureExistingChatGPT。
export async function registerChatGPT({ page, email, chatgptUrl = 'https://chatgpt.com/', enable2fa = true, requestCode, log }) {
  const password = generatePassword();
  const { firstName, lastName } = generateRandomName();
  const birthday = generateRandomBirthday();

  log('步骤1：打开 ChatGPT 官网');
  await openWithRetry(page, chatgptUrl, log);
  await sleep(3000);

  log('步骤2：进入注册入口');
  let emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 2500 });
  for (let attempt = 1; attempt <= 3 && !emailInput; attempt += 1) {
    const clicked = await humanClickByText(page, [
      '免费注册', 'sign up for free', 'sign up', '注册', '登録', 'get started', 'create account', 'create',
    ], { timeout: 15000 });
    log(`步骤2：模拟点击注册入口「${clicked || '未命中'}」（第 ${attempt} 次），等待邮箱输入框弹出…`);
    emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 22000 });
    if (!emailInput) {
      await humanClickByText(page, ['continue with email', 'use email', '使用邮箱', 'メールで続ける'], { timeout: 6000 });
      emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 10000 });
    }
  }
  if (!emailInput) {
    await snapshot(page, 'no-email-input', log);
    throw new Error('未找到邮箱输入框');
  }

  await humanType(emailInput, email);
  log(`步骤2：已填写邮箱 ${email}`);
  await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE });
  log('步骤2：已点击「继续」，等待 OpenAI 处理并跳转（按钮可能先 loading）…');

  const landing = await waitForPostEmailLanding(page, log, { timeoutMs: 120000 });

  // 邮箱已存在检测：不再抛错，返回标记让 worker 走"老账号"分流
  const afterEmailText = await pageText(page);
  if (S.EMAIL_EXISTS_PATTERN.test(afterEmailText)) {
    log('步骤2：检测到邮箱已注册（页面文案），转入老账号（登录→按需忘记密码）流程');
    return { emailExists: true };
  }

  // 落到"密码页"需区分：注册的「创建密码」页 vs 已注册账号的「登录密码」页。
  // 已注册账号若继续填随机注册密码会卡死（密码错、无法前进，等验证码页 120s 超时）——
  // 应转 worker 的老账号分流：用本地存储密码登录，密码错再走忘记密码重设。
  // 判据：URL 命中 /log-in/，或页面出现"忘记了密码/forgot password"链接（创建密码页没有）。
  if (landing === 'password') {
    const looksLikeLogin = await page.evaluate(() => {
      if (/\/log-in(\/|$|\?|#)/i.test(location.href)) return true;
      const t = document.body?.innerText || '';
      return /忘记了密码|忘记密码|forgot password|欢迎回来|welcome back/i.test(t);
    }).catch(() => false);
    if (looksLikeLogin) {
      log(`步骤2：落到登录密码页（邮箱已注册），转入老账号（登录→按需忘记密码）流程，URL=${page.url()}`);
      return { emailExists: true };
    }
  }

  // 步骤3：密码（仅当跳转到密码页时才填；很多流程 email 后直接发码、无密码页）
  if (landing === 'password') {
    log('步骤3：已进入密码页，填写密码');
    const pwdInput = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 15000 });
    if (pwdInput) {
      await humanType(pwdInput, password);
      await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE });
      log('步骤3：密码已提交，等待跳转到验证码页（按钮可能先 loading）…');
      await waitForCodePage(page, log, { timeoutMs: 120000 });
    }
  } else {
    log('步骤3：本流程 email 后直接进入验证码页，跳过密码步骤');
  }

  // 步骤4：验证码——先确认已在验证码页（跳转完成），再向 Python 请求验证码
  log('步骤4：确认验证码页已就绪');
  const codeReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 60000 });
  if (!codeReady) {
    await snapshot(page, 'no-code-page', log);
    throw new Error('点击继续后未跳转到验证码输入页（可能仍在 loading 或出现异常）');
  }
  log('步骤4：验证码页已就绪，开始取码并填写');
  const code = await requestCode('register');
  await fillCode(page, code, log);
  await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 10000, exclude: OAUTH_EXCLUDE });
  await sleep(3000);

  const afterCodeText = await pageText(page);
  if (S.INVALID_CODE_PATTERN.test(afterCodeText)) {
    throw new Error('验证码无效');
  }

  // 验证码后按页面路径判新老：无资料页 + 已在已登录主界面 = 邮箱已验证的无密码老号（OTP 登录）。
  // 转 worker 的老账号加固分流（登录已登录态 → 设密码 → 2FA），避免误当新号在 step8 反复撞设密码坑。
  const branch = await detectPostCodeBranch(page, log, { timeoutMs: 20000 });
  if (branch === 'existing') {
    log('步骤5：验证码后无资料页且已在主界面 → 判定为「邮箱已验证的无密码老号」（OTP 登录），转老账号加固流程');
    return { emailExists: true };
  }

  // 步骤5：资料（姓名 + 生日）
  log('步骤5：填写姓名与生日');
  await fillProfile(page, { firstName, lastName, birthday }, log);
  await checkConsentIfAny(page, log);

  const submitTexts = [
    '完成账户创建', '完成帐户创建', '完成', '创建账号', '创建帐户', '创建账户',
    'create account', 'finish', 'done', 'agree', "i'm 18", '同意', '继续', 'continue', 'next', '下一步',
  ];
  const submitted = await humanClickByText(page, submitTexts, { timeout: 12000, exclude: OAUTH_EXCLUDE });
  log(`步骤5：已点击资料提交按钮「${submitted || '未命中'}」`);
  await sleep(3000);

  await humanClickByText(page, ['agree', 'continue', '同意', '继续', 'okay', 'ok', 'got it', 'stay logged out'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});

  // 步骤5.5：资料提交后可能被打回"二次邮箱验证"（auth.openai.com/email-verification）。
  for (let round = 1; round <= 2; round += 1) {
    const onCodePage = await isOnCodePage(page);
    if (!onCodePage) break;
    log(`步骤5.5：检测到二次验证码页（第 ${round} 轮），点击重新发送以获取新码`);
    await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend email', 'resend', '重新发送邮件'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    const code2 = await requestCode('register');
    await fillCode(page, code2, log);
    await submitCodeForm(page, log);
    await sleep(4000);
    const bad = await pageText(page);
    if (S.INVALID_CODE_PATTERN.test(bad)) throw new Error('二次验证码无效');
  }

  // 步骤6：等待注册成功
  log('步骤6：等待注册完成');
  await waitForSuccess(page, log);

  // 步骤7：读取 accessToken
  log('步骤7：读取 accessToken');
  let tokenResult = await readAccessToken(page);
  for (let i = 0; i < 5 && !tokenResult.accessToken; i += 1) {
    await sleep(2000);
    tokenResult = await readAccessToken(page);
  }
  if (!tokenResult.accessToken) {
    throw new Error(`注册流程走完但未取到 accessToken：${tokenResult.error || '未知'}`);
  }
  log('已获取 accessToken');

  // 步骤8：设置密码 + 开启 TOTP 2FA（必须成功，任一失败则整轮注册失败）
  log(`步骤8：设置密码${enable2fa ? ' + 开启 TOTP 2FA' : '（2FA 已关闭，跳过）'}`);
  let secure;
  try {
    secure = await step8_setupPasswordAnd2FA(page, { email, password, enable2fa, requestCode, log });
  } catch (e) {
    const partial = e._secure || {};
    e._partial = {
      email,
      password: partial.passwordSet ? password : '',
      passwordSet: partial.passwordSet || false,
      twoFactorSecret: partial.twoFactorSecret || '',
      twoFactorUri: partial.twoFactorUri || '',
      recoveryCodes: partial.recoveryCodes || [],
      twoFactorSet: partial.twoFactorSet || false,
      firstName, lastName, birthday,
      accessToken: tokenResult.accessToken,
      user: tokenResult.user,
      expires: tokenResult.expires,
      mode: 'register',
    };
    throw e;
  }

  return {
    email,
    password: secure.passwordSet ? password : '',
    passwordSet: secure.passwordSet,
    twoFactorSecret: secure.twoFactorSecret,
    twoFactorUri: secure.twoFactorUri,
    recoveryCodes: secure.recoveryCodes,
    twoFactorSet: secure.twoFactorSet,
    firstName,
    lastName,
    birthday,
    accessToken: tokenResult.accessToken,
    user: tokenResult.user,
    expires: tokenResult.expires,
    mode: 'register',
  };
}

async function fillCode(page, code, log) {
  const segmented = page.locator(S.CODE_INPUT_SEGMENTED);
  const segCount = await segmented.count().catch(() => 0);
  if (segCount >= code.length) {
    for (let i = 0; i < code.length; i += 1) {
      const cell = segmented.nth(i);
      await cell.click({ delay: 30 }).catch(() => {});
      await cell.pressSequentially(code[i], { delay: 80 }).catch(() => {});
      await sleep(80 + Math.floor(Math.random() * 120));
    }
    log('已按分格模拟输入验证码');
    return;
  }
  const single = await firstVisible(page, S.CODE_INPUT, { timeout: 8000 });
  if (single) {
    await humanType(single, code);
    log('已模拟输入验证码');
    return;
  }
  await page.keyboard.type(code, { delay: 80 });
  log('已通过键盘输入验证码');
}

// 提交验证码表单：先在框内按 Enter，再点"继续"兜底，最后原生 form.requestSubmit()。
async function submitCodeForm(page, log) {
  const before = page.url();
  try {
    const codeInput = page.locator(`${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`).last();
    if (await codeInput.count()) { await codeInput.press('Enter').catch(() => {}); }
  } catch { /* ignore */ }
  await sleep(1500);
  let left = await hasLeftCodePage(page, before);
  if (!left) {
    await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    await sleep(1500);
    left = await hasLeftCodePage(page, before);
  }
  if (!left) {
    await page.evaluate(() => {
      const inp = document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
      const form = inp?.closest('form');
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }).catch(() => {});
    await sleep(1500);
  }
  log('已提交验证码表单');
}

async function hasLeftCodePage(page, beforeUrl) {
  try {
    if (page.url() !== beforeUrl) return true;
    const stillCode = await page.evaluate((sel) => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      return vis(document.querySelector(sel.code)) || [...document.querySelectorAll(sel.seg)].some(vis);
    }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED });
    return !stillCode;
  } catch {
    return true;
  }
}

// 验证码提交后按「页面路径」判新老，不依赖数据库：
//   · 真新号：验证码后进「资料页（姓名/生日）」或「创建密码页」等注册专属步骤。
//   · 邮箱已验证但从未设密码的老号：填邮箱后 OpenAI 直接发 OTP（页面与新号验证码页无法区分），
//     验证码后 OTP 登录直接落已登录主界面，没有任何注册后续步骤。
// 返回 'existing'（老号 → 应转 secureExistingChatGPT）或 'register'（新号 → 继续注册）。
// 判据只取当前 DOM/URL；存疑或超时一律回退 'register'，绝不误伤真新号（新号被误判也只是多走一次
// 已登录快速登录，step8 同样设密码+2FA，结果等价）。
async function detectPostCodeBranch(page, log, { timeoutMs = 20000 } = {}) {
  const profileSel = `${S.NAME_INPUT}, ${S.FIRST_NAME_INPUT}, ${S.LAST_NAME_INPUT}, ${S.BIRTHDAY_INPUT}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await page.evaluate((sel) => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const anyVis = (q) => [...document.querySelectorAll(q)].some(vis);
      return {
        url: location.href,
        hasProfile: anyVis(sel),
        hasPassword: anyVis('input[type="password"], input[autocomplete="new-password"]'),
        text: (document.body?.innerText || '').slice(0, 4000),
      };
    }, profileSel).catch(() => null);
    if (!st) { await sleep(1200); continue; }
    // 出现注册专属步骤（资料 / 创建密码）→ 真新号，继续原注册流程
    if (st.hasProfile || st.hasPassword) return 'register';
    // 已落已登录主界面（URL 干净 + 主界面文案，或已能取 token）且无资料页 → 已验证无密码老号
    if (isLoggedInUrl(st.url)) {
      if (S.SUCCESS_TEXTS.some((t) => st.text.includes(t))) return 'existing';
      const tok = await readAccessToken(page).catch(() => ({}));
      if (tok.accessToken) return 'existing';
    }
    await sleep(1500);
  }
  return 'register'; // 超时保守回退，避免误伤真新号
}

async function fillProfile(page, { firstName, lastName, birthday }, log) {
  const full = await firstVisible(page, S.NAME_INPUT, { timeout: 8000 });
  if (full) {
    await humanType(full, `${firstName} ${lastName}`);
    log(`已填写姓名 ${firstName} ${lastName}`);
  } else {
    const fn = await firstVisible(page, S.FIRST_NAME_INPUT, { timeout: 3000 });
    const ln = await firstVisible(page, S.LAST_NAME_INPUT, { timeout: 3000 });
    if (fn) await humanType(fn, firstName);
    if (ln) await humanType(ln, lastName);
    if (fn || ln) log(`已分字段填写姓名 ${firstName} / ${lastName}`);
  }
  await fillBirthday(page, birthday, log);
}

async function checkConsentIfAny(page, log) {
  try {
    const checked = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const isChecked = (el) => el.checked === true || el.getAttribute('aria-checked') === 'true';
      let n = 0;
      for (const b of boxes) {
        if (!visible(b) || isChecked(b)) continue;
        const label = b.closest('label');
        (label && label.click) ? label.click() : b.click();
        if (isChecked(b) || b.getAttribute('aria-checked') === 'true') n += 1;
      }
      return n;
    });
    if (checked) log(`步骤5：已勾选 ${checked} 个同意复选框`);
  } catch { /* ignore */ }
}

async function waitForSuccess(page, log, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) { log(`当前页面：${url}`); lastUrl = url; }
    const text = await pageText(page);
    if (S.SUCCESS_TEXTS.some((t) => text.includes(t))) {
      log('检测到主界面文案，注册成功');
      return true;
    }
    if (isLoggedInUrl(url)) {
      const t = await readAccessToken(page);
      if (t.accessToken) {
        log('会话已建立，注册成功');
        return true;
      }
    }
    await sleep(2500);
  }
  log('等待注册成功超时，仍尝试读取 token');
  await snapshot(page, 'wait-success-timeout', log);
  return false;
}

// 观察用：dump 可见按钮/输入/提示。默认仅在 REG_DIAG_DIR 时输出详细日志 + 截图。
async function dumpUi(page, tag, log) {
  if (!DIAG_DIR) return {};
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const t = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return {
      url: location.href,
      buttons: [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab]')].filter(vis).map(t).filter(Boolean).slice(0, 45),
      inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder, al: i.getAttribute('aria-label') })),
      hints: [...new Set([...document.querySelectorAll('h1,h2,h3,label,span,p,div')].filter(vis).map(t).filter((x) => /密码|password|多重|两步|验证器|authenticator|2fa|mfa|multi-factor|two-factor|安全|security|恢复|recovery|设置密码|create password|set password/i.test(x) && x.length < 60))].slice(0, 25),
    };
  }).catch((e) => ({ err: e.message }));
  log(`[UI:${tag}] url=${info.url} btns=${JSON.stringify(info.buttons)} inputs=${JSON.stringify(info.inputs)} hints=${JSON.stringify(info.hints)}`);
  await snapshot(page, `s8-${tag}`, log);
  return info;
}

// 定位靠结构（evaluate 打标记），点击仍走真实鼠标（page.click）。
async function clickMarked(page, findFn, arg) {
  const MARK = 'data-reg-mark';
  const label = await page.evaluate(({ fnStr, a, mark }) => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
    // eslint-disable-next-line no-new-func
    const fn = new Function('vis', 'arg', fnStr);
    const el = fn(vis, a);
    if (el) { el.setAttribute(mark, '1'); return (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 40) || '(marked)'; }
    return null;
  }, { fnStr: `return (${findFn.toString()})(vis, arg);`, a: arg, mark: MARK }).catch(() => null);
  if (label != null) {
    try { await page.click(`[${MARK}="1"]`, { timeout: 5000 }); return label; }
    catch { /* 被遮挡/重绘 */ }
    finally { await page.evaluate((m) => document.querySelectorAll('[' + m + ']').forEach((e) => e.removeAttribute(m)), MARK).catch(() => {}); }
  }
  return null;
}

// 找到"某关键词所在的最小行"里的按钮（如 密码行的"添加"）。
function findRowButton(vis, { kw, btns }) {
  const re = new RegExp(kw, 'i');
  const btnRe = btns.map((b) => b.toLowerCase());
  const nodes = [...document.querySelectorAll('div,li,section,tr')].filter(vis)
    .map((el) => ({ el, txt: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.txt && x.txt.length < 80 && re.test(x.txt.slice(0, 12)))
    .sort((a, b) => a.txt.length - b.txt.length);
  for (const { el } of nodes) {
    const btn = [...el.querySelectorAll('button,a,[role="button"]')].filter(vis)
      .find((b) => { const t = (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase(); return btnRe.some((x) => t === x || t.includes(x)); });
    if (btn) return btn;
  }
  return null;
}

// 找到"某关键词所在行"里的开关（role=switch / checkbox）。
function findRowSwitch(vis, { kw }) {
  const re = new RegExp(kw, 'i');
  const nodes = [...document.querySelectorAll('div,li,section,tr')].filter(vis)
    .map((el) => ({ el, txt: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.txt && x.txt.length < 140 && re.test(x.txt))
    .sort((a, b) => a.txt.length - b.txt.length);
  for (const { el } of nodes) {
    const sw = [...el.querySelectorAll('button[role="switch"],[role="switch"],input[type="checkbox"]')].filter(vis)[0];
    if (sw) return sw;
  }
  return null;
}

// 关掉注册后的欢迎/引导插页（"你已准备就绪"等），会挡住设置入口。
async function dismissWelcomeOverlays(page, log) {
  const texts = ['继续', 'continue', 'get started', '开始', '知道了', '好的', 'got it', 'okay', 'ok', '完成', 'done', 'next', '下一步', '跳过', 'skip'];
  const detect = () => page.evaluate(() => {
    const t = document.body?.innerText || '';
    return /你已准备就绪|准备就绪|欢迎使用|welcome|请勿分享敏感信息|may (make mistakes|be reviewed)|可能会出错|了解更多/i.test(t);
  }).catch(() => false);

  let appeared = false;
  for (let i = 0; i < 12; i += 1) {
    if (await detect()) { appeared = true; break; }
    await sleep(800);
  }
  if (!appeared) { log('步骤8：未见欢迎插页，直接打开设置'); return; }

  for (let i = 0; i < 4; i += 1) {
    if (!(await detect())) break;
    const hit = await humanClickByText(page, texts, { timeout: 3000, exclude: OAUTH_EXCLUDE }).catch(() => null);
    log(`步骤8：关闭欢迎插页「${hit || '未命中'}」（第 ${i + 1} 轮）`);
    if (!hit) break;
    await sleep(1500);
  }
}

async function openSettings(page, log) {
  const opened = await clickMarked(page, (vis) => {
    const btn = document.querySelector('[data-testid="accounts-profile-button"]');
    if (btn && vis(btn)) return btn;
    const btns = [...document.querySelectorAll('button')].filter(vis);
    return btns.find((b) => { const r = b.getBoundingClientRect(); return r.bottom > window.innerHeight - 130 && r.left < 300; }) || null;
  });
  log(`步骤8：点击账户按钮「${opened || '未命中(试文案兜底)'}」`);
  if (!opened) {
    await humanClickByText(page, ['打开个人资料菜单', 'open profile menu', 'user menu', 'profile menu', 'account menu'], { timeout: 6000 }).catch(() => {});
  }
  await sleep(1200);
  const clicked = await humanClickByText(page, ['设置', 'settings'], { timeout: 6000 });
  await sleep(2500);
  // 兜底：账户菜单/设置项点击不稳时，设置弹窗为 hash 路由（chatgpt.com/#settings），直接直达。
  if (!(await settingsDialogOpen(page))) {
    log('步骤8：菜单未打开设置弹窗，改用 #settings 直达');
    await page.evaluate(() => { window.location.hash = 'settings'; }).catch(() => {});
    await sleep(2800);
  }
  return clicked;
}

// 检测安全tab是否已成功打开（密码设置相关元素是否可见）
async function waitForSecurityTabReady(page, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      // 检测密码相关行或Authenticator相关行是否可见
      const rows = [...document.querySelectorAll('div, li, section')].filter(vis);
      const hasPasswordRow = rows.some((el) => {
        const txt = (el.innerText || '').trim();
        return txt.length < 200 && /密码|password/i.test(txt) && !/设置密码|create password|set password/i.test(txt);
      });
      const hasAuthRow = rows.some((el) => {
        const txt = (el.innerText || '').trim();
        return txt.length < 200 && /authenticator|验证器应用|身份验证器/i.test(txt);
      });
      // 全新号安全tab里密码尚未设置，只有“设置密码”按钮 + 多重验证入口——
      // 上面两个检测会漏判。补：security-tab 处于选中态，或出现“设置密码/多重验证”即算就绪。
      const secTabActive = !!document.querySelector('[data-testid="security-tab"][aria-selected="true"],[data-testid="security-tab"][data-state="active"]');
      const hasSecurityContent = rows.some((el) => {
        const txt = (el.innerText || '').trim();
        return txt.length < 200 && /设置密码|create password|set password|多重验证|多因素|two-factor|multi-factor|恢复码|recovery code|通行密钥|passkey/i.test(txt);
      });
      return hasPasswordRow || hasAuthRow || secTabActive || hasSecurityContent;
    }).catch(() => false);

    if (ready) return true;
    await sleep(500);
  }
  return false;
}

// 打开设置并进入安全tab，带重试逻辑
async function openSecurityTab(page, log, { maxRetries = 3 } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`步骤8：尝试打开安全tab（第 ${attempt}/${maxRetries} 次）`);

    // 打开设置
    await openSettings(page, log);

    // 点击安全tab：优先用稳定 testid（security-tab），失败再退回中文文案。
    // 注意：设置面板新增了“内容安全”(safety-setting-tab)，任何按“安全”做包含匹配都会误点它，
    // 所以文案兜底只用完整词“账户安全与登录”，绝不用裸“安全/security”。
    let secTab = await clickByTestId(page, 'security-tab', { timeout: 6000 });
    if (!secTab) {
      secTab = await humanClickByText(page, ['账户安全与登录', '帐户安全与登录', 'account security & sign in'], { timeout: 6000 }).catch(() => null);
    }
    log(`步骤8：点击安全tab「${secTab || '未命中'}」`);
    await sleep(1800);

    // 检测是否真正切换成功
    const ready = await waitForSecurityTabReady(page, { timeout: 20000 });
    if (ready) {
      log(`步骤8：安全tab已成功打开（第 ${attempt} 次尝试）`);
      return true;
    }

    log(`步骤8：安全tab未正确显示（第 ${attempt} 次），密码设置元素未出现`);

    // 如果不是最后一次尝试，则刷新页面重试
    if (attempt < maxRetries) {
      log('步骤8：刷新页面准备重试');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await dismissWelcomeOverlays(page, log);
    }
  }

  throw new Error(`打开安全tab失败：尝试 ${maxRetries} 次后仍无法显示密码设置元素`);
}

// 停用已启用的 Authenticator 2FA（强制重设时先调用）。
async function disable2fa(page, oldSecret, log) {
  let hit = await clickMarked(page, findRowSwitch, { kw: 'authenticator|验证器应用|身份验证器' });
  if (!hit) hit = await humanClickByText(page, ['authenticator app', 'authenticator', '身份验证器', '验证器应用'], { timeout: 4000 }).catch(() => null);
  log(`步骤8：点击停用 2FA 开关「${hit || '未命中'}」`);
  await sleep(2000);
  await dumpUi(page, '04c0-disable-dialog', log);

  for (let r = 0; r < 3; r += 1) {
    const needTotp = await page.evaluate(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      return vis(document.querySelector('#totp_otp, input[name="totp_otp"]'))
        || (/验证器|authenticator|一次性验证码|当前.*验证码/i.test(document.body.innerText || '') && vis(document.querySelector('input[type="text"],input[inputmode="numeric"]')));
    }).catch(() => false);
    if (needTotp && oldSecret) {
      const code = generateTotpNow(oldSecret);
      log(`步骤8：停用需当前验证器码，用旧 secret 生成 TOTP`);
      const inp = await firstVisible(page, '#totp_otp, input[name="totp_otp"], input[inputmode="numeric"], input[type="text"]', { timeout: 3000 });
      if (inp) await humanType(inp, code);
    }
    const c = await humanClickByText(page, ['停用', '关闭', '移除', '禁用', '确认', '继续', 'disable', 'turn off', 'remove', 'confirm', 'continue', '删除'], { timeout: 4000, exclude: OAUTH_EXCLUDE }).catch(() => null);
    await sleep(2000);
    const off = await page.evaluate(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const rows = [...document.querySelectorAll('div,li,section')].filter(vis)
        .filter((el) => /authenticator/i.test(el.innerText || '') && (el.innerText || '').length < 120)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      for (const row of rows) {
        const sw = [...row.querySelectorAll('[role="switch"],input[type="checkbox"]')].filter(vis)[0];
        if (sw) return !(sw.getAttribute('aria-checked') === 'true' || sw.checked === true);
      }
      return false;
    }).catch(() => false);
    log(`步骤8：停用尝试 ${r + 1}「${c || '无按钮'}」→ ${off ? '已关闭' : '仍开启'}`);
    if (off) return true;
  }
  return false;
}

async function step8_setupPasswordAnd2FA(page, { email, password, enable2fa = true, forceReset2fa = false, existingTotpSecret = '', requestCode, log }) {
  // passwordChanged=true 仅当本次「确实设置/更改了密码」；检测到已存在而跳过时保持 false，
  // 供 secureExistingChatGPT 判断该存"新密码"还是"沿用登录用的原密码"。
  const out = { passwordSet: false, passwordChanged: false, password, twoFactorSecret: '', twoFactorUri: '', recoveryCodes: [], twoFactorSet: false, observed: {} };
  try {
    if (!/chatgpt\.com/.test(page.url())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3000);
    }
    await dumpUi(page, '00-loggedin', log);

    await dismissWelcomeOverlays(page, log);

    log('步骤8：打开设置并进入安全tab');
    await openSecurityTab(page, log);
    await dumpUi(page, '02-security', log);

    // —— 设密码 ——（幂等：已设过则跳过）
    const pwAlready = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return /密码\s*\*{3,}/.test(t) || /密码[\s\S]{0,16}(更改|编辑|change|edit)/i.test(t);
    }).catch(() => false);
    if (pwAlready) {
      log('步骤8：检测到密码已设置（密码行为"更改"），跳过设密码');
      out.passwordSet = true;
    } else {
      log('步骤8：设置密码 — 点击密码行的「添加」');
      let pwEntry = await clickMarked(page, findRowButton, { kw: '密码|password', btns: ['添加', 'add', 'set', '设置', 'create', '创建'] });
      if (!pwEntry) pwEntry = await humanClickByText(page, ['设置密码', '创建密码', 'set password', 'create password'], { timeout: 3000 }).catch(() => null);
      log(`步骤8：密码入口「${pwEntry || '未命中'}」`);
      await sleep(2500);
      await dumpUi(page, '03-password-entry', log);

      // 设密码前 OpenAI 常要求先邮箱验证（跳 auth.openai.com 收码页）
      for (let r = 1; r <= 3; r += 1) {
        if (!(await isOnCodePage(page))) break;
        log(`步骤8：设密码前需邮箱验证（第 ${r} 轮），取码`);
        if (r > 1) await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend'], { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => {});
        const vcode = await requestCode('password');
        await fillCode(page, vcode, log);
        await submitCodeForm(page, log);
        await sleep(3500);
        await dumpUi(page, `03b-after-verify-${r}`, log);
      }

      const pwdInput = await firstVisible(page, 'input[type="password"], input[autocomplete="new-password"]', { timeout: 8000 });
      if (pwdInput) {
        const all = page.locator('input[type="password"]');
        const n = await all.count();
        await humanType(all.nth(0), password);
        if (n > 1) await humanType(all.nth(1), password);
        await humanClickByText(page, ['保存', '设置密码', '设置', '确认', '继续', '更新', 'save', 'set password', 'set', 'confirm', 'continue', 'update'], { timeout: 6000, exclude: OAUTH_EXCLUDE });
        await sleep(2500);
        await dumpUi(page, '04-password-submitted', log);
        // 提交后可能还有一次邮箱验证
        const codeBox = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 4000 });
        if (codeBox) {
          log('步骤8：设密码后需邮箱验证，取码');
          const code = await requestCode('password');
          await fillCode(page, code, log);
          await submitCodeForm(page, log);
          await sleep(2500);
        }
        out.passwordSet = true;
        out.passwordChanged = true; // 确实新设了密码 → 上层应存这个新密码
        log('步骤8：密码已提交');
      } else {
        throw new Error('设密码失败：未找到密码输入框');
      }
    }

    // 2FA 关闭：只设密码即可返回
    if (!enable2fa) {
      log('步骤8：enable_2fa=false，跳过 2FA 设置');
      return out;
    }

    // 设密码若在 auth.openai.com 完成会跳回 chatgpt.com，此时需重开设置进安全 tab。
    // 但若刚跳过设密码（密码已设），设置弹窗仍停在安全 tab——此时重开反而会把已打开的弹窗切掉，
    // 导致后续 2FA 开关全部「未命中」。故先探测安全面板（Authenticator 行）是否已可见，
    // 已在安全 tab 就直接开 2FA，只有真正离开时才重开。
    const onSecurityAlready = await page.evaluate(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const t = document.body?.innerText || '';
      const inSettings = /#settings/i.test(location.hash) || /account security|账户安全与登录|帐户安全与登录/i.test(t);
      const hasAuthRow = [...document.querySelectorAll('div,li,section')].some(
        (el) => vis(el) && /authenticator|验证器应用|身份验证器/i.test(el.innerText || '') && (el.innerText || '').length < 200
      );
      return inSettings && hasAuthRow;
    }).catch(() => false);

    if (onSecurityAlready) {
      log('步骤8：设置弹窗仍在安全 tab，直接开 2FA（跳过重开设置）');
    } else {
      log('步骤8：设密码完成，重新打开设置进安全 tab 准备开 2FA');
      if (!/chatgpt\.com/.test(page.url())) {
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(2500);
      }
      await dismissWelcomeOverlays(page, log);
      await openSecurityTab(page, log);
    }
    await dumpUi(page, '04b-security-again', log);

    // —— 开 2FA —— 幂等检测
    const twofaAlready = await page.evaluate(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      if (/验证器应用已启用|authenticator app enabled/i.test(document.body.innerText || '')) return true;
      const rows = [...document.querySelectorAll('div,li,section')].filter(vis)
        .filter((el) => /authenticator/i.test(el.innerText || '') && (el.innerText || '').length < 120)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      for (const row of rows) {
        const sw = [...row.querySelectorAll('[role="switch"],input[type="checkbox"]')].filter(vis)[0];
        if (sw) return sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
      }
      return false;
    }).catch(() => false);

    if (twofaAlready) {
      if (!forceReset2fa) {
        log('步骤8：检测到 2FA 已启用，跳过开启（保留原有 secret）');
        out.twoFactorSet = true;
        return out;
      }
      log('步骤8：强制重设 2FA — 先停用已有的 Authenticator');
      const disabled = await disable2fa(page, existingTotpSecret, log);
      if (!disabled) throw new Error('强制重设2FA失败：无法停用已有的验证器（可能缺少旧 secret 或停用流程变更）');
      await sleep(1500);
      await dumpUi(page, '04c-2fa-disabled', log);
    }

    log('步骤8：开启 TOTP 2FA — 点击 Authenticator app 开关');
    let twofaToggle = await clickMarked(page, findRowSwitch, { kw: 'authenticator|验证器应用|身份验证器' });
    if (!twofaToggle) twofaToggle = await humanClickByText(page, ['authenticator app', 'authenticator', '身份验证器', '验证器应用', '设置', 'set up'], { timeout: 4000 }).catch(() => null);
    log(`步骤8：2FA 入口「${twofaToggle || '未命中'}」`);
    await sleep(2500);
    await dumpUi(page, '05-2fa-entry', log);

    for (let r = 1; r <= 2; r += 1) {
      if (!(await isOnCodePage(page))) break;
      log(`步骤8：开2FA前需邮箱验证（第 ${r} 轮），取码`);
      if (r > 1) await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend'], { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      const vc = await requestCode('2fa');
      await fillCode(page, vc, log);
      await submitCodeForm(page, log);
      await sleep(3000);
      await dumpUi(page, `05a-2fa-verified-${r}`, log);
    }

    let secretInfo = await extractTotpSecret(page);
    if (!secretInfo.uri && !secretInfo.key) {
      await humanClickByText(page, ['无法扫描', '手动输入', '手动', "can't scan", 'enter code manually', 'manually', 'setup key', 'secret key'], { timeout: 3000 }).catch(() => {});
      await sleep(1500);
      await dumpUi(page, '05b-2fa-manual', log);
      secretInfo = await extractTotpSecret(page);
    }
    log(`步骤8：2FA secret 探测 uri=${secretInfo.uri ? 'yes' : 'no'} key=${secretInfo.key || '(无)'}`);
    const secret = secretInfo.key || secretInfo.uri;
    if (!secret) throw new Error('开2FA失败：未提取到 TOTP secret（仅二维码/入口异常）');

    out.twoFactorSecret = secretInfo.key || '';
    out.twoFactorUri = secretInfo.uri || '';
    const code = generateTotpNow(secret);
    log(`步骤8：用 secret 生成 TOTP，回填确认`);
    const codeBox = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 6000 });
    if (!codeBox) throw new Error('开2FA失败：未找到 TOTP 确认输入框');
    await fillCode(page, code, log);
    await humanClickByText(page, ['继续', 'confirm', 'verify', '确认', '验证', '启用', 'enable', '下一步', 'next'], { timeout: 5000, exclude: OAUTH_EXCLUDE });
    await sleep(2500);
    await dumpUi(page, '06-2fa-confirmed', log);
    const recovery = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const codes = t.match(/\b[a-z0-9]{4,5}-[a-z0-9]{4,5}\b/gi) || t.match(/\b[A-Z0-9]{8,12}\b/g) || [];
      return [...new Set(codes)].slice(0, 12);
    }).catch(() => []);
    out.recoveryCodes = recovery;
    await humanClickByText(page, ['完成', '继续', '我已保存', 'done', 'continue', 'i saved', 'close'], { timeout: 4000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    out.twoFactorSet = true;
    log(`步骤8：2FA 已开启，恢复码 ${recovery.length} 个`);
  } catch (e) {
    log(`步骤8失败：${e.message}`, 'error');
    await snapshot(page, 's8-error', log).catch(() => {});
    const err = new Error(`密码/2FA 设置失败：${e.message}`);
    err._secure = out;
    throw err;
  }
  return out;
}

// 从当前页提取 TOTP secret：otpauth:// URI 或明文 base32 密钥。
async function extractTotpSecret(page) {
  return page.evaluate(() => {
    const decode = (s) => s
      .replace(/&amp;/g, '&').replace(/&#x3D;/gi, '=').replace(/&#61;/g, '=')
      .replace(/&#x26;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const html = document.documentElement.innerHTML || '';
    const bodyText = document.body.innerText || '';
    let uri = '';
    const uriM = html.match(/otpauth:\/\/totp\/[^\s"'<>]+/i);
    if (uriM) uri = decode(uriM[0]);
    let keyFromUri = '';
    if (uri) { const m = uri.match(/[?&]secret=([A-Z2-7]+)/i); if (m) keyFromUri = m[1].toUpperCase(); }
    const keyM = bodyText.match(/\b([A-Z2-7]{4}\s){3,7}[A-Z2-7]{4}\b/) || bodyText.match(/\b[A-Z2-7]{16,64}\b/);
    const keyFromText = keyM ? keyM[0].replace(/\s+/g, '').toUpperCase() : '';
    return { uri, key: keyFromUri || keyFromText };
  }).catch(() => ({ uri: '', key: '' }));
}

export default { registerChatGPT, loginChatGPT, secureExistingChatGPT };
export { step8_setupPasswordAnd2FA, dismissWelcomeOverlays, fillCode, isOnCodePage, isLoggedInUrl };
// 内部辅助导出（供 scripts/ 勘察脚本按生产同款路径复现，不改变行为）
export { openSettings, openSecurityTab, waitForSecurityTabReady };
