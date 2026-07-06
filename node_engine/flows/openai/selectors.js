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
  'input[aria-label*="メール"]',
].join(', ');

export const PASSWORD_INPUT = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="current-password"]',
  'input[id*="password" i]',
  'input[placeholder*="password" i]',
  'input[placeholder*="密码"]',
  'input[placeholder*="パスワード"]',
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
  'input[aria-label*="コード"]',
].join(', ');

// 分格验证码输入（每格 maxlength=1）
export const CODE_INPUT_SEGMENTED = 'input[maxlength="1"]';

export const NAME_INPUT = [
  'input[name="name"]',
  'input[autocomplete="name"]',
  'input[placeholder*="name" i]',
  'input[placeholder*="姓名"]',
  'input[placeholder*="氏名"]',
  'input[aria-label*="name" i]',
  'input[aria-label*="氏名"]',
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
  '続ける', '続行', '次へ', '登録', '同意', 'サインアップ',
];

// 资料页「完成账户创建」主按钮（en/zh/ja；与 CONTINUE_TEXTS 分离避免误点中间态「继续」）
export const PROFILE_SUBMIT_TEXTS = [
  '完成账户创建', '完成帐户创建', '创建账号', '创建帐户', '创建账户',
  'create account', 'finish', 'done', "i'm 18",
  'アカウントの作成を完了する', 'アカウント', '作成を完了', '登録を完了',
];

// 出现这些文案代表注册基本成功（进入 chatgpt 主界面）
export const SUCCESS_TEXTS = [
  'How can I help', 'What can I help', 'Message ChatGPT', 'New chat',
  '有什么可以帮', '给 ChatGPT', '新聊天',
  'どこから始めますか', '新しいチャット',
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
export const WRONG_LOGIN_PASSWORD_PATTERN = /incorrect\s+email\s+address\s+or\s+password|email.*or\s+password.*incorrect|密码.*(不正确|错误|无效)|邮箱.*密码.*(不正确|错误)|incorrect.*password|invalid password|wrong password|メールアドレス.*パスワード.*(正しくありません|間違)|パスワード.*(正しくありません|間違)/i;

// 忘记密码 / 重置流程（en/zh/ja）
export const FORGOT_PASSWORD_PATTERN = /忘记了密码|忘记密码|forgot|お忘れ|パスワードをお忘れ/i;
export const RESET_CONTINUE_PATTERN = /继续|continue|发送|send|続行|続ける|送信/i;
export const RESET_SAVE_PATTERN = /继续|保存|重置|确认|continue|save|reset|confirm|続行|保存|リセット|確認/i;
export const RESET_SUCCESS_PATTERN = /重置.*成功|密码.*(已|修改|重置).*成功|password.*(reset|changed|updated)|パスワード.*(変更|更新|リセット).*成功/i;
export const NEW_PASSWORD_PAGE_PATTERN = /新密码|设置密码|重新输入.*密码|create.*password|new password|新しいパスワード|パスワードを(設定|再入力)/i;

// 安全设置页：密码是否已设置（en/zh/ja；供 auth-state / step8 hasExistingPassword 共用）
export const SETTINGS_PASSWORD_LABEL = '密码|password|パスワード';
export const SETTINGS_PASSWORD_MASK_PATTERN = `(?:${SETTINGS_PASSWORD_LABEL})\\s*[\\*•●·∗]{3,}`;
export const SETTINGS_PASSWORD_ROW_PATTERN = SETTINGS_PASSWORD_LABEL;
export const SETTINGS_PASSWORD_CURRENT_PATTERN = '当前密码|现有密码|current password|enter your (current|existing) password';
export const SETTINGS_PASSWORD_MANAGE_BTN_PATTERN = '更改|编辑|管理|更新|編集|change|edit|manage|update';
export const SETTINGS_PASSWORD_ADD_BTN_PATTERN = '添加|设置|创建|追加|^add$|^set|^create';
export const SETTINGS_PASSWORD_UNSET_PATTERN = '设置密码|创建密码|create password|set password|パスワードを(設定|作成)';
export const SETTINGS_IN_SECURITY_PATTERN = 'account security|账户安全与登录|帐户安全与登录|セキュリティとログイン|セキュリティ';
export const SETTINGS_ON_SECURITY_HINT_PATTERN = '设置密码|create password|多重验证|multi-factor|two-factor|パスワード|二要素|セキュリティ';

export const LOGIN_LINK_PATTERN = /^登录$|登 ?录|log ?in|sign ?in|ログイン/i;
export const LOGIN_OTP_TEXTS = [
  '改用验证码', '使用验证码', '通过电子邮件', 'email a code', 'send code', '发送验证码', 'use a code', 'verification code',
  'メールで確認', 'メールで続行', 'コードを使用', 'メールにコードを送信', 'メール', 'Eメール',
];
