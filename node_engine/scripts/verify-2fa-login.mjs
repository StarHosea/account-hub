// 验证 2FA 确实设上：用 密码 + 已存 secret 生成 TOTP 真实登录一次。
// 登录成功 = 2FA 确实启用且 secret 正确（登录被要求输入验证器码，用 secret 生成的码通过了）。
// 用法：
//   node scripts/verify-2fa-login.mjs --email a@b.com --totp-secret <base32> [--password 登录密码] [--mail-url <取件地址>] [--proxy <代理URL>] [--seed 12345] [--headless]
import { parseArgs, logger, makeCodeProvider, launch, sleep } from './_harness.mjs';
import { loginChatGPT } from '../flows/openai/register.js';
import { generateTotpNow } from '../utils.js';

const args = parseArgs();
const email = args.email || args._[0];
const secret = args['totp-secret'] || args._[1];
if (!email || !secret) {
  console.error('用法: node scripts/verify-2fa-login.mjs --email <email> --totp-secret <base32> [--password 登录密码] [--mail-url <取件地址>] [--proxy <代理URL>] [--seed <种子>] [--headless]');
  process.exit(1);
}
const log = logger('verify2fa');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}，当前 secret 生成 TOTP=${generateTotpNow(secret)}`);

try {
  const r = await loginChatGPT({
    page,
    email,
    chatgptUrl: 'https://chatgpt.com/',
    password: args.password || '',
    totpSecret: secret,
    requestCode,
    log,
  });
  log(`✅ 登录成功，token=${String(r.accessToken || '').slice(0, 24)}… → 证明 2FA 已启用且 secret 正确`, 'ok');
} catch (e) {
  log(`❌ 登录失败：${e.message}`, 'error');
} finally {
  await sleep(2000);
  close();
  await session.close();
  process.exit(0);
}
