// ============================================================================
// 账号认证状态探测层（阶段 1 状态机）
// ----------------------------------------------------------------------------
// 把原先散落在 register.js 各处的隐式页面/账号判断（waitForPostEmailLanding /
// detectPostCodeBranch / looksLikeLogin / isOnCodePage / handleLoginTotpPrompt 的
// MFA 判定 / hasExistingPassword / twofaAlready 等）收敛到一处统一探测。
//
// 设计约定（与前期讨论一致）：
//   1) 两个维度：pageState（浏览器现在在哪，互斥）+ accountFacts（账号有没有
//      密码/2FA，只有进设置页才有值，其余为 null）。
//   2) 探测器只报「置信度」，不下最终结论；由编排器（waitForAuthState）带预算
//      轮询，直到置信或超时保守回退——沿用 detectPostCodeBranch 的教训。
//   3) 纯逻辑（classifyState）与抓 DOM（collectSignals）分离：classifyState 是
//      纯函数，喂 signals 即可单测，无需 mock 浏览器。
//   4) 只读快照，绝不做动作、绝不 fetch（无副作用、快）；token 真伪仍由
//      register.js 的 readAccessToken 负责，这里只按 URL/文案给 tokenLikely 提示。
// ============================================================================

import * as S from './selectors.js';
import { INVALID_CODE_PATTERN } from './code-errors.js';

// —— 页面状态（互斥）——
export const PAGE_STATE = Object.freeze({
  UNKNOWN: 'unknown',                        // 存疑/过渡中（编排器应继续轮询）
  NEW_EMAIL_ENTRY: 'new_email_entry',        // 官网/邮箱输入页
  NEW_NEEDS_PASSWORD: 'new_needs_password',  // 注册「创建密码」页
  NEW_NEEDS_PROFILE: 'new_needs_profile',    // 注册「资料（姓名/生日）」页
  EXISTING_PASSWORD_LOGIN: 'existing_password_login', // 已注册账号「登录密码」页
  EMAIL_CODE: 'email_code',                  // 邮箱验证码页
  MFA_TOTP: 'mfa_required_totp',             // 2FA 验证器（TOTP）页
  MFA_EMAIL: 'mfa_required_email',           // 2FA 改用邮箱验证码兜底页
  RESET_PASSWORD: 'reset_password',          // 忘记密码/重置页
  SETTINGS_SECURITY: 'settings_security',    // 设置-账户安全与登录 tab
  LOGGED_IN: 'logged_in',                    // 已登录主界面
});

export const CONFIDENCE = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

function safeUrl(page) {
  try { return page.url(); } catch { return ''; }
}

// 已登录 URL 判定（与 register.js isLoggedInUrl 等价，独立一份避免耦合）。
export function isLoggedInUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (!/(^|\.)chatgpt\.com$/i.test(u.hostname)) return false;
    if (/\/auth\/|\/create-account\/|\/email-verification|\/log-in|\/add-phone/i.test(u.pathname)) return false;
    return true;
  } catch { return false; }
}

