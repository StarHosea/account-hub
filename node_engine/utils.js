// 随机资料 / 密码 生成工具 + TOTP（移植自 browserregister src/utils.js，去掉 IpWeb 会话串生成）。
import * as OTPAuth from 'otpauth';

const FIRST_NAMES = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda',
  'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa',
  'Anthony', 'Betty', 'Mark', 'Sandra', 'Donald', 'Ashley', 'Steven', 'Emily',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateRandomName() {
  return { firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES) };
}

// 20~30 岁之间的随机生日（避免太小/太老）。
export function generateRandomBirthday() {
  const now = new Date();
  const age = 20 + Math.floor(Math.random() * 11); // 20..30
  const year = now.getFullYear() - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = 1 + Math.floor(Math.random() * daysInMonth);
  return { year, month, day };
}

// 生成符合 ChatGPT 要求（>=8 位，含大小写+数字+符号）的强密码。
export function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const sym = '!@#$%^&*-_';
  const all = upper + lower + digit + sym;
  const req = [pick2(upper), pick2(lower), pick2(digit), pick2(sym)];
  let out = req.join('');
  for (let i = out.length; i < 16; i += 1) out += pick2(all);
  return shuffle(out.split('')).join('');
}

function pick2(s) {
  return s[Math.floor(Math.random() * s.length)];
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- TOTP（2FA 验证器） ----------------

// 规范化用户从页面抓到的 secret：去空格、大写（base32）。
export function normalizeTotpSecret(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

// 从 otpauth:// URI 或裸 base32 secret 构造 TOTP 实例。
function buildTotp(secretOrUri, { issuer = 'OpenAI', label = 'ChatGPT' } = {}) {
  const s = String(secretOrUri || '').trim();
  if (/^otpauth:\/\//i.test(s)) {
    return OTPAuth.URI.parse(s);
  }
  return new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(normalizeTotpSecret(s)),
  });
}

// 根据 secret（base32 或 otpauth uri）生成当前 6 位 TOTP 码。
export function generateTotpNow(secretOrUri, opts = {}) {
  return buildTotp(secretOrUri, opts).generate();
}
