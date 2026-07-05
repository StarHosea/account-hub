/**
 * 邮箱/2FA 验证码错误检测。
 *
 * 文案来源（2026-07-05 实测，非臆造）：
 * - EN defaultMessage：`data/http-cache/17/...`（auth i18n catalog）、`emailVerification.shared-C46HrMJE.js`
 * - zh-CN：`auth-cdn.oaistatic.com/assets/zh-CN-CHax8Gwu.js`（与本地 http-cache/9e/... 一致）
 * - ja-JP：`auth-cdn.oaistatic.com/assets/ja-JP-DQpKMzll.js`（stealth 浏览器拉取）
 *
 * OpenAI 在 /api/accounts/email-otp/validate 返回 401 时，把 `emailVerification.incorrectCode` 写到 code 字段错误；
 * MFA / wrongEmailOtp 等场景用 `authErrors.*` / `mfaChallenge.incorrectCode` 等 key。
 */

/** 与 selectors.CODE_INPUT 一致，内联避免 selectors ↔ code-errors 循环依赖。 */
const CODE_FIELD_SELECTOR = [
  'input[name="code"]',
  'input[name="otp"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][maxlength="6"]',
  'input[type="tel"][maxlength="6"]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[placeholder*="验证码"]',
  'input[placeholder*="コード"]',
  'input[aria-label*="验证码"]',
  'input[inputmode="numeric"]',
  '#totp_otp',
  'input[name="totp_otp"]',
].join(', ');

/** @type {readonly {text: string, source: string}[]} */
export const VERIFIED_INVALID_CODE_MESSAGES = [
  // English
  { text: 'Incorrect code', source: 'emailVerification.incorrectCode / authErrors.* (en default)' },
  { text: 'Invalid OTP code. Please try again.', source: 'authErrors.invalidInput.subtitle (en default)' },
  // 简体中文
  { text: '代码不正确', source: 'emailVerification.incorrectCode (zh-CN)' },
  { text: '代码有误', source: 'authErrors.incorrectCode.subtitle (zh-CN)' },
  { text: '验证码错误', source: 'authErrors.wrongEmailOtpCode.subtitle / phoneVerification.incorrectCode (zh-CN)' },
  { text: 'OTP 验证码无效。请重试。', source: 'authErrors.invalidInput.subtitle (zh-CN)' },
  { text: '验证码不正确。请重试。', source: 'mfaChallenge.incorrectCode (zh-CN)' },
  // 日本語
  { text: '不正確なコード', source: 'emailVerification.incorrectCode (ja-JP)' },
  { text: 'コードが正しくありません', source: 'authErrors.wrongEmailOtpCode.subtitle (ja-JP)' },
  { text: 'コードが正しくありません。もう一度お試しください。', source: 'mfaChallenge.incorrectCode (ja-JP)' },
  { text: 'OTP コードが無効です。もう一度お試しください。', source: 'authErrors.invalidInput.subtitle (ja-JP)' },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const INVALID_CODE_PATTERN = new RegExp(
  VERIFIED_INVALID_CODE_MESSAGES.map(({ text }) => escapeRegExp(text)).join('|'),
  'i',
);
/**
 * 检测页面上是否出现「验证码错误」。
 * 1) body 文案命中已核实 i18n 片段；
 * 2) 验证码输入框 aria-invalid=true（与语言无关）；
 * 3) role=alert / aria-live 区域命中已核实文案。
 */
export async function detectInvalidCode(page) {
  const patternSrc = INVALID_CODE_PATTERN.source;
  return page.evaluate(({ patternSrc, codeSel }) => {
    const re = new RegExp(patternSrc, 'i');
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const body = document.body?.innerText || '';
    if (re.test(body)) return true;
    for (const el of document.querySelectorAll(codeSel)) {
      if (vis(el) && el.getAttribute('aria-invalid') === 'true') return true;
    }
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')) {
      if (!vis(el)) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (t && re.test(t)) return true;
    }
    return false;
  }, { patternSrc, codeSel: CODE_FIELD_SELECTOR });
}

/** 与 detectInvalidCode 相同；保留旧命名便于 auth-state / register 调用。 */
export async function hasInvalidCodeError(page) {
  return detectInvalidCode(page);
}

export function textIndicatesInvalidCode(text) {
  return INVALID_CODE_PATTERN.test(String(text || ''));
}
