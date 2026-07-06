import { sleep, generateRandomName, generateRandomBirthday, generatePassword, generateTotpNow } from '../../utils.js';
import * as S from './selectors.js';
import { detectInvalidCode } from './code-errors.js';
import { throwIfRateLimited } from './rate-limit.js';
import { detectAuthState, PAGE_STATE } from './auth-state.js';

// 未开启 DOM 记录时的空记录器（record/finalize 均无副作用，保证生产零开销）。
const NOOP_RECORDER = { enabled: false, async record() {}, async finalize() { return {}; } };

// ============================================================================
// ChatGPT 注册/登录/账号加固流程（Playwright/CloakBrowser 版）
// 移植自 browserregister src/flows/openai/register.js，主要改动：
//   1) 验证码不再由本进程轮询邮箱，而是通过注入的 requestCode(purpose) 向 Python 请求；
//      Python（mail_code + mail_provider）按 need_code.ts 过滤旧码并轮询取新验证码。
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

/** 等待 DOM 加载完成（domcontentloaded + readyState=complete）。全站统一页面等待口径。 */
async function waitForDomReady(page, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const remain = () => Math.max(500, deadline - Date.now());
  if (remain() <= 500) return false;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: remain() });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: remain() });
    return true;
  } catch {
    return false;
  }
}

/** 表单提交前等待 DOM 就绪；超时 60s 则刷新后重试。 */
const FORM_SUBMIT_PAGE_LOAD_MS = 60000;

async function waitForPageFullyLoaded(page, { timeoutMs = FORM_SUBMIT_PAGE_LOAD_MS, log } = {}) {
  if (await waitForDomReady(page, { timeoutMs })) return;

  log?.(`页面 DOM 加载超过 ${Math.round(timeoutMs / 1000)}s，刷新浏览器`, 'warn');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(800);
  if (!(await waitForDomReady(page, { timeoutMs: Math.min(timeoutMs, 20000) }))) {
    log?.('刷新后页面仍未完全加载，继续尝试提交', 'warn');
  }
}

// 在按钮/链接里按文案找可点击元素，然后用 Playwright 真实（humanize）点击。
// 命中 form 内按钮或 type=submit 时，点击前自动 waitForPageFullyLoaded（可用 awaitPageLoad 强制/跳过）。
async function humanClickByText(page, texts, { timeout = 15000, poll = 400, exclude = [], awaitPageLoad, log } = {}) {
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
        const loc = page.locator(`[${MARK}="1"]`);
        const needsLoadWait = awaitPageLoad !== false && (awaitPageLoad === true || await page.evaluate((mark) => {
          const el = document.querySelector(`[${mark}="1"]`);
          if (!el) return false;
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type === 'submit') return true;
          const form = el.closest('form');
          if (!form) return false;
          const tag = el.tagName;
          return tag === 'BUTTON' || tag === 'INPUT' || el.getAttribute('role') === 'button';
        }, MARK));
        if (needsLoadWait) {
          await waitForPageFullyLoaded(page, { log });
        }
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await loc.click({ timeout: 5000 });
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
  const deadline = Date.now() + timeout;
  const loc = page.locator(selector).first();
  while (Date.now() < deadline) {
    if (await loc.isVisible().catch(() => false)) return loc;
    await sleep(400);
  }
  return null;
}

/** 步骤级时间预算：避免单步长轮询把整轮注册拖到 register_timeout 才失败。 */
function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}
function capTimeout(ms, deadline) {
  return Math.min(ms, remainingMs(deadline));
}

// 单步时间预算：避免「按钮未命中仍长等弹窗」把整轮注册拖到 register_timeout。
const STEP_BUDGETS_MS = {
  enterAuth: 90000,
  postEmail: 120000,
  codePage: 120000,
};

function capByDeadline(requestedMs, deadline) {
  return Math.min(requestedMs, Math.max(0, deadline - Date.now()));
}

function isPastDeadline(deadline) {
  return Date.now() >= deadline;
}

// chatgpt.com 首页点「登录/免费注册」后，等弹窗或邮箱框真正出现（代理慢时不能只点完就查）。
async function waitForAuthEntryOpen(page, { timeout = 10000 } = {}) {
  try {
    await page.locator('[role=dialog]').first().waitFor({ state: 'visible', timeout });
    return true;
  } catch { /* fall through */ }
  return !!(await firstVisible(page, S.EMAIL_INPUT, { timeout: Math.min(timeout, 3000) }));
}

// 等 chatgpt.com 首页 hydrate（按钮可见但 onClick 未绑定时，只会高亮焦点、弹窗不出）。
async function waitForHomeReady(page, { timeout = 20000 } = {}) {
  await waitForDomReady(page, { timeoutMs: timeout }).catch(() => {});
  try {
    await page.locator(
      `[data-testid="${S.SIGNUP_BUTTON_TESTID}"], [data-testid="${S.LOGIN_BUTTON_TESTID}"], [data-testid="${S.NO_AUTH_RIGHT_LOGIN_PANEL_TESTID}"]`,
    ).first().waitFor({ state: 'visible', timeout: Math.min(timeout, 15000) });
  } catch { /* 可能已在 auth 子域或弹窗内 */ }
}

function homeSideAuthPanelSel() {
  return `[data-testid="${S.NO_AUTH_RIGHT_LOGIN_PANEL_TESTID}"]`;
}

// 右侧内嵌「注册或登录」面板（无中央 signup 按钮时直接有邮箱框）。
async function waitForHomeSideAuthEmailInput(page, { timeout = 12000 } = {}) {
  const panel = homeSideAuthPanelSel();
  if (!await page.locator(panel).first().isVisible({ timeout: Math.min(timeout, 5000) }).catch(() => false)) {
    return null;
  }
  const emailInPanel = S.EMAIL_INPUT.split(', ').map((s) => `${panel} ${s.trim()}`).join(', ');
  return firstVisible(page, emailInPanel, { timeout });
}

async function isEmailInHomeSideAuthPanel(emailInput) {
  if (!emailInput) return false;
  return emailInput.evaluate(
    (el, panelTestId) => !!el.closest(`[data-testid="${panelTestId}"]`),
    S.NO_AUTH_RIGHT_LOGIN_PANEL_TESTID,
  ).catch(() => false);
}

async function clickHomeSideAuthContinue(page, log) {
  await waitForPageFullyLoaded(page, { log });
  const panel = homeSideAuthPanelSel();
  const submit = page.locator(`${panel} button[type="submit"]`).first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await submit.click({ timeout: 5000 });
    return 'side-panel-submit';
  }
  return humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
}

async function isEmailInAuthDialog(emailInput) {
  if (!emailInput) return false;
  return emailInput.evaluate((el) => !!el.closest('[role="dialog"]')).catch(() => false);
}

// 采集当前可见的认证 UI（按钮含嵌套文案、输入框、所在容器），供诊断 brief 使用。
async function collectAuthUiSnapshot(page) {
  return page.evaluate((panelTestId) => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
    };
    const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const scopeOf = (el) => {
      if (el.closest('[role="dialog"]')) return 'dialog';
      if (el.closest(`[data-testid="${panelTestId}"]`)) return 'side_panel';
      return 'page';
    };

    const buttons = [];
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')) {
      if (!vis(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 120) continue;
      buttons.push({
        text,
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        scope: scopeOf(el),
      });
      if (buttons.length >= 30) break;
    }

    const inputs = [];
    for (const el of document.querySelectorAll('input, textarea')) {
      if (!vis(el)) continue;
      inputs.push({
        type: (el.getAttribute('type') || 'text').toLowerCase(),
        label: el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || '',
        valueLen: String(el.value || '').length,
        scope: scopeOf(el),
      });
      if (inputs.length >= 20) break;
    }

    let authSurface = 'unknown';
    const dialog = document.querySelector('[role="dialog"]');
    const panel = document.querySelector(`[data-testid="${panelTestId}"]`);
    if (dialog && vis(dialog)) authSurface = 'dialog';
    else if (panel && vis(panel)) authSurface = 'side_panel';
    else if (inputs.some((i) => i.scope !== 'page') || buttons.some((b) => b.scope !== 'page')) authSurface = 'embedded';

    return { authSurface, buttons, inputs };
  }, S.NO_AUTH_RIGHT_LOGIN_PANEL_TESTID).catch(() => ({ authSurface: 'unknown', buttons: [], inputs: [], error: 'eval_failed' }));
}

async function clickAuthDialogContinue(page, log) {
  await waitForPageFullyLoaded(page, { log });
  const submit = page.locator('[role=dialog] button[type="submit"]').first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await submit.click({ timeout: 5000 });
    return 'dialog-submit';
  }
  return humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
}

// 填邮箱并点继续；右侧面板 / 中央弹窗分别限定 scope 点击。
// 返回 { hit, authSurface, preUi, postUi } 供诊断采集。
async function fillAuthEmailAndContinue(page, emailInput, email, log) {
  await humanType(emailInput, email);
  log(`正在填写邮箱：${email}`);
  const inSidePanel = await isEmailInHomeSideAuthPanel(emailInput);
  const inDialog = await isEmailInAuthDialog(emailInput);
  const authSurface = inSidePanel ? 'side_panel' : inDialog ? 'dialog' : 'auth_page';
  const preUi = await collectAuthUiSnapshot(page);

  let hit;
  if (inSidePanel) {
    log('右侧登录/注册面板：点击「继续」…');
    hit = await clickHomeSideAuthContinue(page, log);
  } else if (inDialog) {
    log('登录/注册弹窗：点击「继续」…');
    hit = await clickAuthDialogContinue(page, log);
  } else {
    hit = await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
  }
  if (!hit) {
    log('邮箱提交 · 「继续」未命中，尝试弹窗/面板 submit 兜底', 'warn');
    hit = await clickAuthDialogContinue(page, log)
      || await clickHomeSideAuthContinue(page, log);
  }
  const postUi = await collectAuthUiSnapshot(page);
  if (!hit) log('邮箱提交 · 「继续」点击失败', 'warn');
  else log(`邮箱提交 · 已点击「${hit}」`);
  return { hit, authSurface, preUi, postUi };
}

