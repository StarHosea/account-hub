// 只读勘察：登录已注册账号 → 打开设置 → dump 密码/2FA 的真实 DOM（截图 + 可见按钮/输入/提示）。
// 不提交任何更改，用于探查 ChatGPT 设置页结构、迭代选择器。
// 用法：
//   node scripts/recon-settings.mjs --email a@b.com --mail-url <取件地址> [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed 12345]
import { parseArgs, logger, makeCodeProvider, launch, dumpUi, domClick, snap, sleep } from './_harness.mjs';
import { loginChatGPT, dismissWelcomeOverlays } from '../flows/openai/register.js';

const args = parseArgs();
const email = args.email || args._[0];
if (!email) {
  console.error('用法: node scripts/recon-settings.mjs --email <email> [--mail-url <取件地址>] [--password 登录密码] [--totp-secret <base32>] [--proxy <代理URL>] [--seed <种子>]');
  process.exit(1);
}
const log = logger('recon');
const { requestCode, close } = makeCodeProvider({ mailUrl: args['mail-url'] || '', log });
// 勘察默认有头，便于人工观察
const { session, page } = await launch({ proxy: args.proxy || '', seed: args.seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}`);

try {
  log('登录到已登录态…');
  await loginChatGPT({
    page,
    email,
    chatgptUrl: 'https://chatgpt.com/',
    password: args.password || '',
    totpSecret: args['totp-secret'] || '',
    requestCode,
    log,
  });
  log(`登录后 URL=${page.url()}`);
  await dumpUi(page, '00-after-login', log);

  // 关掉欢迎插页（若有），再打开设置
  await dismissWelcomeOverlays(page, log).catch(() => {});
  log('打开账户菜单…');
  await domClick(page, ['打开个人资料菜单', 'open profile menu', 'user menu', 'account menu', 'profile menu', '账户', 'account', 'profile']);
  await sleep(1500);
  await dumpUi(page, '01-profile-menu', log);

  await domClick(page, ['设置', 'settings']);
  await sleep(2500);
  await dumpUi(page, '02-settings-open', log);

  // 逐个尝试进入「安全 / 账户」相关 tab，各自 dump
  for (const tabName of ['账户安全与登录', '安全', 'security', 'account security', '账户', 'account']) {
    const hit = await domClick(page, [tabName]);
    if (hit) {
      log(`进入 tab「${hit}」`);
      await sleep(2000);
      await dumpUi(page, `03-tab-${tabName}`, log);
    }
  }
  log('勘察完成，截图见 diag/ 目录');
} catch (e) {
  log(`ERROR ${e.message}`, 'error');
  await snap(page, 'recon-error');
} finally {
  await sleep(1500);
  close();
  await session.close();
  process.exit(0);
}
