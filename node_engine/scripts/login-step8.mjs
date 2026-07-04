// 登录已注册账号 → 只跑步骤8（设密码 + 开 2FA）。用于反复迭代 Step 8，不必重新注册、不浪费邮箱。
// 用法：
//   node scripts/login-step8.mjs --email a@b.com --mail-url <取件地址> [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed 12345] [--headless] [--no-2fa]
import { parseArgs, logger, makeCodeProvider, launch, snap, sleep } from './_harness.mjs';
import { loginChatGPT, step8_setupPasswordAnd2FA } from '../flows/openai/register.js';
import { generatePassword } from '../utils.js';

const args = parseArgs();
const email = args.email || args._[0];
if (!email) {
  console.error('用法: node scripts/login-step8.mjs --email <email> [--mail-url <取件地址>] [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed <种子>] [--headless] [--no-2fa]');
  process.exit(1);
}
const log = logger('step8');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}`);

try {
  await loginChatGPT({
    page,
    email,
    chatgptUrl: 'https://chatgpt.com/',
    password: args.password || '',
    totpSecret: args['totp-secret'] || '',
    requestCode,
    log,
  });
  const password = generatePassword();
  log(`生成密码 ${password}，开始步骤8`);
  const out = await step8_setupPasswordAnd2FA(page, {
    email,
    password,
    enable2fa: !args['no-2fa'],
    requestCode,
    log,
  });
  log('✅ 步骤8结果: ' + JSON.stringify({
    passwordSet: out.passwordSet,
    twoFactorSet: out.twoFactorSet,
    twoFactorSecret: out.twoFactorSecret || out.twoFactorUri,
    recovery: out.recoveryCodes?.length || 0,
  }, null, 2));
} catch (e) {
  log(`ERROR ${e.message}`, 'error');
  await snap(page, 'step8-error');
} finally {
  await sleep(1500);
  close();
  await session.close();
  process.exit(0);
}