// 优先取弹窗内的邮箱框（新版首页注册弹窗把 input 放在 role=dialog 里）。
async function waitForAuthEmailInput(page, { timeout = 22000 } = {}) {
  const inSidePanel = await waitForHomeSideAuthEmailInput(page, { timeout: Math.min(timeout, 8000) });
  if (inSidePanel) return inSidePanel;
  const dialogEmailSel = S.EMAIL_INPUT.split(', ').map((s) => `[role=dialog] ${s.trim()}`).join(', ');
  const inDialog = await firstVisible(page, dialogEmailSel, { timeout: Math.min(timeout, 12000) });
  if (inDialog) return inDialog;
  return firstVisible(page, S.EMAIL_INPUT, { timeout });
}

// 首页登录/注册入口：等 hydrate → testid 多策略点击（locator/Enter/原生 click）→ 文案兜底。
// 点击成功与弹窗出现解耦：按钮高亮但弹窗慢时仍返回命中文案，由外层长轮询等邮箱框。
async function clickHomeAuthButton(page, { testId, texts, exclude = [] } = {}) {
  await waitForHomeReady(page).catch(() => {});

  const tryTestId = async () => {
    if (!testId) return null;
    const btn = page.locator(`[data-testid="${testId}"]`).first();
    if (!await btn.isVisible({ timeout: 3000 }).catch(() => false)) return null;
    await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const attempts = [
      () => btn.click({ timeout: 5000 }),
      async () => { await btn.focus({ timeout: 3000 }); await page.keyboard.press('Enter'); },
      () => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.click(), testId),
    ];
    for (const run of attempts) {
      try {
        await run();
        await sleep(400);
        if (await waitForAuthEntryOpen(page, { timeout: 2500 })) return testId;
      } catch { /* 换下一策略 */ }
    }
    // 策略都试过：仍算点中（用户可见高亮），弹窗由外层继续等
    return testId;
  };

  const hit = await tryTestId()
    || await humanClickByText(page, texts, { timeout: 8000, exclude });
  return hit || null;
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
    await throwIfRateLimited(page, log);
    if (!logged) { log('正在加载，等待跳转到验证码页…'); logged = true; }
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

// 判断当前是否停在"验证码输入页"（auth.openai.com/email-verification）。
async function isOnCodePage(page) {
  try {
    const url = page.url();
    if (!/\/email-verification(?:[/?#]|$)/i.test(url)) return false;
    const dom = await page.evaluate((sel) => {
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const isProfileAge = (el) => el?.getAttribute('name') === 'age' || el?.getAttribute('name') === 'name';
      const one = document.querySelector(sel.code);
      const hasCodeInput = visible(one) && !isProfileAge(one);
      const seg = document.querySelectorAll(sel.seg);
      const hasSeg = seg.length >= 4 && visible(seg[0]);
      const txt = document.body?.innerText || '';
      const hasHint = /检查你的收件箱|输入.*验证码|check your inbox|enter the code|verification code|コードを入力|受信トレイ/i.test(txt);
      return hasCodeInput || hasSeg || hasHint;
    }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED });
    return dom;
  } catch {
    return false;
  }
}

// 单轮邮箱取码最长等待（秒），与 Python mail_code.ROUND_WAIT_TIMEOUT 对齐。
const CODE_POLL_ROUND_SEC = 90;
const CODE_POLL_MAX_ROUNDS = 4;

const RESEND_CODE_TEXTS = [
  '重新发送电子邮件', '重新发送', '重新发送邮件', '重新发送验证码',
  'resend email', 'resend', '再送信', 'メールを再送信',
  'resend email', 'resend', 'send again', "didn't get", '未收到',
];

/** 在收码页点击「重新发送」类按钮。 */
async function clickResendVerificationCode(page, log) {
  const clicked = await humanClickByText(page, RESEND_CODE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE }).catch(() => null);
  if (clicked) log(`已点击重新发送验证码：${clicked}`);
  else log('未找到重新发送按钮，继续等待新邮件', 'warn');
  return Boolean(clicked);
}

/**
 * 向 Python 请求验证码；单轮超时（约 90s）未收到则在页面上点「重新发送」再开下一轮。
 * 最多 CODE_POLL_MAX_ROUNDS 轮，覆盖注册/登录/2FA/设密码等所有收码步骤。
 */
async function requestCodeWithResend(page, requestCode, log, { purpose = 'register', maxRounds = CODE_POLL_MAX_ROUNDS } = {}) {
  if (typeof requestCode !== 'function') throw new Error('requestCode 未注入');
  let lastErr = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (round > 1) {
      log(`等待验证码超过 ${CODE_POLL_ROUND_SEC} 秒，触发页面重新发送，第 ${round - 1} 次`);
      await clickResendVerificationCode(page, log);
      await sleep(2500);
    }
    try {
      return await requestCode(purpose);
    } catch (e) {
      lastErr = e;
      if (round >= maxRounds) break;
    }
  }
  throw lastErr || new Error(`已重新发送 ${maxRounds - 1} 次，仍未收到验证码`);
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
async function openWithRetry(page, url, log, { attempts = 3, recorder = NOOP_RECORDER } = {}) {
  const mark = (id, meta) => recorder.record(id, typeof meta === 'string' ? { note: meta } : meta).catch(() => {});
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 90000 });
      await waitForDomReady(page, { timeoutMs: 45000 }).catch(() => {});
      await page.waitForFunction(
        () => /免费注册|sign up|登录|log ?in|無料でサインアップ|ログイン/i.test(document.body?.innerText || ''),
        { timeout: 30000 }
      ).catch(() => {});
      const txt = await pageText(page);
      if (txt && txt.length > 20) {
        log(`已打开页面（第 ${i} 次），标题：${await page.title().catch(() => '')}`);
        return true;
      }
      let thinUrl = url;
      try { thinUrl = page.url(); } catch { /* ignore */ }
      log(`页面内容过少，第 ${i} 次重新打开`);
      await mark(`register-00-goto-thin-${i}`, { note: '页面内容过少', url: thinUrl, attempt: i, attempts });
    } catch (err) {
      lastErr = err;
      let failUrl = url;
      try { failUrl = page.url(); } catch { /* ignore */ }
      log(`打开页面失败（第 ${i}/${attempts} 次）：${err?.message || err}`);
      await mark(`register-00-goto-fail-${i}`, {
        note: String(err?.message || err),
        url: failUrl,
        attempt: i,
        attempts,
      });
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
    if (ok?.ok) { log(`已选择生日 ${year}-${month}-${day}`); return true; }
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
    log(`已填写生日 ${year}-${month}-${day}`);
    return true;
  }

  if (kind === 'age') {
    const nowYear = new Date().getFullYear();
    const age = Math.max(18, nowYear - Number(year));
    const loc = page.locator('input[name="age"]').first();
    const want = String(age);
    const readAge = async () => String((await loc.inputValue().catch(() => '')) || '').trim();
    const setAgeNative = async () => page.evaluate(({ a }) => {
      const el = document.querySelector('input[name="age"]');
      if (!el) return false;
      el.focus();
      el.value = String(a);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return String(el.value || '').trim() === String(a);
    }, { a: age }).catch(() => false);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await loc.click({ delay: 40 }).catch(() => {});
      await loc.fill('').catch(() => {});
      await loc.fill(want).catch(() => {});
      if ((await readAge()) === want) break;
      await loc.fill('').catch(() => {});
      await loc.pressSequentially(want, { delay: 80 }).catch(() => {});
      if ((await readAge()) === want) break;
      if (await setAgeNative() && (await readAge()) === want) break;
      if (attempt < 3) await sleep(300);
    }
    const got = await readAge();
    if (got !== want) {
      log(`年龄填写失败，期望 ${want} 实际 ${got || '(空)'}`, 'warn');
      return false;
    }
    log(`已填写年龄 ${age}`);
    return true;
  }
  return false;
}

// ---------------- 主流程 ----------------

// 等 auth.openai.com 页面 DOM 就绪再交互（与全站 waitForDomReady 口径一致）。
async function waitForAuthReady(page, { timeout = 12000 } = {}) {
  await waitForDomReady(page, { timeoutMs: timeout }).catch(() => {});
}

// 可靠点击 auth.openai.com 的按钮/链接（Remix 页面对标记点击不稳）：
// 原生 locator 派发真实指针事件 + 滚动入视图 + 多次重试 + 等待导航；
// 兜底 form.requestSubmit；仍不动可 reload 重新 hydrate。同时匹配 button/a/[role=button]
// （"忘记了密码？"是 <a> 链接）。移植自 browserregister clickButtonRobust。
async function clickButtonRobust(page, textRe, { timeout = 10000, tries = 3, reloadOnFail = false, log } = {}) {
  await waitForPageFullyLoaded(page, { log });
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
      await waitForDomReady(page, { timeoutMs: 12000 }).catch(() => {});
    }
  }
  return page.url() !== before;
}

