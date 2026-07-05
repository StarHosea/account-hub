// ============================================================================
// 每步 DOM 记录器（可回放；成功即删、失败留证，省存储）
// ----------------------------------------------------------------------------
// 每调一次 record()：抓 documentElement.outerHTML + 截图 png + 当前 URL/title +
// 状态机快照（detectAuthState 的 pageState/accountFacts/confidence/evidence），
// 追加到 manifest.jsonl 并落 {seq}-{stepId}.html/.png。
//
// finalize({ success })：
//   keep='fail'（默认）→ 成功删整个目录、失败保留并生成 recording.html 时间轴回放页；
//   keep='all'         → 都保留；
//   keep='none'        → 都删（仅运行中留着排查）。
//
// dir 为空 → 返回 no-op recorder（enabled=false，所有方法立即返回，零副作用），
// 保证未开开关时对生产流程无任何影响。
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectAuthState } from './auth-state.js';

const NOOP = {
  enabled: false,
  async record() {},
  async finalize() { return { kept: false, dir: '', steps: 0 }; },
};

function safe(page, fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

export function createRecorder({ dir = '', page, log = () => {}, keep = 'fail' } = {}) {
  if (!dir || !page) return NOOP;

  const mode = ['fail', 'all', 'none'].includes(keep) ? keep : 'fail';
  const manifest = [];
  let seq = 0;
  let ready = null; // 目录创建的 promise（懒创建）

  async function ensureDir() {
    if (!ready) ready = fs.mkdir(dir, { recursive: true }).catch(() => {});
    return ready;
  }

  async function record(stepId, extraMeta = {}) {
    try {
      await ensureDir();
      seq += 1;
      const base = `${String(seq).padStart(3, '0')}-${sanitize(stepId)}`;
      const url = safe(page, () => page.url(), '');

      // 状态机快照（只读，失败不阻断记录）
      let state = null;
      try { state = await detectAuthState(page); } catch { /* ignore */ }

      // DOM 快照（加 <base> 让相对资源在回放时尽量可解析）
      let html = '';
      try {
        html = await page.evaluate(() => document.documentElement.outerHTML);
      } catch { html = ''; }
      if (html) {
        const baseTag = url ? `<base href="${escapeAttr(url)}">` : '';
        const withBase = baseTag && !/<base\b/i.test(html)
          ? html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${baseTag}`)
          : html;
        await fs.writeFile(path.join(dir, `${base}.html`), withBase, 'utf8').catch(() => {});
      }

      // 截图
      let hasPng = false;
      try { await page.screenshot({ path: path.join(dir, `${base}.png`) }); hasPng = true; } catch { hasPng = false; }

      const rec = {
        seq,
        stepId: String(stepId),
        ts: Date.now(),
        note: extraMeta.note || '',
        url,
        pageState: state?.pageState || null,
        confidence: state?.confidence || null,
        accountFacts: state?.accountFacts || null,
        reason: state?.reason || '',
        html: html ? `${base}.html` : '',
        png: hasPng ? `${base}.png` : '',
        ...extraMeta,
      };
      manifest.push(rec);
      await fs.appendFile(path.join(dir, 'manifest.jsonl'), JSON.stringify(rec) + '\n', 'utf8').catch(() => {});
      return rec;
    } catch (e) {
      log(`[记录器] record(${stepId}) 异常：${e?.message || e}`, 'warn');
      return null;
    }
  }

  async function finalize({ success = false } = {}) {
    const shouldKeep = mode === 'all' || (mode === 'fail' && !success);
    if (!shouldKeep) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      log(`[记录器] ${success ? '成功' : '结束'}，已清理 DOM 记录（keep=${mode}），省存储`);
      return { kept: false, dir: '', steps: manifest.length };
    }
    try {
      await ensureDir();
      await fs.writeFile(path.join(dir, 'recording.html'), buildViewer(manifest), 'utf8');
    } catch { /* ignore */ }
    log(`[记录器] 已保留 ${manifest.length} 步 DOM 记录，回放：${path.join(dir, 'recording.html')}`);
    return { kept: true, dir, steps: manifest.length };
  }

  return { enabled: true, record, finalize };
}

function sanitize(s) {
  return String(s || 'step').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 自包含时间轴回放页：左列步骤（含 pageState/confidence/账号事实），右侧上截图下 DOM iframe。
function buildViewer(manifest) {
  const data = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>注册流程 DOM 回放（${manifest.length} 步）</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f141a;color:#e6edf3;height:100vh;display:flex}
  #list{width:340px;flex:0 0 340px;overflow:auto;border-right:1px solid #263140;background:#131a22}
  #list h1{font-size:13px;padding:12px 14px;margin:0;color:#9aa7b4;position:sticky;top:0;background:#131a22;border-bottom:1px solid #263140}
  .step{padding:10px 14px;border-bottom:1px solid #1c2530;cursor:pointer}
  .step:hover{background:#18212b} .step.active{background:#1f3350}
  .step .id{font-size:12px;color:#cbd5e1} .step .meta{font-size:11px;color:#7d8b99;margin-top:3px}
  .badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;background:#25405f;color:#bcd4f0;margin-right:4px}
  .badge.high{background:#1f4d33;color:#9fe6bd} .badge.low{background:#5a3320;color:#f0c19f}
  #main{flex:1;display:flex;flex-direction:column;overflow:hidden}
  #bar{padding:8px 14px;font-size:12px;color:#9aa7b4;border-bottom:1px solid #263140;background:#131a22;white-space:nowrap;overflow:auto}
  #panes{flex:1;display:flex;flex-direction:column;overflow:hidden}
  #shot{flex:1;overflow:auto;background:#0a0e13;text-align:center} #shot img{max-width:100%}
  #domwrap{height:42%;border-top:1px solid #263140;display:flex;flex-direction:column}
  #domwrap .t{font-size:11px;color:#7d8b99;padding:4px 10px} iframe{flex:1;border:0;background:#fff}
</style></head><body>
<div id="list"><h1>DOM 回放 · ${manifest.length} 步</h1></div>
<div id="main">
  <div id="bar">选择左侧步骤查看该时刻的截图与 DOM 快照</div>
  <div id="panes">
    <div id="shot"></div>
    <div id="domwrap"><div class="t">DOM 快照（静态，相对资源可能缺失，以截图为准）</div><iframe id="dom"></iframe></div>
  </div>
</div>
<script>
const M = ${data};
const list = document.getElementById('list'), bar = document.getElementById('bar'), shot = document.getElementById('shot'), dom = document.getElementById('dom');
function fmt(ts){ try{ return new Date(ts).toISOString().slice(11,19); }catch(e){ return ''; } }
function facts(f){ if(!f) return ''; const p = f.passwordSet===null?'?':(f.passwordSet?'有':'无'); const m = f.mfaEnabled===null?'?':(f.mfaEnabled?'开':'关'); return '密码:'+p+' 2FA:'+m; }
M.forEach((r,i)=>{
  const d=document.createElement('div'); d.className='step'; d.dataset.i=i;
  d.innerHTML='<div class="id">'+r.seq+'. '+escapeHtml(r.stepId)+'</div>'+
    '<div class="meta"><span class="badge '+(r.confidence||'')+'">'+(r.pageState||'?')+'</span>'+
    (r.accountFacts?('<span class="badge">'+facts(r.accountFacts)+'</span>'):'')+fmt(r.ts)+'</div>'+
    (r.note?('<div class="meta">'+escapeHtml(r.note)+'</div>'):'');
  d.onclick=()=>select(i); list.appendChild(d);
});
function escapeHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function select(i){
  document.querySelectorAll('.step').forEach(e=>e.classList.remove('active'));
  document.querySelector('.step[data-i="'+i+'"]').classList.add('active');
  const r=M[i];
  bar.textContent='#'+r.seq+' '+r.stepId+'  ·  '+(r.pageState||'?')+'('+(r.confidence||'')+')  ·  '+(r.reason||'')+'  ·  '+(r.url||'');
  shot.innerHTML = r.png ? '<img src="'+r.png+'">' : '<p style="color:#7d8b99;padding:40px">（无截图）</p>';
  dom.src = r.html || 'about:blank';
}
if(M.length) select(0);
</script></body></html>`;
}

export const __test = { buildViewer, sanitize };
