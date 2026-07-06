// ============================================================================
// CDP 联调 · 驱动器（连到 cdp-serve 的 stealth 浏览器，做一步、看结果）
// ----------------------------------------------------------------------------
// connectOverCDP 连上 cdp-serve 常驻的浏览器，执行一条命令后断开（不关浏览器，浏览器由
// cdp-serve 持有、状态保持）。这样可反复调用、逐步推进注册流程，卡住就停在那步不动，
// 用真实 stealth 页面的 DOM 定位问题、验证新 selector/文案。见 skill: register-cdp-debug。
//
// 用法：CLOAK_CDP_PORT=9222 node scripts/cdp-drive.mjs <命令> [参数...]
//   url                          打印当前 URL / 标题
//   snapshot                     dump 可见按钮·链接·输入·关键提示文案（定位 selector 首选）
//   text [关键词]                打印正文（可选只打印含关键词的片段）
//   html [关键词]                打印去标签正文里含关键词的上下文片段
//   click <文案>                 按可见文案点击（button/a/[role]，同 humanClickByText 口径）
//   fill <selector> <值>         给输入框填值
//   press <selector> <键>        对元素按键（如 Enter）
//   goto <url>                   导航
//   eval "<js>"                  在页面执行 JS 并打印返回（() => ... 或表达式）
//   shot <文件>                  截图落盘
// ============================================================================
import { chromium } from 'playwright-core';

const port = Number(process.env.CLOAK_CDP_PORT || 9222);
const [cmd, ...rest] = process.argv.slice(2);

const VIS = `(el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}`;

function out(x) { console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2)); }

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
} catch (e) {
  console.error(`连不上 CDP（http://127.0.0.1:${port}）：${e?.message || e}\n先启动 cdp-serve.mjs。`);
  process.exit(1);
}
const ctx = browser.contexts()[0];
if (!ctx) { console.error('无 context（浏览器可能没开页面）'); await browser.close(); process.exit(1); }
const pages = ctx.pages();
const page = pages[pages.length - 1];

try {
  switch (cmd) {
    case 'url':
      out({ url: page.url(), title: await page.title().catch(() => '') });
      break;
    case 'lang': {
      const info = await page.evaluate(() => ({
        htmlLang: document.documentElement.lang || '',
        navigatorLanguage: navigator.language || '',
        languages: navigator.languages ? [...navigator.languages] : [],
      }));
      out(info);
      break;
    }
    case 'snapshot': {
      const info = await page.evaluate(`(() => {
        const vis = ${VIS};
        const t = (el)=>(el.innerText||el.value||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
        return {
          url: location.href, title: document.title,
          buttons: [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab],[role=option],[role=radio]')].filter(vis).map(t).filter(Boolean).slice(0,50),
          inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis).map(i=>({type:i.type,name:i.name,id:i.id,ph:i.placeholder,al:i.getAttribute('aria-label'),maxlen:i.getAttribute('maxlength')})),
          hints: [...new Set([...document.querySelectorAll('h1,h2,h3,label,span,p,div')].filter(vis).map(t).filter(x=>x&&x.length<50))].slice(0,40),
        };
      })()`);
      out(info);
      break;
    }
    case 'text': {
      const kw = rest.join(' ');
      const txt = await page.evaluate('document.body?.innerText||""');
      if (kw) out(txt.split('\n').filter((l) => l.includes(kw)).join('\n') || `(无含「${kw}」的行)`);
      else out(txt.slice(0, 3000));
      break;
    }
    case 'html': {
      const kw = rest.join(' ');
      const frag = await page.evaluate(`(() => {
        let t=document.documentElement.innerHTML.replace(/<script[\\s\\S]*?<\\/script>/gi,' ').replace(/<style[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ');
        const kw=${JSON.stringify(kw)};
        if(!kw) return t.slice(0,2000);
        const out=[]; let i=0; while((i=t.indexOf(kw,i))>=0 && out.length<8){ out.push(t.slice(Math.max(0,i-30),i+kw.length+40)); i+=kw.length; }
        return out.join('\\n---\\n')||('(无「'+kw+'」)');
      })()`);
      out(frag);
      break;
    }
    case 'click': {
      const wanted = rest.join(' ');
      const hit = await page.evaluate(`(() => {
        const vis = ${VIS};
        const w = ${JSON.stringify(wanted)}.toLowerCase();
        const cands=[...document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=radio],input[type=submit]')].filter(vis);
        const txt=(el)=>(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase();
        let el=cands.find(e=>txt(e)===w)||cands.find(e=>txt(e).includes(w));
        if(!el) return null; el.setAttribute('data-cdp-hit','1'); return txt(el).slice(0,40);
      })()`);
      if (!hit) { out(`未命中「${wanted}」`); break; }
      await page.click('[data-cdp-hit="1"]', { timeout: 5000 }).catch((e) => out(`点击异常：${e?.message}`));
      await page.evaluate("document.querySelector('[data-cdp-hit]')?.removeAttribute('data-cdp-hit')").catch(() => {});
      out(`已点击「${hit}」，当前 URL=${page.url()}`);
      break;
    }
    case 'fill': {
      const [sel, ...v] = rest;
      await page.fill(sel, v.join(' '), { timeout: 5000 });
      out(`已填 ${sel} = ${v.join(' ')}`);
      break;
    }
    case 'press': {
      const [sel, key] = rest;
      await page.press(sel, key, { timeout: 5000 });
      out(`已对 ${sel} 按 ${key}`);
      break;
    }
    case 'goto':
      await page.goto(rest[0], { waitUntil: 'domcontentloaded', timeout: 90000 });
      out(`已导航 ${page.url()}`);
      break;
    case 'eval': {
      const r = await page.evaluate(rest.join(' '));
      out(r);
      break;
    }
    case 'shot':
      await page.screenshot({ path: rest[0] || '/tmp/cdp-shot.png' });
      out(`已截图 ${rest[0] || '/tmp/cdp-shot.png'}`);
      break;
    default:
      out('命令：url | snapshot | text [kw] | html [kw] | click <文案> | fill <sel> <值> | press <sel> <键> | goto <url> | eval "<js>" | shot <文件>');
  }
} finally {
  await browser.close(); // 只断开 CDP 连接，不关闭浏览器（浏览器由 cdp-serve 持有）
}