// 忘记密码重设兜底：点"忘记了密码？"→"重置密码"确认 → 邮箱收码（requestCode）→ 设新密码 → 登录。
// 绕开不响应自动化的 Remix 密码登录表单。返回新设的密码（存储用）。
// 移植自 browserregister forgotPasswordFlow，改动：取码走注入的 requestCode('login')（Python 持邮箱池）。
async function forgotPasswordFlow({ page, email, requestCode, log, recorder = NOOP_RECORDER }) {
  const newPassword = generatePassword();
  log(`重设密码 · 已生成新密码：${newPassword}`);
  const mark = (id, meta) => recorder.record(id, typeof meta === 'string' ? { note: meta } : meta).catch(() => {});
  // 1) 点"忘记了密码？"
  const moved1 = await clickButtonRobust(page, S.FORGOT_PASSWORD_PATTERN, { timeout: 8000, log });
  log(`重设密码 · 点击忘记密码，${moved1 ? '页面已跳转' : '页面未变化'}`);
  await mark('forgot-01-click', { note: moved1 ? 'forgot-link-moved' : 'forgot-link-no-move', url: page.url() });
  await sleep(2000);
  if (await clickRetryIfError(page, log)) {
    await mark('forgot-01-retry', { note: 'reset-password 错误页已点重试', url: page.url() });
    await sleep(2000);
  }
  await snapshot(page, 'forgot-01-after-click', log);

  // 2) 重置密码确认页："点击继续以重置 X 的密码" → 点"继续"发送重置码
  if (/reset-password/i.test(page.url())) {
    if (await clickRetryIfError(page, log)) {
      await mark('forgot-02-retry', { note: '确认页错误页已点重试', url: page.url() });
      await sleep(2000);
    }
    const moved2 = await clickButtonRobust(page, S.RESET_CONTINUE_PATTERN, { timeout: 12000, tries: 4, reloadOnFail: true, log });
    log(`重设密码 · 点击继续发送重置邮件，${moved2 ? '页面已跳转' : '页面未变化'}`);
    await throwIfRateLimited(page, log);
    await sleep(2500);
    if (await clickRetryIfError(page, log)) {
      await mark('forgot-02-retry', { note: '继续后错误页已点重试', url: page.url() });
      await sleep(2000);
    }
    await mark('forgot-02-continue', { note: moved2 ? 'continue-moved' : 'continue-no-move', url: page.url() });
    await snapshot(page, 'forgot-02-after-continue', log);
  } else {
    await mark('forgot-02-skip', { note: '非 reset-password URL，跳过继续', url: page.url() });
  }

  // 3) 收码页 → 向 Python 请求重置码填码
  const codeReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 40000 });
  if (codeReady) {
    await mark('forgot-03-pre-code', { note: '收码框已出现', url: page.url() });
    log('重设密码 · 等待邮箱验证码');
    const code = await requestCodeWithResend(page, requestCode, log, { purpose: 'login' });
    await fillCode(page, code, log);
    await submitCodeForm(page, log, { code });
    await sleep(3500);
    await snapshot(page, 'forgot-03-after-code', log);
    await mark('forgot-03-code', { note: '忘记密码：重置码已提交', url: page.url() });
  } else {
    await throwIfRateLimited(page, log);
    log('重设密码 · 未出现验证码输入页，继续尝试');
    await mark('forgot-03-no-code', { note: '等待收码框超时', url: page.url() });
    await snapshot(page, 'forgot-02b-no-code', log);
  }

  // 4) 新密码页：必须确认在"新密码/重置"页（避免把登录密码框误当新密码框）
  await firstVisible(page, 'input[type="password"], input[autocomplete="new-password"]', { timeout: 20000 }).catch(() => null);
  const onNewPwdPage = await page.evaluate(() => {
    const url = location.href;
    if (/new-password|reset-password\/|create-password/i.test(url)) return true;
    const pw = document.querySelectorAll('input[type="password"]');
    const t = document.body.innerText || '';
    return pw.length >= 2 || new RegExp(S.NEW_PASSWORD_PAGE_PATTERN.source, 'i').test(t);
  }).catch(() => false);
  if (!onNewPwdPage) {
    await mark('forgot-04-no-pwd-page', { note: '未到新密码页', url: page.url() });
    await snapshot(page, 'forgot-no-pwd-form', log);
    throw new Error(`忘记密码流程：未到新密码页（当前 ${page.url()}），重置码/确认步骤可能失败`);
  }
  const all = page.locator('input[type="password"]');
  const n = await all.count();
  await humanType(all.nth(0), newPassword);
  if (n > 1) await humanType(all.nth(1), newPassword);
  log(`重设密码 · 填写新密码：${newPassword}`);
  const beforeSet = page.url();
  await waitForPageFullyLoaded(page, { log });
  await all.nth(Math.max(0, n - 1)).press('Enter').catch(() => {});
  await page.waitForFunction((u) => location.href !== u, beforeSet, { timeout: 5000 }).catch(() => {});
  if (page.url() === beforeSet) await clickButtonRobust(page, S.RESET_SAVE_PATTERN, { timeout: 8000, log });
  await sleep(3500);
  await mark('forgot-04-password-set', { note: '新密码已提交', url: page.url() });
  await snapshot(page, 'forgot-04-after-set', log);

  // 5) 重设成功页（/reset-password/success）不会自动登录：需点"登录"回登录页，再用新密码登录。
  //    每次跳转后先 waitForAuthReady 等页面 hydrate 完成再操作（避免点击/输入落空）。
  await waitForAuthReady(page);
  const onResetDone = /reset-password\/success/i.test(page.url())
    || await page.evaluate((reSrc) => new RegExp(reSrc, 'i').test(document.body?.innerText || ''), S.RESET_SUCCESS_PATTERN.source).catch(() => false);
  if (onResetDone || /reset-password/i.test(page.url())) {
    log('重设密码 · 密码已更新，返回登录页');
    const movedLogin = await clickButtonRobust(page, S.LOGIN_LINK_PATTERN, { timeout: 8000, tries: 3, log });
    if (!movedLogin || !/\/log-in/i.test(page.url())) {
      // 兜底：直接点 href 指向 /log-in 的链接
      await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find((x) => /\/log-in/i.test(x.getAttribute('href') || ''));
        if (a) a.click();
      }).catch(() => {});
      await page.waitForFunction(() => /\/log-in/i.test(location.href), { timeout: 8000 }).catch(() => {});
    }
    await waitForAuthReady(page);
    await mark('forgot-05-back-login', { note: '已返回登录页', url: page.url() });
  }

  // 6) 登录页用刚设的新密码登录（session 记得邮箱，通常直达 /log-in/password）。
  //    2FA / 最终成功由 loginChatGPT 后续 handleLoginTotpPrompt + waitForSuccess 接管。
  if (/\/log-in\/password/i.test(page.url())) {
    const pwd = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 12000 });
    if (pwd) {
      log(`重设密码 · 使用新密码登录：${newPassword}`);
      await humanType(pwd, newPassword);
      const beforeLogin = page.url();
      await waitForPageFullyLoaded(page, { log });
      await pwd.press('Enter').catch(() => {});
      await page.waitForFunction((u) => location.href !== u, beforeLogin, { timeout: 8000 }).catch(() => {});
      if (page.url() === beforeLogin) {
        await humanClickByText(page, [...S.CONTINUE_TEXTS, '登录', 'log in', 'sign in', 'ログイン'], { timeout: 6000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log }).catch(() => {});
        await page.waitForFunction((u) => location.href !== u, beforeLogin, { timeout: 8000 }).catch(() => {});
      }
      await sleep(2500);
    }
  } else if (/\/log-in(\/|$|\?)/i.test(page.url())) {
    // 兜底：落到邮箱输入页 → 重填邮箱再进密码页登录
    const emailInput = await firstVisible(page, S.EMAIL_INPUT, { timeout: 8000 });
    if (emailInput) {
      await humanType(emailInput, email);
      await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 8000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log }).catch(() => {});
      await waitForAuthReady(page);
      const pwd2 = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 12000 });
      if (pwd2) {
        log(`重设密码 · 重新填写邮箱后登录，密码：${newPassword}`);
        await humanType(pwd2, newPassword);
        const b2 = page.url();
        await waitForPageFullyLoaded(page, { log });
        await pwd2.press('Enter').catch(() => {});
        await page.waitForFunction((u) => location.href !== u, b2, { timeout: 8000 }).catch(() => {});
        await sleep(2500);
      }
    }
  }
  await snapshot(page, 'forgot-06-after-relogin', log);
  await mark('forgot-06-relogin', { note: '忘记密码：已用新密码重登', url: page.url() });
  return newPassword;
}

// 登录密码页是否已明确报错（邮箱/密码错误）——命中后应直接走忘记密码，不再 reload 重试。
async function isLoginPasswordRejected(page) {
  const pattern = S.WRONG_LOGIN_PASSWORD_PATTERN.source;
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const pwd = document.querySelector(
      'input[type="password"][name="current-password"], input[type="password"][autocomplete*="current-password"], input[type="password"]',
    );
    if (pwd) {
      if (pwd.getAttribute('aria-invalid') === 'true' || pwd.getAttribute('data-invalid') === 'true') {
        return true;
      }
    }
    const errNodes = document.querySelectorAll(
      '.react-aria-FieldError, [slot="errorMessage"], [class*="_error_"], li[class*="_error_"]',
    );
    for (const el of errNodes) {
      const t = (el.innerText || el.textContent || '').trim();
      if (t && re.test(t)) return true;
    }
    return re.test(document.body?.innerText || '');
  }, pattern).catch(() => false);
}

// 提交密码后短轮询：页面跳转成功 / 明确密码错误 / 超时仍停在原页。
async function waitForLoginPasswordOutcome(page, beforeUrl, { timeoutMs = 8000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (page.url() !== beforeUrl) return 'navigated';
    } catch { /* page closed */ }
    await throwIfRateLimited(page);
    if (await isLoginPasswordRejected(page)) return 'rejected';
    await sleep(pollMs);
  }
  if (await isLoginPasswordRejected(page)) return 'rejected';
  try {
    return page.url() !== beforeUrl ? 'navigated' : 'unchanged';
  } catch {
    return 'unchanged';
  }
}

