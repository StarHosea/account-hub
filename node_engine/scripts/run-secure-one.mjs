// 老账号自动化管线：登录已注册账号 → 设新密码 → 开 2FA → 取 token。
// 用法：
//   node scripts/run-secure-one.mjs --email a@b.com --mail-url <取件地址> [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed 12345] [--headless] [--no-2fa]
//   CLOAK_USE_SYSTEM_CHROME=1 node scripts/run-secure-one.mjs ... --proxy http://127.0.0.1:7890
//   CLOAK_CONNECT_CDP=9222 node scripts/run-secure-one.mjs ... --cdp-port 9222   # 挂本机已开的 Chrome
import { parseArgs, logger, makeCodeProvider, launch, connectCdp, resolveCdpEndpoint, snap } from './_harness.mjs';
import { secureExistingChatGPT } from '../flows/openai/register.js';

const args = parseArgs();
const email = args.email || args._[0];
if (!email) {
  console.error(
    '用法: node scripts/run-secure-one.mjs --email <email> [--mail-url <取件地址>] [--password 登录密码]\n'
    + '      [--totp-secret <base32>] [--proxy <代理URL>] [--cdp-port 9222] [--seed <种子>] [--headless] [--no-2fa] [--force-reset-2fa]\n'
    + '本机 Chrome CDP：先启动 Chrome --remote-debugging-port=9222，再 CLOAK_CONNECT_CDP=9222 node scripts/run-secure-one.mjs ...',
  );
  process.exit(1);
}
const log = logger('secure-one');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
const cdpEndpoint = resolveCdpEndpoint(args['cdp-port'] || '');
const boot = cdpEndpoint
  ? await connectCdp({ endpoint: cdpEndpoint, log })
  : await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
const { session, page, detachOnly = false } = boot;
log(detachOnly ? `已挂接本机 Chrome（${cdpEndpoint}）` : `浏览器启动 seed=${session.seed}`);

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
  if (!detachOnly) await session.close();
  else await session.browser?.close?.().catch(() => {});
  process.exit(0);
}
