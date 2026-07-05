// ChatGPT/OpenAI 注册页选择器，移植自 browserregister（原 FlowPilot flows/openai/content/openai-auth.js）。
// 这些选择器覆盖多语言（en/zh/ja）与 react-aria 结构。

export const EMAIL_INPUT = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id*="email"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="邮箱"]',
  'input[placeholder*="メール"]',
  'input[aria-label*="email" i]',
].join(', ');

export const PASSWORD_INPUT = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="current-password"]',
  'input[id*="password" i]',
  'input[placeholder*="password" i]',
  'input[placeholder*="密码"]',
].join(', ');

export const CODE_INPUT = [
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
].join(', ');

// 分格验证码输入（每格 maxlength=1）
export const CODE_INPUT_SEGMENTED = 'input[maxlength="1"]';

export const NAME_INPUT = [
  'input[name="name"]',
  'input[autocomplete="name"]',
  'input[placeholder*="name" i]',
  'input[placeholder*="姓名"]',
  'input[aria-label*="name" i]',
].join(', ');

export const FIRST_NAME_INPUT = [
  'input[name="firstName"]',
  'input[name="given-name"]',
  'input[autocomplete="given-name"]',
  'input[placeholder*="first" i]',
].join(', ');

export const LAST_NAME_INPUT = [
  'input[name="lastName"]',
  'input[name="family-name"]',
  'input[autocomplete="family-name"]',
  'input[placeholder*="last" i]',
].join(', ');

export const BIRTHDAY_INPUT = [
  'input[name="birthday"]',
  'input[name="bday"]',
  'input[type="date"]',
  'input[placeholder*="birth" i]',
  'input[placeholder*="生日"]',
  'input[placeholder*="出生"]',
].join(', ');

// "继续/下一步/创建账号"等主行动按钮的文案（多语言）
export const CONTINUE_TEXTS = [
  'continue', 'next', 'sign up', 'create account', 'agree', 'submit',
  '继续', '下一步', '注册', '创建账号', '同意', '提交',
  '続ける', '次へ', '登録', '同意',
];

// 出现这些文案代表注册基本成功（进入 chatgpt 主界面）
export const SUCCESS_TEXTS = [
  'How can I help', 'What can I help', 'Message ChatGPT', 'New chat',
  '有什么可以帮', '给 ChatGPT', '新聊天',
];

// 各类错误文案 → 见 code-errors.js（验证码错误文案来自 auth.openai.com 真实 i18n，含 en/zh/ja）
export const EMAIL_EXISTS_PATTERN = /already\s+exists|already\s+in\s+use|已存在|既に.*存在/i;
export { INVALID_CODE_PATTERN, detectInvalidCode, hasInvalidCodeError, textIndicatesInvalidCode } from './code-errors.js';

// chatgpt.com 首页登录/注册入口（比文案点击稳定）
export const SIGNUP_BUTTON_TESTID = 'signup-button';
export const LOGIN_BUTTON_TESTID = 'login-button';
// 未登录时右侧内嵌「注册或登录」面板（无中央 signup 按钮的 A/B 布局）
export const NO_AUTH_RIGHT_LOGIN_PANEL_TESTID = 'no-auth-right-login-panel';

// 登录密码页：邮箱或密码错误（出现即应转忘记密码，勿再重试提交）
export const WRONG_LOGIN_PASSWORD_PATTERN = /incorrect\s+email\s+address\s+or\s+password|email.*or\s+password.*incorrect|密码.*(不正确|错误|无效)|邮箱.*密码.*(不正确|错误)|incorrect.*password|invalid password|wrong password/i;