// 老账号登录（OTP 收码登录）。验证码通过 requestCode('login') 向 Python 请求。
// totpSecret：若账号已开 2FA，登录后会要求验证器码，传入 secret 则自动生成 TOTP 填入。
export async function loginChatGPT({ page, email, chatgptUrl = 'https://chatgpt.com/', password = '', totpSecret = '', requestCode, log, recorder = NOOP_RECORDER }) {
  const mark = (id, meta) => recorder.record(id, typeof meta === 'string' ? { note: meta } : meta).catch(() => {});
  let landing = null;

  // 快路径：若调用前页面已停在 auth 登录密码页（注册流程检测到"邮箱已注册"后直接转来），
  // 跳过重开官网 / 重点登录 / 重填邮箱，直接在当前密码页登录，节省一整轮邮箱输入。
  if (/auth\.openai\.com\/log-in\/password/i.test(page.url())) {
    await waitForAuthReady(page); // 等页面 hydrate 完成再判定/操作，稳定性
    const pwdReady = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 3000 });
    if (pwdReady) {
      log('登录 · 已在密码页，直接填写密码');
      landing = 'password';
    }
  }

  if (landing === null) {
    log('登录 · 打开 ChatGPT 官网');
    await openWithRetry(page, chatgptUrl, log, { recorder });
    await sleep(2500);

    if (isLoggedInUrl(page.url())) {
      const t0 = await readAccessToken(page);
      if (t0.accessToken) { log('登录 · 当前已是登录状态'); return { accessToken: t0.accessToken, user: t0.user, expires: t0.expires }; }
    }

    log('登录 · 进入登录入口');
    await waitForHomeReady(page).catch(() => {});
    let emailInput = await waitForHomeSideAuthEmailInput(page, { timeout: 10000 });
    if (emailInput) {
      log('登录 · 检测到登录面板，直接填写邮箱');
    } else {
      emailInput = await waitForAuthEmailInput(page, { timeout: 2500 });
      for (let attempt = 1; attempt <= 2 && !emailInput; attempt += 1) {
        const clicked = await clickHomeAuthButton(page, {
          testId: S.LOGIN_BUTTON_TESTID,
          texts: ['登录', 'log in', 'login', 'sign in', 'ログイン'],
          exclude: OAUTH_EXCLUDE,
        });
        log(`登录 · 点击登录入口，第 ${attempt} 次尝试`);
        emailInput = await waitForAuthEmailInput(page, { timeout: 25000 });
        if (!emailInput) {
          await humanClickByText(page, ['continue with email', 'use email', '使用邮箱', 'メールで続ける'], { timeout: 6000, exclude: OAUTH_EXCLUDE });
          emailInput = await waitForAuthEmailInput(page, { timeout: 12000 });
        }
      }
    }
    if (!emailInput) {
      log('登录 · 首页未出现邮箱框，跳转到登录页');
      await page.goto('https://auth.openai.com/log-in', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await waitForAuthReady(page);
      emailInput = await waitForAuthEmailInput(page, { timeout: 25000 });
    }
    if (!emailInput) { await snapshot(page, 'login-no-email', log); throw new Error('登录：未找到邮箱输入框'); }

    await fillAuthEmailAndContinue(page, emailInput, email, log);
    landing = await waitForPostEmailLanding(page, log, { timeoutMs: 120000 });
  }

  // 老账号可能有密码页：有密码就登录；密码错/无密码/提交卡住 →
  // 先尝试"改用验证码"(OTP)，仍不行则走"忘记密码"重设兜底（绕开不响应的 Remix 密码表单）。
  let resetPassword = ''; // 若走了忘记密码流程，这里是新设的密码，需回传存储
  if (landing === 'password') {
    let passwordSubmitted = false;
    let passwordRejected = false;
    if (password) {
      // auth.openai.com 表单提交 flaky：无报错时 reload 重试；一旦页面标明密码/邮箱错误则立即转忘记密码。
      for (let attempt = 1; attempt <= 3 && !passwordSubmitted && !passwordRejected; attempt += 1) {
        log(`登录 · 填写密码，第 ${attempt} 次尝试：${password}`);
        await waitForAuthReady(page);
        const pwdInput = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 10000 });
        if (!pwdInput) break;
        await humanType(pwdInput, password);
        const beforeUrl = page.url();
        await pwdInput.fill(password).catch(() => {});
        await sleep(300);
        await waitForPageFullyLoaded(page, { log });
        await pwdInput.press('Enter').catch(() => {});

        let outcome = await waitForLoginPasswordOutcome(page, beforeUrl, { timeoutMs: 3500 });
        if (outcome === 'rejected') {
          passwordRejected = true;
          log('登录 · 密码或邮箱错误，改为重设密码');
          break;
        }
        if (outcome !== 'navigated' && page.url() === beforeUrl) {
          const btn = page.locator('button:has-text("继续"), button:has-text("Continue"), button:has-text("続行")').first();
          await waitForPageFullyLoaded(page, { log });
          await btn.click({ timeout: 6000 }).catch(() => {});
          outcome = await waitForLoginPasswordOutcome(page, beforeUrl, { timeoutMs: 5000 });
          if (outcome === 'rejected') {
            passwordRejected = true;
            log('登录 · 密码或邮箱错误，改为重设密码');
            break;
          }
        }
        passwordSubmitted = page.url() !== beforeUrl;
        if (!passwordSubmitted && await clickRetryIfError(page, log)) {
          outcome = await waitForLoginPasswordOutcome(page, beforeUrl, { timeoutMs: 3500 });
          if (outcome === 'rejected') {
            passwordRejected = true;
            log('登录 · 密码或邮箱错误，改为重设密码');
            break;
          }
          passwordSubmitted = page.url() !== beforeUrl;
        }
        if (!passwordSubmitted && !passwordRejected) {
          if (await isLoginPasswordRejected(page)) {
            passwordRejected = true;
            log('登录 · 密码或邮箱错误，改为重设密码');
            break;
          }
          if (attempt < 3) {
            log('登录 · 提交无响应，刷新页面后重试');
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(2000);
          }
        }
      }
      if (passwordSubmitted) {
        log('登录 · 密码已提交，等待下一步');
      } else if (!passwordRejected) {
        log('登录 · 密码多次提交未生效');
      }
    } else {
      log('登录 · 未提供密码，改为邮箱验证码登录');
      await humanClickByText(page, S.LOGIN_OTP_TEXTS, { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    }
    // 密码未提交成功且没进到收码页 → 忘记密码重设兜底
    if (!passwordSubmitted) {
      const otpReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 8000 });
      if (!otpReady && !isLoggedInUrl(page.url())) {
        log('登录 · 密码登录失败，改为重设密码');
        resetPassword = await forgotPasswordFlow({ page, email, requestCode, log, recorder });
      }
    }
  }

  // 登录4a：先处理 2FA 验证器（TOTP）页——密码提交后若账号已开 2FA 会弹此页（URL /mfa-challenge/），
  // 它也有验证码输入框，必须在"邮箱收码块"之前处理，否则会被误当邮箱码而去等永远不来的邮件（空等超时）。
  const did2fa = await handleLoginTotpPrompt(page, totpSecret, requestCode, log);

  // 收码页 → 取码填码（裸 auth 页可能需 resend 重试，最多 3 轮）。
  // 若已处理 2FA / 已登录 / 忘记密码已完成，则跳过，避免空等。
  const alreadyResolved = did2fa || isLoggedInUrl(page.url()) || Boolean(resetPassword);
  const codeReady = alreadyResolved
    ? null
    : await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 60000 });
  if (codeReady) {
    log('登录 · 等待邮箱验证码');
    const code = await requestCodeWithResend(page, requestCode, log, { purpose: 'login' });
    await fillCode(page, code, log);
    await submitCodeForm(page, log, { code });
    await sleep(4000);
    for (let r = 1; r <= 2; r += 1) {
      if (!(await isOnCodePage(page))) break;
      log(`登录 · 重新发送验证码，第 ${r} 次`);
      await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend email', 'resend'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      const c2 = await requestCodeWithResend(page, requestCode, log, { purpose: 'login' });
      await fillCode(page, c2, log);
      await submitCodeForm(page, log, { code: c2 });
      await sleep(4000);
    }
    // 邮箱码之后可能再要 2FA（部分账号先邮箱验证再验证器）
    await handleLoginTotpPrompt(page, totpSecret, requestCode, log);
  } else {
    log('登录 · 无需邮箱验证码，继续下一步');
  }

  await waitForSuccess(page, log, 90000);
  let t = await readAccessToken(page);
  for (let i = 0; i < 5 && !t.accessToken; i += 1) { await sleep(2000); t = await readAccessToken(page); }
  if (!t.accessToken) throw new Error(`登录后未取到 accessToken：${t.error || '未知'}`);
  log(resetPassword ? '登录成功，已获取登录凭证，密码已重设' : '登录成功，已获取登录凭证');
  await mark('login-done', '登录成功，已取 token');
  return { accessToken: t.accessToken, user: t.user, expires: t.expires, resetPassword };
}

async function isMfaEmailChallenge(page) {
  // URL 最确定：切到邮箱验证码后落 /mfa-challenge/email-otp（CDP 实测），命中即算，不再依赖文案。
  try { if (/\/mfa-challenge\/email-otp/i.test(page.url())) return true; } catch { /* ignore */ }
  return page.evaluate((sel) => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const text = document.body?.innerText || '';
    const hasInput = vis(document.querySelector(sel.code)) || [...document.querySelectorAll(sel.seg)].some(vis);
    const hasTotpInput = vis(document.querySelector('#totp_otp, input[name="totp_otp"]'));
    // 邮箱收码页提示（含 email-otp 页的「输入我们刚刚向…发送的验证码」，及「未收到电子邮件？重新发送」）。
    const hasEmailHint = /检查你的收件箱|查看你的邮箱|邮件已发送|邮箱验证码|电子邮件.*验证码|刚刚向.*发送|未收到电子邮件|重新发送|check your inbox|sent.*email|email.*code|verification code|we just sent|didn't get.*email|受信トレイ|メール.*送信|確認コード|届きません|再送信/i.test(text);
    return hasInput && hasEmailHint && !hasTotpInput;
  }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED }).catch(() => false);
}

