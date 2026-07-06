// ============================================================================
// 取件页验证码提取（assurivo 等，邮件正文在 <iframe srcdoc>）
// ----------------------------------------------------------------------------
// 关键：邮件正文在 <iframe class="body-frame" srcdoc="&lt;...&gt;"> 的 srcdoc 属性里，
// srcdoc 是「HTML 实体编码」的完整邮件 HTML，6 位码在其中是明文
// （如 "Please use the following code to help verify your identity: 635515"）。
// 陷阱：直接对整页去标签，会把 srcdoc="..." 整个属性当标签删掉、连码一起丢。
// 正确：先抽 srcdoc → 实体解码 → 去标签 → 语境正则取码。见 skill: register-cdp-debug。
//
// 用法：node scripts/mailcode.mjs '<取件URL>' [--exclude 旧码1,旧码2] [--wait 秒]
//   取件 URL 多为 assurivo open.php；排查时把 ?limit=1 改大（如 limit=10）可看历史邮件。
//   --exclude  跳过这些已知旧码（联调触发新码后，排除上一次的码，确保取到新的）
//   --wait     轮询等待秒数（默认 0=只取一次；触发码后邮件有延迟时设 20~40）
// 成功打印 6 位码到 stdout；失败 exit 2。
// ============================================================================

function argv(flag, def = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const url = process.argv[2];
if (!url || url.startsWith('--')) { console.error('用法: node scripts/mailcode.mjs <取件URL> [--exclude a,b] [--wait 30]'); process.exit(1); }
const exclude = new Set(argv('--exclude', '').split(',').map((s) => s.trim()).filter(Boolean));
const waitSec = Number(argv('--wait', '0')) || 0;

const decode = (s) => s
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');

// 从取件页 HTML 提取最新一封验证码邮件的 6 位码（优先验证码语境，排除 --exclude）。
export function extractCode(html, skip = new Set()) {
  const frames = [...html.matchAll(/<iframe[^>]*srcdoc="([^"]*)"/gi)].map((m) => m[1]);
  const subjects = [...html.matchAll(/"subject"[^>]*>([\s\S]*?)<\/[^>]+>/gi)].map((m) => m[1]);
  for (const raw of [...frames, ...subjects]) { // 最新邮件在最前
    const text = decode(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const ctx = text.match(/(?:verify your identity|authentication code|verification code|reset code|following code|one-time|一次性验证码|验证码|临时验证码)[^0-9]{0,40}(\d{6})/i);
    const code = ctx ? ctx[1] : ((text.match(/\b(\d{6})\b/) || [])[1] || '');
    if (code && !skip.has(code)) return code;
  }
  return '';
}

async function fetchOnce() {
  const html = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 mailcode' } })).text();
  return extractCode(html, exclude);
}

// 直接运行时才拉取打印（作为模块 import 时只导出 extractCode）
if (import.meta.url === `file://${process.argv[1]}`) {
  const deadline = Date.now() + waitSec * 1000;
  let code = await fetchOnce();
  while (!code && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    code = await fetchOnce();
  }
  if (code) { console.log(code); }
  else { console.error('未提取到验证码'); process.exit(2); }
}