// —— 抓 DOM 原始信号（薄层，真机执行；测试用 classifyState 直接喂 signals）——
export async function collectSignals(page) {
  const url = safeUrl(page);
  let dom = {};
  try {
    dom = await page.evaluate((sel) => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const anyVis = (q) => { try { return [...document.querySelectorAll(q)].some(vis); } catch { return false; } };
      const q1 = (q) => { try { return document.querySelector(q); } catch { return null; } };
      const text = document.body?.innerText || '';
      const segEls = (() => { try { return [...document.querySelectorAll(sel.seg)]; } catch { return []; } })();

      // 账号事实：是否已有密码（掩码 / 「当前密码」文案 / 「更改」而非「添加」按钮）
      const MASK = '[\\*•●·∗]{3,}';
      let passwordSet = null;
      let mfaEnabled = null;
      const hasSecurityTab = !!q1('[data-testid="security-tab"]');
      const inSettings = /#settings/i.test(location.hash)
        || /account security|账户安全与登录|帐户安全与登录/i.test(text);
      const hasAuthRow = [...document.querySelectorAll('div,li,section')].some(
        (el) => vis(el) && /authenticator|验证器应用|身份验证器/i.test(el.innerText || '') && (el.innerText || '').length < 200,
      );
      const onSecurity = (hasSecurityTab || inSettings) && (hasAuthRow || /设置密码|create password|多重验证|multi-factor|two-factor/i.test(text));
      if (onSecurity) {
        // 密码是否已设
        if (new RegExp('(密码|password)\\s*' + MASK, 'i').test(text)
            || /当前密码|现有密码|current password|enter your (current|existing) password/i.test(text)) {
          passwordSet = true;
        } else {
          const rows = [...document.querySelectorAll('div,li,section,tr')].filter(vis)
            .map((el) => ({ el, txt: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
            .filter((x) => x.txt && x.txt.length < 140 && /密码|password/i.test(x.txt.slice(0, 24)))
            .sort((a, b) => a.txt.length - b.txt.length);
          for (const { el, txt } of rows) {
            if (new RegExp(MASK).test(txt)) { passwordSet = true; break; }
            const btns = [...el.querySelectorAll('button,a,[role="button"]')].filter(vis)
              .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
            const hasManage = btns.some((b) => /更改|编辑|管理|更新|change|edit|manage|update/.test(b));
            const hasAdd = btns.some((b) => /添加|设置|创建|^add$|^set|^create/.test(b));
            if (hasManage && !hasAdd) { passwordSet = true; break; }
            if (hasAdd && !hasManage) { passwordSet = false; }
          }
          if (passwordSet === null && /设置密码|创建密码|create password|set password/i.test(text)) passwordSet = false;
        }
        // 2FA 是否已启用（authenticator 行开关）
        if (/验证器应用已启用|authenticator app enabled/i.test(text)) {
          mfaEnabled = true;
        } else {
          const rows = [...document.querySelectorAll('div,li,section')].filter(vis)
            .filter((el) => /authenticator/i.test(el.innerText || '') && (el.innerText || '').length < 120)
            .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
          for (const row of rows) {
            const sw = [...row.querySelectorAll('[role="switch"],input[type="checkbox"]')].filter(vis)[0];
            if (sw) { mfaEnabled = sw.getAttribute('aria-checked') === 'true' || sw.checked === true; break; }
          }
        }
      }

      return {
        hasEmail: anyVis(sel.email),
        hasPassword: anyVis(sel.pwd),
        passwordCount: (() => { try { return document.querySelectorAll('input[type="password"]').length; } catch { return 0; } })(),
        hasCode: vis(q1(sel.code)) || (segEls.length >= 4 && vis(segEls[0])),
        hasTotp: vis(q1('#totp_otp, input[name="totp_otp"]')),
        hasProfile: anyVis(sel.profile),
        hasInput: anyVis('input'),
        onSecurity,
        passwordSet,
        mfaEnabled,
        // 文案标志
        emailExists: /already\s+exists|already\s+in\s+use|已存在|既に.*存在/i.test(text),
        invalidCode: (() => {
          const re = new RegExp(sel.invalidCodePattern, 'i');
          if (re.test(text)) return true;
          const codeInput = document.querySelector(sel.code);
          if (codeInput?.getAttribute('aria-invalid') === 'true') return true;
          return false;
        })(),
        forgotOrWelcomeBack: /忘记了密码|忘记密码|forgot password|欢迎回来|welcome back/i.test(text),
        checkInbox: /检查你的收件箱|输入.*验证码|check your inbox|enter the code|verification code/i.test(text),
        mfaAuthenticator: /验证器应用|输入验证器|authenticator|two-factor|双重验证|验证你的身份|一次性验证码|一次性密码/i.test(text),
        mfaEmailHint: /检查你的收件箱|查看你的邮箱|邮件已发送|邮箱验证码|电子邮件.*验证码|check your inbox|sent.*email|email.*code|verification code/i.test(text),
        welcomeOverlay: /你已准备就绪|准备就绪|欢迎使用|请勿分享敏感信息|may (make mistakes|be reviewed)/i.test(text),
        success: (sel.successTexts || []).some((t) => text.includes(t)),
        textLen: text.length,
      };
    }, {
      email: S.EMAIL_INPUT,
      pwd: S.PASSWORD_INPUT,
      code: S.CODE_INPUT,
      seg: S.CODE_INPUT_SEGMENTED,
      profile: `${S.NAME_INPUT}, ${S.FIRST_NAME_INPUT}, ${S.LAST_NAME_INPUT}, ${S.BIRTHDAY_INPUT}`,
      successTexts: S.SUCCESS_TEXTS,
      invalidCodePattern: INVALID_CODE_PATTERN.source,
    });
  } catch (e) {
    dom = { evalError: String(e && e.message || e) };
  }
  return { url, ...dom };
}

// —— 纯逻辑：signals → 状态判定（可单测，无浏览器依赖）——
// 判据从最确定（URL path / 专属输入框）到最模糊（仅文案）分层，命中即定并给出置信度。
export function classifyState(signals = {}) {
  const s = signals || {};
  const url = String(s.url || '');
  const evidence = {
    url,
    tokenLikely: isLoggedInUrl(url),
    signals: pickSignals(s),
  };
  const accountFacts = {
    passwordSet: s.onSecurity ? (s.passwordSet ?? null) : null,
    mfaEnabled: s.onSecurity ? (s.mfaEnabled ?? null) : null,
  };
  const make = (pageState, confidence, reason) => ({ pageState, accountFacts, confidence, evidence, reason });

  // eval 失败 / 页面还没内容 → UNKNOWN（编排器继续轮询）
  if (s.evalError) return make(PAGE_STATE.UNKNOWN, CONFIDENCE.LOW, `DOM 读取失败：${s.evalError}`);

  // 1) 2FA 验证器页（URL path 最确定）；但若已切到邮箱验证码模式（出现邮箱提示）则不算 TOTP
  if (s.hasTotp || (/\/mfa-challenge\//i.test(url) && !s.mfaEmailHint)) {
    return make(PAGE_STATE.MFA_TOTP, CONFIDENCE.HIGH, 'mfa-challenge/totp_otp 命中');
  }
  // 2) 2FA 改用邮箱验证码兜底页（有码输入 + 邮箱提示 + 非 totp）
  if (s.mfaEmailHint && s.hasCode && (s.mfaAuthenticator || /\/mfa-challenge\//i.test(url)) && !s.hasTotp) {
    return make(PAGE_STATE.MFA_EMAIL, CONFIDENCE.MEDIUM, '2FA 邮箱验证码兜底页');
  }
  // 3) 忘记密码/重置页
  if (/\/reset-password/i.test(url)) {
    return make(PAGE_STATE.RESET_PASSWORD, CONFIDENCE.HIGH, 'reset-password URL');
  }
  // 4) 邮箱验证码页
  if (/\/email-verification(?:[/?#]|$)/i.test(url) || (s.hasCode && s.checkInbox)) {
    const conf = /\/email-verification/i.test(url) ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;
    return make(PAGE_STATE.EMAIL_CODE, conf, '验证码输入页');
  }
  // 5) 已注册账号「登录密码」页（URL /log-in/password 或 密码框 + 忘记密码/欢迎回来 文案）
  if (/\/log-in\/password/i.test(url) || (s.hasPassword && (s.forgotOrWelcomeBack || /\/log-in(\/|$|\?|#)/i.test(url)))) {
    return make(PAGE_STATE.EXISTING_PASSWORD_LOGIN, CONFIDENCE.HIGH, '登录密码页');
  }
  // 6) 设置-安全 tab（此时 accountFacts 才有意义）
  if (s.onSecurity) {
    return make(PAGE_STATE.SETTINGS_SECURITY, CONFIDENCE.HIGH, '设置-账户安全与登录');
  }
  // 7) 注册资料页（姓名/生日）
  if (s.hasProfile) {
    return make(PAGE_STATE.NEW_NEEDS_PROFILE, CONFIDENCE.HIGH, '资料页（姓名/生日）');
  }
  // 8) 注册创建密码页（密码框 + 注册相关 URL，且非登录页——上面第 5 步已排除登录）
  if (s.hasPassword && /\/create-account|create-password|sign-?up|auth\.openai\.com/i.test(url)) {
    return make(PAGE_STATE.NEW_NEEDS_PASSWORD, CONFIDENCE.MEDIUM, '创建密码页');
  }
  if (s.hasPassword) {
    return make(PAGE_STATE.NEW_NEEDS_PASSWORD, CONFIDENCE.LOW, '出现密码框（未定新老，保守按创建密码）');
  }
  // 9) 已登录主界面
  if (isLoggedInUrl(url)) {
    if (s.success) return make(PAGE_STATE.LOGGED_IN, CONFIDENCE.HIGH, '已登录 URL + 主界面文案');
    return make(PAGE_STATE.LOGGED_IN, CONFIDENCE.MEDIUM, '已登录 URL（未见主界面文案）');
  }
  // 10) 邮箱输入入口
  if (s.hasEmail) {
    return make(PAGE_STATE.NEW_EMAIL_ENTRY, CONFIDENCE.MEDIUM, '邮箱输入页');
  }
  // 兜底
  return make(PAGE_STATE.UNKNOWN, CONFIDENCE.LOW, '无明确信号，存疑');
}

function pickSignals(s) {
  const keys = [
    'hasEmail', 'hasPassword', 'passwordCount', 'hasCode', 'hasTotp', 'hasProfile',
    'onSecurity', 'passwordSet', 'mfaEnabled', 'emailExists', 'invalidCode',
    'forgotOrWelcomeBack', 'checkInbox', 'mfaAuthenticator', 'mfaEmailHint', 'success',
  ];
  const out = {};
  for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

// —— 一次快照探测：collectSignals + classifyState ——
export async function detectAuthState(page) {
  const signals = await collectSignals(page);
  return classifyState(signals);
}

// —— 编排器：带预算轮询直到 predicate(state) 为真或超时，返回最后一次 state（保守）——
// predicate 可传 pageState 字符串、字符串数组，或 (state)=>bool 函数。
export async function waitForAuthState(page, predicate, { timeoutMs = 30000, poll = 1200, minConfidence = CONFIDENCE.MEDIUM, log } = {}) {
  const wanted = normalizePredicate(predicate);
  const rank = { low: 0, medium: 1, high: 2 };
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline) {
    const state = await detectAuthState(page);
    last = state;
    const confident = rank[state.confidence] >= rank[minConfidence];
    if (confident && wanted(state)) {
      if (log) log(`[状态机] 命中 ${state.pageState}（${state.confidence}）：${state.reason}`);
      return state;
    }
    await sleep(poll);
  }
  if (log && last) log(`[状态机] 等待超时，最后状态 ${last.pageState}（${last.confidence}）：${last.reason}`);
  return last || classifyState({});
}

function normalizePredicate(predicate) {
  if (typeof predicate === 'function') return predicate;
  const set = new Set(Array.isArray(predicate) ? predicate : [predicate]);
  return (state) => set.has(state.pageState);
}

export const __test = { classifyState, isLoggedInUrl, normalizePredicate, PAGE_STATE, CONFIDENCE };