async function tryLoginMfaEmailFallback(page, requestCode, log) {
  if (typeof requestCode !== 'function') return false;
  await snapshot(page, 'login-2fa-no-secret', log);
  log('登录 · 需要双重验证，本地无验证器密钥，改为邮箱验证码');

  const emailTexts = [
    '电子邮件', '通过电子邮件', '使用邮箱', '邮箱验证码', '发送电子邮件', '发送验证码', '发送邮件',
    'email', 'email a code', 'send code', 'send an email', 'send email', 'use email', 'email verification',
    'メール', 'Eメール', 'メールで確認', 'メールで続行', 'メールにコードを送信',
  ];
  const switchTexts = [
    '改用其他方式', '其他方式', '其他方法', '选择其他方式', '试试其他方式', '尝试其他方法', '无法使用验证器', '使用其他方法',
    'try another method', 'use another method', 'choose another method', 'another method', 'more options', 'lost access',
    '他の方法', '別の方法', '別の認証方法', '他の認証方法',
  ];

  for (let round = 1; round <= 3; round += 1) {
    if (await isMfaEmailChallenge(page)) break;
    let clicked = await humanClickByText(page, emailTexts, { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => null);
    if (!clicked) {
      clicked = await humanClickByText(page, switchTexts, { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => null);
      if (clicked) {
        log(`登录 · 已切换到邮箱验证：${clicked}`);
        await sleep(1200);
        // 点"其他方法"后弹出方式选择页（含"电子邮件"选项），选它切到邮箱收码页。
        const emailClicked = await humanClickByText(page, emailTexts, { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => null);
        if (emailClicked) clicked = emailClicked;
      }
    }
    if (clicked) {
      log(`登录 · 已选择邮箱验证：${clicked}，第 ${round} 次`);
      // 等页面跳转到 email-otp 收码页再复检；已到位立刻结束循环，避免把自己从收码页又点走。
      for (let w = 0; w < 6; w += 1) {
        await sleep(800);
        if (await isMfaEmailChallenge(page)) break;
      }
      if (await isMfaEmailChallenge(page)) break;
    } else {
      await sleep(1000);
    }
  }

  if (!(await isMfaEmailChallenge(page))) {
    await snapshot(page, 'login-2fa-no-email-fallback', log);
    return false;
  }

  log('登录 · 等待邮箱验证码完成双重验证');
  for (let round = 1; round <= 3; round += 1) {
    const code = await requestCodeWithResend(page, requestCode, log, { purpose: 'login' });
    await fillCode(page, code, log);
    await submitCodeForm(page, log, { code });
    await sleep(2500);

    if (isChromeErrorUrl(page.url())) continue;
    if (!(await isMfaEmailChallenge(page))) return true;

    if (!(await detectInvalidCode(page))) {
      await sleep(2000);
      if (!(await isMfaEmailChallenge(page))) return true;
    }

    if (round < 3) {
      log(`登录 · 2FA 邮箱验证码无效或仍停在收码页，重新发送，第 ${round} 次`);
      await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend email', 'resend'], { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      await sleep(1500);
      continue;
    }
    if (await detectInvalidCode(page)) throw new Error('2FA 邮箱验证码无效');
    throw new Error('2FA 邮箱验证码提交后仍停在收码页');
  }
  return false;
}

// 登录时若弹出"输入验证器验证码"(2FA TOTP)页，用 secret 生成 6 位码填入；
// 若本地没有 secret，则先尝试改走 MFA 页提供的邮箱验证码方式。
// 判定以 URL path /mfa-challenge/ 为主，辅以 #totp_otp / 验证器·一次性密码 文案。
// - 确在 2FA 页但无 secret 且没有邮箱 fallback → 明确抛错。
// - 填码后仍停在 2FA 页 → 抛"2FA 密钥不正确"（存储 secret 与账号不匹配）。
// 返回 true=已处理并通过 2FA；false=当前不是 2FA 页（无需处理）。
async function handleLoginTotpPrompt(page, totpSecret, requestCode, log) {
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

    // 确在 2FA 页：无 secret 时先尝试 OpenAI 提供的邮箱验证码备用方式。
    if (!totpSecret) {
      const didEmailFallback = await tryLoginMfaEmailFallback(page, requestCode, log);
      if (didEmailFallback) return true;
      throw new Error('账号已开启 2FA，但本地没有该账号的 2FA 密钥(totp_secret)，无法自动通过验证器登录');
    }

    await snapshot(page, 'login-2fa-page', log);
    const code = generateTotpNow(totpSecret);
    log(`登录 · 填写验证器验证码：${code}`);
    const before = page.url();
    // 2FA 页输入框：#totp_otp 或 name=code（inputmode=numeric），优先具体选择器
    const totpInput = await firstVisible(page, '#totp_otp, input[name="totp_otp"], input[name="code"][inputmode="numeric"], input[name="code"]', { timeout: 3000 });
    if (totpInput) {
      await humanType(totpInput, code);
      await waitForPageFullyLoaded(page, { log });
      await totpInput.press('Enter').catch(() => {});
    }
    else await fillCode(page, code, log);
    await page.waitForFunction((u) => location.href !== u, before, { timeout: 5000 }).catch(() => {});
    if (page.url() === before) {
      await humanClickByText(page, ['继续', 'confirm', 'verify', '确认', '验证', 'continue', 'next', '下一步'], { timeout: 5000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log }).catch(() => {});
      await page.waitForFunction((u) => location.href !== u, before, { timeout: 6000 }).catch(() => {});
    }
    if (page.url() === before) {
      await waitForPageFullyLoaded(page, { log });
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
    log(`登录 · 双重验证处理异常：${e.message}`);
    return false;
  }
}

// step8（设密码 + 开 2FA）失败后的收尾决策：2FA 为可选加固，其失败不否定已成功的密码设置。
// passwordOk=true（密码已设，或老账号登录阶段已用忘记密码重设）→ 返回一个可入号池的 secure
//   （强制 twoFactorSet=false，其余沿用 step8 的部分结果），上层照常标记注册成功；
// passwordOk=false（连密码都没设成）→ 返回 null，上层据此抛错、走异常清单分流。
function resolveStep8Tolerance(partial, passwordOk) {
  if (!passwordOk) return null;
  return { ...(partial || {}), twoFactorSet: false };
}

// 老账号：登录已注册账号 → 设密码 + 开 2FA → 取 token。复用 loginChatGPT + step8。
export async function secureExistingChatGPT({ page, email, loginPassword = '', enable2fa = true, forceReset2fa = false, existingTotpSecret = '', chatgptUrl = 'https://chatgpt.com/', requestCode, log, recorder = NOOP_RECORDER }) {
  const newPassword = generatePassword();
  log(`已有账号 · 生成新密码：${newPassword}`);
  if (loginPassword) log(`已有账号 · 使用历史密码登录：${loginPassword}`);

  log('已有账号 · 开始登录');
  const login = await loginChatGPT({ page, email, password: loginPassword, totpSecret: existingTotpSecret, chatgptUrl, requestCode, log, recorder });

  log(`已有账号 · ${enable2fa ? (forceReset2fa ? '重设双重验证' : '开启双重验证') : '跳过双重验证'}，并设置密码`);
  let secure;
  try {
    secure = await step8_setupPasswordAnd2FA(page, { email, password: newPassword, enable2fa, forceReset2fa, existingTotpSecret, requestCode, log, recorder });
  } catch (e) {
    const partial = e._secure || {};
    // 2FA 为可选加固：密码已设成功（含登录阶段忘记密码重设）就按「无 2FA 账号」正常返回，账号照常入池。
    const tolerated = resolveStep8Tolerance(partial, Boolean(login.resetPassword || partial.passwordSet));
    if (tolerated) {
      log(`已有账号 · 双重验证未完成，密码已设置，按普通账号保存：${e.message}`, 'yellow');
      secure = tolerated;
    } else {
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
export async function registerChatGPT({ page, email, chatgptUrl = 'https://chatgpt.com/', enable2fa = true, requestCode, log, recorder = NOOP_RECORDER }) {
  const password = generatePassword();
  log(`已生成注册密码：${password}`);
  const { firstName, lastName } = generateRandomName();
  const birthday = generateRandomBirthday();
  const mark = (id, meta) => recorder.record(id, typeof meta === 'string' ? { note: meta } : meta).catch(() => {});

  log('注册 · 打开 ChatGPT 官网');
  await openWithRetry(page, chatgptUrl, log, { recorder });
  await waitForHomeReady(page);
  await mark('register-01-home', '已打开官网');

  log('注册 · 进入注册入口');
  const step2Deadline = Date.now() + 90000;
  let emailInput = await waitForHomeSideAuthEmailInput(page, { timeout: capTimeout(10000, step2Deadline) });
  if (emailInput) {
    log('注册 · 检测到注册面板，直接填写邮箱');
  } else {
    emailInput = await waitForAuthEmailInput(page, { timeout: capTimeout(2500, step2Deadline) });
    let missStreak = 0;
    for (let attempt = 1; attempt <= 2 && !emailInput && remainingMs(step2Deadline) > 0; attempt += 1) {
      const clicked = await clickHomeAuthButton(page, {
        testId: S.SIGNUP_BUTTON_TESTID,
        texts: ['免费注册', 'sign up for free', 'sign up', '注册', '登録', '無料でサインアップ', 'get started', 'create account'],
      });
      if (!clicked) missStreak += 1;
      else missStreak = 0;
      log(`注册 · 点击注册入口，第 ${attempt} 次尝试`);
      await mark(`register-02a-after-signup-click-${attempt}`, `点注册入口「${clicked || '未命中'}」后`);
      // 未命中入口时不必长等弹窗；点中后再给稍长窗口
      const popupWait = clicked ? 12000 : 4000;
      emailInput = await waitForAuthEmailInput(page, { timeout: capTimeout(popupWait, step2Deadline) });
      if (!emailInput && clicked) {
        // 按钮已点中但弹窗未出：再试一轮多策略点击（常见于 hydrate 未完成只拿到焦点）
        log('注册 · 注册按钮已点击，等待邮箱输入框出现');
        await clickHomeAuthButton(page, {
          testId: S.SIGNUP_BUTTON_TESTID,
          texts: ['免费注册', 'sign up for free', 'sign up', '注册', '無料でサインアップ'],
        });
        emailInput = await waitForAuthEmailInput(page, { timeout: capTimeout(8000, step2Deadline) });
      }
      if (!emailInput) {
        const em = await humanClickByText(page, [
          'continue with email', 'use email', '使用邮箱', 'メールで続ける', 'メール アドレス',
          '通过电子邮件', '继续使用电子邮件', '使用电子邮件', '电子邮件地址', '用邮箱继续',
        ], { timeout: capTimeout(4000, step2Deadline), exclude: OAUTH_EXCLUDE });
        await mark(`register-02b-after-use-email-${attempt}`, `点「使用邮箱」兜底「${em || '未命中'}」后`);
        emailInput = await waitForAuthEmailInput(page, { timeout: capTimeout(8000, step2Deadline) });
      }
      if (!emailInput && missStreak >= 2) {
        log('注册 · 首页未找到注册入口，跳转到登录页');
        break;
      }
    }
  }
  if (!emailInput) {
    log('注册 · 首页未出现邮箱框，跳转到注册页');
    const gotoMs = capTimeout(45000, step2Deadline) || 15000;
    await page.goto('https://auth.openai.com/log-in', { waitUntil: 'domcontentloaded', timeout: gotoMs }).catch(() => {});
    await waitForAuthReady(page);
    emailInput = await waitForAuthEmailInput(page, { timeout: capTimeout(20000, step2Deadline) || 10000 });
  }
  if (!emailInput) {
    await snapshot(page, 'no-email-input', log);
    await mark('register-02x-no-email', '未找到邮箱输入框（现场）');
    throw new Error('未找到邮箱输入框');
  }

  const emailSubmit = await fillAuthEmailAndContinue(page, emailInput, email, log);
  await mark('register-02-pre-continue', {
    note: `authSurface=${emailSubmit.authSurface}`,
    authSurface: emailSubmit.authSurface,
    authUi: emailSubmit.preUi,
  });
  await mark('register-02-after-continue', {
    note: `continue=${emailSubmit.hit || 'miss'} authSurface=${emailSubmit.authSurface}`,
    continueHit: emailSubmit.hit || null,
    authSurface: emailSubmit.authSurface,
    authUi: emailSubmit.postUi,
  });
  log('注册 · 已提交邮箱，等待页面跳转');

  const landing = await waitForPostEmailLanding(page, log, { timeoutMs: 120000 });
  const postEmailUi = await collectAuthUiSnapshot(page);
  await mark('register-02-post-email', {
    note: `landing=${landing} continue=${emailSubmit.hit || 'miss'}`,
    landing,
    continueHit: emailSubmit.hit || null,
    authSurface: emailSubmit.authSurface,
    authUi: postEmailUi,
  });

  // 邮箱已存在检测：不再抛错，返回标记让 worker 走"老账号"分流
  const afterEmailText = await pageText(page);
  if (S.EMAIL_EXISTS_PATTERN.test(afterEmailText)) {
    log('注册 · 该邮箱已注册，改为登录并加固账号');
    return { emailExists: true };
  }

  // 落到"密码页"需区分：注册的「创建密码」页 vs 已注册账号的「登录密码」页。
  // 用统一状态机判定：pageState=EXISTING_PASSWORD_LOGIN 即已注册账号的登录密码页
  // （原内联判据 URL /log-in/ 或"忘记密码/欢迎回来"文案已并入 auth-state.classifyState）。
  if (landing === 'password') {
    const st = await detectAuthState(page);
    if (st.pageState === PAGE_STATE.EXISTING_PASSWORD_LOGIN) {
      log('注册 · 该邮箱已注册，改为登录并加固账号');
      return { emailExists: true };
    }
  }

  // 步骤3：密码（仅当跳转到密码页时才填；很多流程 email 后直接发码、无密码页）
  if (landing === 'password') {
    log(`注册 · 填写注册密码：${password}`);
    const pwdInput = await firstVisible(page, S.PASSWORD_INPUT, { timeout: 15000 });
    if (pwdInput) {
      await humanType(pwdInput, password);
      await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
      log('注册 · 密码已提交，等待验证码页');
      await waitForCodePage(page, log, { timeoutMs: 120000 });
    }
  } else {
    log('注册 · 跳过密码步骤，直接进入验证码页');
  }

  // 步骤4：验证码——先确认已在验证码页（跳转完成），再向 Python 请求验证码
  log('注册 · 等待验证码输入页');
  const codeReady = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 60000 });
  if (!codeReady) {
    await snapshot(page, 'no-code-page', log);
    throw new Error('点击继续后未跳转到验证码输入页（可能仍在 loading 或出现异常）');
  }
  log('注册 · 开始填写邮箱验证码');
  const code = await requestCodeWithResend(page, requestCode, log, { purpose: 'register' });
  await fillCode(page, code, log);
  await humanClickByText(page, S.CONTINUE_TEXTS, { timeout: 10000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
  await sleep(3000);
  // 提交后落到浏览器错误页 → 刷新重填同码再提交（否则会被误判为"验证码无效"）
  if (await recoverFromChromeError(page, log) && await hasVisibleCodeInput(page)) {
    log('注册 · 页面加载异常，刷新后重新填写验证码', 'warn');
    await fillCode(page, code, log);
    await submitCodeForm(page, log, { code });
    await sleep(3000);
  }
  await mark('register-04-code-filled', '注册验证码已填');

  if (!isChromeErrorUrl(page.url()) && await detectInvalidCode(page)) {
    throw new Error('验证码无效');
  }

  // 验证码后按页面路径判新老：无资料页 + 已在已登录主界面 = 邮箱已验证的无密码老号（OTP 登录）。
  // 转 worker 的老账号加固分流（登录已登录态 → 设密码 → 2FA），避免误当新号在 step8 反复撞设密码坑。
  const branch = await detectPostCodeBranch(page, log, { timeoutMs: 20000 });
  if (branch === 'existing') {
    log('注册 · 该邮箱已验证，改为登录并加固账号');
    return { emailExists: true };
  }

  // 步骤5：资料（姓名 + 生日）
  log('注册 · 填写姓名和生日');
  await fillProfile(page, { firstName, lastName, birthday }, log);
  await checkConsentIfAny(page, log);
  const profileFields = await assertProfileReady(page, log);
  await mark('register-05-profile-filled', `age=${profileFields.age || '-'} birthday=${profileFields.birthday || '-'}`);

  const urlBeforeProfile = page.url();
  const submitted = await humanClickByText(page, S.PROFILE_SUBMIT_TEXTS, { timeout: 12000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
  if (!submitted) {
    await snapshot(page, 'profile-submit-miss', log);
    throw new Error('资料页未找到提交按钮');
  }
  log(`注册 · 已提交个人资料（${submitted}）`);
  await sleep(3000);
  const urlAfterProfile = page.url();
  if (/\/about-you(?:[/?#]|$)/i.test(urlAfterProfile)) {
    await assertProfileReady(page, log).catch((e) => {
      throw new Error(`资料提交后仍停在资料页：${e.message}`);
    });
  }
  await mark('register-05-profile-submitted', `submit=${submitted} urlBefore=${urlBeforeProfile} urlAfter=${urlAfterProfile}`);

  await humanClickByText(page, ['agree', 'continue', '同意', '继续', 'okay', 'ok', 'got it', 'stay logged out'], { timeout: 6000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log }).catch(() => {});

  // 步骤5.5：资料提交后可能被打回"二次邮箱验证"（auth.openai.com/email-verification）。
  for (let round = 1; round <= 2; round += 1) {
    const onCodePage = await isOnCodePage(page);
    if (!onCodePage) break;
    log(`注册 · 需要再次验证邮箱，第 ${round} 次`);
    await mark(`register-05b-second-code-${round}`, `round=${round} url=${page.url()}`);
    await humanClickByText(page, RESEND_CODE_TEXTS, { timeout: 6000, exclude: OAUTH_EXCLUDE }).catch(() => {});
    const code2 = await requestCodeWithResend(page, requestCode, log, { purpose: 'register' });
    await fillCode(page, code2, log);
    await submitCodeForm(page, log, { code: code2 });
    await sleep(4000);
    if (!isChromeErrorUrl(page.url()) && await isOnCodePage(page) && await detectInvalidCode(page)) {
      throw new Error('二次验证码无效');
    }
  }

  // 步骤6：等待注册成功
  log('注册 · 等待注册完成');
  await waitForSuccess(page, log);

  // 步骤7：读取 accessToken
  log('注册 · 获取登录凭证');
  let tokenResult = await readAccessToken(page);
  for (let i = 0; i < 5 && !tokenResult.accessToken; i += 1) {
    await sleep(2000);
    tokenResult = await readAccessToken(page);
  }
  if (!tokenResult.accessToken) {
    throw new Error(`注册流程走完但未取到 accessToken：${tokenResult.error || '未知'}`);
  }
  log('注册 · 已获取登录凭证');
  await mark('register-06-token', '已取到 accessToken，准备 step8');

  // 步骤8：设置密码（必须成功）+ 开启 TOTP 2FA（可选加固，失败可容忍、不影响账号入池）
  log(enable2fa ? '注册 · 设置账号密码并开启双重验证' : '注册 · 设置账号密码');
  let secure;
  try {
    secure = await step8_setupPasswordAnd2FA(page, { email, password, enable2fa, requestCode, log, recorder });
  } catch (e) {
    const partial = e._secure || {};
    // 2FA 为可选加固：只要密码已设成功，就按「无 2FA 账号」正常返回（照常入号池、标记注册成功），
    // 只有连密码都没设成才算 step8 失败，走异常清单分流。
    const tolerated = resolveStep8Tolerance(partial, Boolean(partial.passwordSet));
    if (tolerated) {
      log(`注册 · 双重验证未完成，密码已设置，按普通账号保存：${e.message}`, 'yellow');
      secure = tolerated;
    } else {
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
  code = String(code == null ? '' : code).replace(/\s+/g, '');
  if (!code) { log('验证码为空，跳过填写', 'warn'); return; }
  log(`填写验证码：${code}`);
  const segmented = page.locator(S.CODE_INPUT_SEGMENTED);
  const segCount = await segmented.count().catch(() => 0);

  // 读回可见分格的拼接值，用于校验填码是否正确（防丢字符/错位）。
  const readSegments = () => page.evaluate((sel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    return [...document.querySelectorAll(sel)].filter(vis).map((e) => e.value || '').join('');
  }, S.CODE_INPUT_SEGMENTED).catch(() => '');

  if (segCount >= code.length) {
    // 分格 OTP：聚焦首格后逐字符键入，交给组件自身 auto-advance 前进焦点（不再逐格 nth(i) 定位，
    // 那样会与组件的自动跳格冲突而错位吞字符，如 901755→90755）；填完读回校验，不符则清空重填。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      for (let i = 0; i < segCount; i += 1) {
        await segmented.nth(i).click({ delay: 20 }).catch(() => {});
        await segmented.nth(i).press('Backspace').catch(() => {});
      }
      await segmented.nth(0).click({ delay: 40 }).catch(() => {});
      for (const ch of code) {
        await page.keyboard.type(ch, { delay: 70 + Math.floor(Math.random() * 70) });
        await sleep(60 + Math.floor(Math.random() * 90));
      }
      const got = await readSegments();
      if (got === code) { log('验证码填写完成'); return; }
      log(`验证码填写不完整，期望 ${code}，实际 ${got}，第 ${attempt}/3 次重试`, 'warn');
    }
    log(`验证码多次填写仍不完整，期望 ${code}，继续提交`, 'warn');
    return;
  }

  const single = await firstVisible(page, S.CODE_INPUT, { timeout: 8000 });
  if (single) {
    await humanType(single, code);
    let got = '';
    try { got = String((await single.inputValue()) || '').replace(/\s+/g, ''); } catch { /* 无 inputValue 能力时跳过校验 */ }
    if (got && got !== code) {
      log(`验证码填写异常，期望 ${code}，实际 ${got}，重新填写`, 'warn');
      await single.fill('').catch(() => {});
      await single.fill(code).catch(() => {});
    }
    log('验证码填写完成');
    return;
  }

  await page.keyboard.type(code, { delay: 80 });
  log('验证码填写完成');
}

// 提交验证码表单：先在框内按 Enter，再点"继续"兜底，最后原生 form.requestSubmit()。
// OpenAI 偶发异常页：提交（密码 / 邮箱验证码 / 2FA 一次性码）后出现「请求超出限制
// rate_limit_exceeded」或「网络异常」，页面带一个「重试」按钮。用稳定属性
// data-dd-action-name="Try again" 定位（class 是 hash 混淆的不可靠），兜底文案「重试/Try again」。
// 限流页：不重试、不阻塞，立即抛错终止本账号任务（其它并发注册不受影响）。
// 网络类异常：点重试，最多 max 次。返回是否点过重试。
async function clickRetryIfError(page, log, { max = 3, cooldownMs = 4000 } = {}) {
  await throwIfRateLimited(page, log);

  let did = false;
  for (let i = 0; i < max; i += 1) {
    const found = await page.evaluate(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const text = document.body?.innerText || '';
      const isErr = /网络.*(异常|错误)|network error|出了点问题|something went wrong|请稍后.*重试|不明なエラー|unknown error|"code":\s*"invalid_type"/i.test(text);
      let btn = document.querySelector('[data-dd-action-name="Try again"]');
      if (!(btn && vis(btn))) {
        btn = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
          .find((b) => /^(重试|再试一次|重新尝试|try again|retry|もう一度試す)$/i.test((b.innerText || '').trim()));
      }
      if (btn && vis(btn) && isErr) { btn.setAttribute('data-reg-retry', '1'); return { isErr: true }; }
      return null;
    }).catch(() => null);
    if (!found) break;
    await throwIfRateLimited(page, log);
    await page.click('[data-reg-retry="1"]', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('[data-reg-retry]')?.removeAttribute('data-reg-retry')).catch(() => {});
    log(`检测到网络异常页，已点击重试，第 ${i + 1}/${max} 次`, 'warn');
    did = true;
    await sleep(cooldownMs);
  }
  return did;
}

// 浏览器层加载错误页判定：chrome-error://…（如 ERR_NETWORK_CHANGED / CONNECTION_RESET /
// TIMED_OUT）、about:neterror。这类页面上 page.evaluate 会直接抛错、DOM 里也没有「重试」按钮，
// 所以 clickRetryIfError 完全兜不住——只能靠 reload 重新加载失败的那次导航。
function isChromeErrorUrl(u) {
  return /^chrome-error:|^chrome:\/\/(error|network-error)|^about:neterror/i.test(String(u || ''));
}

// 若当前停在浏览器加载错误页则刷新（reload 会重试失败的那次导航），最多 max 次。返回是否发生过恢复。
async function recoverFromChromeError(page, log, { max = 3 } = {}) {
  let did = false;
  for (let i = 0; i < max; i += 1) {
    let u = '';
    try { u = page.url(); } catch { u = ''; }
    if (!isChromeErrorUrl(u)) break;
    log(`页面加载失败，正在刷新，第 ${i + 1}/${max} 次`, 'warn');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    did = true;
    await sleep(2500);
  }
  return did;
}

// 当前是否有可见的验证码输入框（单框或分格）。用于错误页刷新后判断是否需要重填。
async function hasVisibleCodeInput(page) {
  return page.evaluate((sel) => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const one = document.querySelector(sel.code);
    const seg = document.querySelectorAll(sel.seg);
    return vis(one) || (seg.length >= 4 && vis(seg[0]));
  }, { code: S.CODE_INPUT, seg: S.CODE_INPUT_SEGMENTED }).catch(() => false);
}

// 提交验证码表单。传入 code 时具备「浏览器错误页」自愈：提交后若落到 chrome-error:// 页，
// 刷新重新加载收码页 → 重填同一个码（刚取的码仍在有效期内，刷新会清空输入所以必须重填）→ 再提交，
// 最多 retries 轮。不传 code 时退化为原行为（仅提交，不自愈）。
async function submitCodeForm(page, log, { code = '', retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await waitForPageFullyLoaded(page, { log });
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
    // 浏览器加载错误页 → 刷新；若仍在收码页且手里有码，重填同码再走一轮提交
    if (attempt < retries && await recoverFromChromeError(page, log)) {
      if (code && await hasVisibleCodeInput(page)) {
        log(`验证码提交后页面异常，刷新后重新填写，第 ${attempt + 1}/${retries} 次`, 'warn');
        await fillCode(page, code, log);
        continue;
      }
    }
    break;
  }
  // 提交后偶发限流/网络异常页 → 点「重试」再确认是否离开收码页
  if (await clickRetryIfError(page, log)) {
    await sleep(1500);
  }
  log('验证码已提交');
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

async function readProfileFields(page) {
  return page.evaluate((nameSel) => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const val = (sel) => {
      const el = document.querySelector(sel);
      return el && vis(el) ? String(el.value || '').trim() : '';
    };
    let name = '';
    for (const sel of nameSel.split(',').map((s) => s.trim()).filter(Boolean)) {
      const el = document.querySelector(sel);
      if (el && vis(el) && String(el.value || '').trim()) {
        name = String(el.value || '').trim();
        break;
      }
    }
    if (!name) {
      name = [val('input[name="firstName"]'), val('input[name="lastName"]')].filter(Boolean).join(' ');
    }
    const hidden = (sel) => String(document.querySelector(sel)?.value || '').trim();
    const age = val('input[name="age"]');
    const birthday = hidden('input[name="birthday"]');
    const ageInvalid = document.querySelector('input[name="age"]')?.getAttribute('aria-invalid') === 'true';
    const birthdayInvalid = document.querySelector('input[name="birthday"]')?.getAttribute('aria-invalid') === 'true';
    const body = document.body?.innerText || '';
    const ageHint = /valid age|有效.*年龄|有効な年齢|enter a valid age/i.test(body);
    return { name, age, birthday, ageInvalid, birthdayInvalid, ageHint };
  }, S.NAME_INPUT).catch(() => ({ name: '', age: '', birthday: '', ageInvalid: false, birthdayInvalid: false, ageHint: false }));
}

async function assertProfileReady(page, log) {
  const f = await readProfileFields(page);
  const hasName = Boolean(f.name);
  const hasAge = Boolean(f.age);
  const hasBirthday = Boolean(f.birthday);
  if (!hasName) throw new Error('资料页姓名未填写');
  if (!hasAge && !hasBirthday) throw new Error('资料页生日/年龄未填写');
  if (f.ageInvalid || f.birthdayInvalid || f.ageHint) {
    throw new Error(`资料页校验未通过：age=${f.age || '(空)'} birthday=${f.birthday || '(空)'}`);
  }
  if (log) log(`资料页就绪：name=${f.name} age=${f.age || '-'} birthday=${f.birthday || '-'}`);
  return f;
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

export const __test = {
  handleLoginTotpPrompt,
  tryLoginMfaEmailFallback,
  isMfaEmailChallenge,
  resolveStep8Tolerance,
  fillCode,
  isChromeErrorUrl,
  recoverFromChromeError,
  submitCodeForm,
  requestCodeWithResend,
  clickResendVerificationCode,
  waitForPageFullyLoaded,
  isLoginPasswordRejected,
  waitForLoginPasswordOutcome,
  isOnCodePage,
  readProfileFields,
  assertProfileReady,
  fillBirthday,
};

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
    if (checked) log(`注册 · 已勾选 ${checked} 项同意条款`);
  } catch { /* ignore */ }
}

async function waitForSuccess(page, log, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      try { log(`当前页面：${new URL(url).pathname}`); } catch { log(`当前页面：${url}`); }
      lastUrl = url;
    }
    const text = await pageText(page);
    if (S.SUCCESS_TEXTS.some((t) => text.includes(t))) {
      log('注册 · 已进入主界面，注册完成');
      return true;
    }
    if (isLoggedInUrl(url)) {
      const t = await readAccessToken(page);
      if (t.accessToken) {
        log('注册 · 登录状态已建立，注册完成');
        return true;
      }
    }
    await sleep(2500);
  }
  log('注册 · 等待完成超时，继续尝试获取登录凭证');
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
  if (!appeared) { log('安全设置 · 打开账号设置'); return; }

  for (let i = 0; i < 4; i += 1) {
    if (!(await detect())) break;
    const hit = await humanClickByText(page, texts, { timeout: 3000, exclude: OAUTH_EXCLUDE }).catch(() => null);
    log(`安全设置 · 关闭欢迎提示，第 ${i + 1} 次`);
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
  log('安全设置 · 打开账号菜单');
  if (!opened) {
    await humanClickByText(page, ['打开个人资料菜单', 'open profile menu', 'user menu', 'profile menu', 'account menu'], { timeout: 6000 }).catch(() => {});
  }
  await sleep(1200);
  const clicked = await humanClickByText(page, ['设置', 'settings'], { timeout: 6000 });
  await sleep(2500);
  // 兜底：账户菜单/设置项点击不稳时，设置弹窗为 hash 路由（chatgpt.com/#settings），直接直达。
  if (!(await settingsDialogOpen(page))) {
    log('安全设置 · 直接进入设置页');
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
    log(`安全设置 · 打开安全选项，第 ${attempt}/${maxRetries} 次尝试`);

    // 打开设置
    await openSettings(page, log);

    // 点击安全tab：优先用稳定 testid（security-tab），失败再退回中文文案。
    // 注意：设置面板新增了“内容安全”(safety-setting-tab)，任何按“安全”做包含匹配都会误点它，
    // 所以文案兜底只用完整词“账户安全与登录”，绝不用裸“安全/security”。
    let secTab = await clickByTestId(page, 'security-tab', { timeout: 6000 });
    if (!secTab) {
      secTab = await humanClickByText(page, ['账户安全与登录', '帐户安全与登录', 'account security & sign in'], { timeout: 6000 }).catch(() => null);
    }
    log('安全设置 · 点击安全选项');
    await sleep(1800);

    // 检测是否真正切换成功
    const ready = await waitForSecurityTabReady(page, { timeout: 20000 });
    if (ready) {
      log(`安全设置 · 已进入安全页面，第 ${attempt} 次尝试成功`);
      return true;
    }

    log(`安全设置 · 安全页面未加载完成，第 ${attempt} 次重试`);

    // 如果不是最后一次尝试，则刷新页面重试
    if (attempt < maxRetries) {
      log('安全设置 · 刷新页面后重试');
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
  log(`安全设置 · 点击关闭双重验证`);
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
      log('安全设置 · 填写验证器验证码以关闭双重验证');
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
    log(`安全设置 · 关闭双重验证，第 ${r + 1} 次尝试，${off ? '已关闭' : '仍开启'}`);
    if (off) return true;
  }
  return false;
}

// 判断当前安全设置页中「账号是否已经有密码」——老号（尤其邮箱已验证/经忘记密码重设登录的）
// 密码往往已存在，这时不该再走「添加密码」流程（会因没有创建密码输入框而失败）。
// 任一信号命中即视为已有密码：
//   1) 密码行呈掩码（密码 ****** / •••• 等 3+ 个掩码字符）；
//   2) 密码所在行的操作按钮是「更改/编辑/管理/更新 change/edit/manage/update」而非「添加/设置/创建」；
//   3) 页面出现「当前密码 / current password」等要求输入现有密码的字样。
async function hasExistingPassword(page) {
  return page.evaluate((p) => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const t = document.body?.innerText || '';
    const MASK = '[\\*•●·∗]{3,}';
    if (new RegExp(p.settingsPasswordMask, 'i').test(t)) return true;
    if (new RegExp(p.settingsPasswordCurrent, 'i').test(t)) return true;
    const rowRe = new RegExp(p.settingsPasswordRow, 'i');
    const manageRe = new RegExp(p.settingsPasswordManageBtn, 'i');
    const addRe = new RegExp(p.settingsPasswordAddBtn, 'i');
    const rows = [...document.querySelectorAll('div,li,section,tr')].filter(vis)
      .map((el) => ({ el, txt: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
      .filter((x) => x.txt && x.txt.length < 140 && rowRe.test(x.txt.slice(0, 24)))
      .sort((a, b) => a.txt.length - b.txt.length);
    for (const { el, txt } of rows) {
      if (new RegExp(MASK).test(txt)) return true;
      const btns = [...el.querySelectorAll('button,a,[role="button"]')].filter(vis)
        .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
      const hasManage = btns.some((b) => manageRe.test(b));
      const hasAdd = btns.some((b) => addRe.test(b));
      if (hasManage && !hasAdd) return true;
    }
    return false;
  }, {
    settingsPasswordMask: S.SETTINGS_PASSWORD_MASK_PATTERN,
    settingsPasswordCurrent: S.SETTINGS_PASSWORD_CURRENT_PATTERN,
    settingsPasswordRow: S.SETTINGS_PASSWORD_ROW_PATTERN,
    settingsPasswordManageBtn: S.SETTINGS_PASSWORD_MANAGE_BTN_PATTERN,
    settingsPasswordAddBtn: S.SETTINGS_PASSWORD_ADD_BTN_PATTERN,
  }).catch(() => false);
}

async function step8_setupPasswordAnd2FA(page, { email, password, enable2fa = true, forceReset2fa = false, existingTotpSecret = '', requestCode, log, recorder = NOOP_RECORDER }) {
  const mark = (id, meta) => recorder.record(id, typeof meta === 'string' ? { note: meta } : meta).catch(() => {});
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

    log('安全设置 · 打开设置并进入安全页面');
    await openSecurityTab(page, log);
    await dumpUi(page, '02-security', log);
    await mark('step8-01-security', '已进入安全tab');

    // —— 设密码 ——（幂等：已设过则跳过。老号登录后密码常已存在，用鲁棒检测识别，命中即不走添加流程）
    const pwAlready = await hasExistingPassword(page);
    if (pwAlready) {
      log('安全设置 · 账号已有密码，跳过设置');
      out.passwordSet = true;
    } else {
      log('安全设置 · 点击添加密码');
      let pwEntry = await clickMarked(page, findRowButton, { kw: S.SETTINGS_PASSWORD_ROW_PATTERN, btns: ['添加', 'add', 'set', '设置', 'create', '创建', '追加'] });
      if (!pwEntry) pwEntry = await humanClickByText(page, ['设置密码', '创建密码', 'set password', 'create password', 'パスワードを設定', 'パスワードを作成'], { timeout: 3000 }).catch(() => null);
      log('安全设置 · 点击密码设置入口');
      await sleep(2500);
      await dumpUi(page, '03-password-entry', log);

      // 设密码前 OpenAI 常要求先邮箱验证（跳 auth.openai.com 收码页）
      for (let r = 1; r <= 3; r += 1) {
        if (!(await isOnCodePage(page))) break;
        log(`安全设置 · 设置密码前需验证邮箱，第 ${r} 次`);
        if (r > 1) await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend'], { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => {});
        const vcode = await requestCodeWithResend(page, requestCode, log, { purpose: 'password' });
        await fillCode(page, vcode, log);
        await submitCodeForm(page, log, { code: vcode });
        await sleep(3500);
        await dumpUi(page, `03b-after-verify-${r}`, log);
      }

      const pwdInput = await firstVisible(page, 'input[type="password"], input[autocomplete="new-password"]', { timeout: 8000 });
      if (pwdInput) {
        const all = page.locator('input[type="password"]');
        const n = await all.count();
        log(`安全设置 · 填写密码：${password}`);
        await humanType(all.nth(0), password);
        if (n > 1) await humanType(all.nth(1), password);
        await humanClickByText(page, ['保存', '设置密码', '设置', '确认', '继续', '更新', 'save', 'set password', 'set', 'confirm', 'continue', 'update'], { timeout: 6000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
        await sleep(2500);
        await clickRetryIfError(page, log); // 设密码提交后偶发限流/网络异常页 → 点重试
        await dumpUi(page, '04-password-submitted', log);
        // 提交后可能还有一次邮箱验证
        const codeBox = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 4000 });
        if (codeBox) {
          log('安全设置 · 设置密码后需验证邮箱');
          const code = await requestCodeWithResend(page, requestCode, log, { purpose: 'password' });
          await fillCode(page, code, log);
          await submitCodeForm(page, log, { code });
          await sleep(2500);
        }
        out.passwordSet = true;
        out.passwordChanged = true; // 确实新设了密码 → 上层应存这个新密码
        log('安全设置 · 密码已保存');
        await mark('step8-02-password-set', '密码已设置');
      } else {
        // 没找到「创建密码」输入框：老号登录后密码往往已存在——先复判是不是账号本就有密码，
        // 是则视为已设、跳过（避免把「已有密码」误报成「设密码失败」）。
        const already = await hasExistingPassword(page);
        if (already) {
          log('安全设置 · 账号已有密码，沿用原密码');
          out.passwordSet = true;
          // passwordChanged 保持 false：本次没有新设密码，上层应沿用登录用的原密码
        } else {
          // 确非已有密码 → 留一行现场（不依赖 REG_DIAG_DIR）便于定位页面结构变化，再报错。
          const scene = await page.evaluate(() => {
            const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
            return {
              url: location.href,
              inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({ t: i.type, n: i.name, ph: i.placeholder })).slice(0, 12),
            };
          }).catch(() => ({}));
          log(`安全设置 · 设置密码失败，当前页面异常`, 'error');
          throw new Error('设密码失败：未找到密码输入框，请检查邮箱验证或页面结构变化');
        }
      }
    }

    // 2FA 关闭：只设密码即可返回
    if (!enable2fa) {
      log('安全设置 · 未配置开启双重验证，跳过');
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
      log('安全设置 · 继续在当前页面开启双重验证');
    } else {
      log('安全设置 · 重新打开设置，准备开启双重验证');
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
        log('安全设置 · 双重验证已开启，跳过');
        out.twoFactorSet = true;
        return out;
      }
      log('安全设置 · 先关闭已有的双重验证');
      const disabled = await disable2fa(page, existingTotpSecret, log);
      if (!disabled) throw new Error('强制重设2FA失败：无法停用已有的验证器（可能缺少旧 secret 或停用流程变更）');
      await sleep(1500);
      await dumpUi(page, '04c-2fa-disabled', log);
    }

    log('安全设置 · 开启双重验证');
    let twofaToggle = await clickMarked(page, findRowSwitch, { kw: 'authenticator|验证器应用|身份验证器' });
    if (!twofaToggle) twofaToggle = await humanClickByText(page, ['authenticator app', 'authenticator', '身份验证器', '验证器应用', '设置', 'set up'], { timeout: 4000 }).catch(() => null);
    log('安全设置 · 点击双重验证开关');
    await sleep(2500);
    await dumpUi(page, '05-2fa-entry', log);

    for (let r = 1; r <= 2; r += 1) {
      if (!(await isOnCodePage(page))) break;
      log(`安全设置 · 开启双重验证前需验证邮箱，第 ${r} 次`);
      if (r > 1) await humanClickByText(page, ['重新发送电子邮件', '重新发送', 'resend'], { timeout: 5000, exclude: OAUTH_EXCLUDE }).catch(() => {});
      const vc = await requestCodeWithResend(page, requestCode, log, { purpose: '2fa' });
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
    log(`安全设置 · 已获取双重验证密钥：${secretInfo.key || secretInfo.uri || '未获取'}`);
    const secret = secretInfo.key || secretInfo.uri;
    if (!secret) throw new Error('开2FA失败：未提取到 TOTP secret（仅二维码/入口异常）');

    out.twoFactorSecret = secretInfo.key || '';
    out.twoFactorUri = secretInfo.uri || '';
    const code = generateTotpNow(secret);
    log(`安全设置 · 填写验证器验证码：${code}`);
    const codeBox = await firstVisible(page, `${S.CODE_INPUT}, ${S.CODE_INPUT_SEGMENTED}`, { timeout: 6000 });
    if (!codeBox) throw new Error('开2FA失败：未找到 TOTP 确认输入框');
    await fillCode(page, code, log);
    await humanClickByText(page, ['继续', 'confirm', 'verify', '确认', '验证', '启用', 'enable', '下一步', 'next'], { timeout: 5000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log });
    await sleep(2500);
    await clickRetryIfError(page, log); // 2FA 确认提交后偶发限流/网络异常页 → 点重试
    await dumpUi(page, '06-2fa-confirmed', log);
    const recovery = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const codes = t.match(/\b[a-z0-9]{4,5}-[a-z0-9]{4,5}\b/gi) || t.match(/\b[A-Z0-9]{8,12}\b/g) || [];
      return [...new Set(codes)].slice(0, 12);
    }).catch(() => []);
    out.recoveryCodes = recovery;
    await humanClickByText(page, ['完成', '继续', '我已保存', 'done', 'continue', 'i saved', 'close'], { timeout: 4000, exclude: OAUTH_EXCLUDE, awaitPageLoad: true, log }).catch(() => {});
    out.twoFactorSet = true;
    log(`安全设置 · 双重验证已开启${recovery.length ? `，恢复码：${recovery.join(', ')}` : ''}`);
    await mark('step8-03-2fa-set', `2FA 已开启（恢复码 ${recovery.length} 个）`);
  } catch (e) {
    log(`安全设置失败：${e.message}`, 'error');
    await snapshot(page, 's8-error', log).catch(() => {});
    await mark('step8-error', `step8 失败：${e.message}`);
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
