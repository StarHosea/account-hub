// 老账号自动化管线：登录已注册账号 → 设新密码 → 开 2FA → 取 token。
// 用法：
//   node scripts/run-secure-one.mjs --email a@b.com --mail-url <取件地址> [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed 12345] [--headless] [--no-2fa]
import { parseArgs, logger, makeCodeProvider, launch, snap } from './_harness.mjs';
import { secureExistingChatGPT } from '../flows/openai/register.js';

const args = parseArgs();
const email = args.email || args._[0];
if (!email) {
  console.error('用法: node scripts/run-secure-one.mjs --email <email> [--mail-url <取件地址>] [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed <种子>] [--headless] [--no-2fa]');
  process.exit(1);
}
const log = logger('secure-one');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}`);

try {
  const data = await secureExistingChatGPT({
    page,
    email,
    chatgptUrl: 'https://chatgpt.com/',
    enable2fa: !args['no-2fa'],
    loginPassword: args.password || '',
    existingTotpSecret: args['totp-secret'] || '',
    forceReset2fa: Boolean(args['force-reset-2fa']),
    requestCode,
    log,
  });
  log('✅ 结果: ' + JSON.stringify({
    email: data.email,
    passwordSet: data.passwordSet,
    password: data.password,
    twoFactorSet: data.twoFactorSet,
    twoFactorSecret: data.twoFactorSecret,
    tokenHead: String(data.accessToken || '').slice(0, 24) + '…',
  }, null, 2));
} catch (e) {
  log(`ERROR ${e.message}`, 'error');
  await snap(page, 'secure-one-error');
} finally {
  close();
  await session.close();
  process.exit(0);
}
