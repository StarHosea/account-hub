// 端到端真跑单个邮箱：新IP+新指纹 → 注册 → 设密码 → 开2FA → 取token。
// 邮箱已注册时自动转老账号流程（登录→设新密码→开2FA→取token）。
// 用法：
//   node scripts/run-one.mjs --email a@b.com --mail-url <取件地址> [--proxy http://user:pass@host:port] [--seed 12345] [--headless] [--no-2fa]
//   node scripts/run-one.mjs --email a@b.com   （不给 --mail-url 时，验证码在终端手动输入）
import { parseArgs, logger, makeCodeProvider, launch, snap } from './_harness.mjs';
import { registerChatGPT, secureExistingChatGPT } from '../flows/openai/register.js';

const args = parseArgs();
const email = args.email || args._[0];
if (!email) {
  console.error('用法: node scripts/run-one.mjs --email <email> [--mail-url <取件地址>] [--proxy <代理URL>] [--seed <种子>] [--headless] [--no-2fa]');
  process.exit(1);
}
const log = logger('run-one');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}`);

try {
  const common = {
    page,
    email,
    chatgptUrl: 'https://chatgpt.com/',
    enable2fa: !args['no-2fa'],
    requestCode,
    log,
  };
  let data = await registerChatGPT(common);
  if (data && data.emailExists) {
    log('邮箱已注册，转入老账号（登录→设密码→2FA）流程');
    data = await secureExistingChatGPT({ ...common, loginPassword: args.password || '' });
  }
  data.fingerprintSeed = session.seed;
  log('✅ 结果: ' + JSON.stringify({
    email: data.email,
    mode: data.mode,
    passwordSet: data.passwordSet,
    password: data.password,
    twoFactorSet: data.twoFactorSet,
    twoFactorSecret: data.twoFactorSecret,
    recoveryCodes: data.recoveryCodes,
    tokenHead: String(data.accessToken || '').slice(0, 24) + '…',
  }, null, 2));
} catch (e) {
  log(`ERROR ${e.message}`, 'error');
  await snap(page, 'run-one-error');
} finally {
  close();
  await session.close();
  process.exit(0);
}
