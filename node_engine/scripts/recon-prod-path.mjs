// 用「生产同款内部函数」复现 step8 打开安全tab 全过程，精确定位断点。
// 凭据从 data/accounts.json 读，取件地址从 mailboxes.json 匹配。全部输出走 stdout，请重定向到文件。
// 用法： node scripts/recon-prod-path.mjs --idx 1 [--proxy http://127.0.0.1:7890] [--headless]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, logger, launch, dumpUi, sleep, makeCodeProvider } from './_harness.mjs';
import { loginChatGPT, dismissWelcomeOverlays, openSettings, openSecurityTab, waitForSecurityTabReady } from '../flows/openai/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const idx = Number(args.idx ?? 1);
const proxy = args.proxy || 'http://127.0.0.1:7890';
const log = logger('prodpath');

const accounts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/accounts.json'), 'utf8'));
const acc = accounts[idx];
if (!acc) { console.error(`账号 idx=${idx} 不存在`); process.exit(1); }
log(`目标账号 idx=${idx} email=${acc.email}`);

let mailUrl = args['mail-url'] || '';
if (!mailUrl) {
  try {
    const mb = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/mailboxes.json'), 'utf8'));
    const items = Array.isArray(mb) ? mb : (mb.items || []);
    const hit = items.find((x) => (x.email || '').toLowerCase() === (acc.email || '').toLowerCase());
    if (hit?.fetch_url) { mailUrl = hit.fetch_url; log('已匹配取件地址'); }
  } catch { /* ignore */ }
}
const { requestCode, close } = makeCodeProvider({ mailUrl, log });
const { session, page } = await launch({ proxy, seed: acc.fingerprint_seed, headless: Boolean(args.headless), log });
log(`浏览器启动 seed=${session.seed}`);

try {
  await loginChatGPT({ page, email: acc.email, password: acc.password || '', totpSecret: acc.totp_secret || '', requestCode, log });
  log('登录完成，进入生产同款 step8 打开安全tab 路径');
  await sleep(2000);

  await dismissWelcomeOverlays(page, log);

  // —— 生产 openSecurityTab 内部就会调用 openSettings + 重试 + reload。直接跑它，看是否抛错 ——
  try {
    await openSecurityTab(page, log, { maxRetries: 3 });
    log('✅✅ openSecurityTab 成功返回（安全tab已打开、密码/2FA 元素可见）', 'ok');
    await dumpUi(page, 'PROD-security-ready', log);
  } catch (e) {
    log(`❌ openSecurityTab 抛错：${e.message}`, 'error');
    await dumpUi(page, 'PROD-security-fail', log);
  }
} catch (e) {
  log(`ERROR ${e.message.split('\n')[0]}`, 'error');
  await dumpUi(page, 'PROD-ERR', log).catch(() => {});
} finally {
  try { close(); } catch { /* ignore */ }
  await session.close().catch(() => {});
  process.exit(0);
}
