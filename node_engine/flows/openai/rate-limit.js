/**
 * OpenAI 请求限流页检测。
 *
 * 文案来源（2026-07-06 实测 DOM）：
 * - 标题：「糟糕，出错了！」
 * - 副标题：「请求过多。请稍后重试。」
 * - 元数据：「错误代码：rate_limit_exceeded」
 * - 按钮：data-dd-action-name="Try again" / 文案「重试」
 *
 * 注意：不能用 loose 正则扫 body（如单独匹配 too many requests），
 * 首页/帮助文案会误伤；必须命中「错误页结构 + 限流语义」组合。
 */

/** 与 Python openai_register.worker 约定：限流仅终止当前账号任务，不 stop_run。 */
export const RATE_LIMIT_ERROR_PREFIX = 'rate_limited:';

/** 在浏览器内判定是否为 OpenAI 限流错误页（纯逻辑，供 evaluate 与单测复用）。 */
export function classifyRateLimitPage(text) {
  const body = String(text || '');
  if (!body.trim()) return null;

  const codeFromMeta = () => {
    const m = body.match(/错误代码[：:]\s*(\S+)|error code[：:]\s*(\S+)/i);
    return (m && (m[1] || m[2])) ? (m[1] || m[2]).trim() : '';
  };

  const metaCode = codeFromMeta();
  if (/^rate_limit_exceeded$/i.test(metaCode)) {
    return { code: metaCode };
  }

  const isErrorShell = /糟糕[，,]?\s*出错了|something went wrong|\boops\b/i.test(body);
  const isRateZh = /请求过多/.test(body) && /请稍后重试/.test(body);
  const isRateEn = /too many requests/i.test(body) && /try again later|please try again/i.test(body);

  if (isErrorShell && (isRateZh || isRateEn)) {
    return { code: 'rate_limit_exceeded' };
  }

  return null;
}

/** 检测当前页是否为 OpenAI 限流错误页；命中返回 { code }，否则 null。 */
export async function detectRateLimit(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    if (!body.trim()) return null;

    const meta = body.match(/错误代码[：:]\s*(\S+)|error code[：:]\s*(\S+)/i);
    const metaCode = meta ? (meta[1] || meta[2] || '').trim() : '';
    if (/^rate_limit_exceeded$/i.test(metaCode)) {
      return { code: metaCode };
    }

    const isErrorShell = /糟糕[，,]?\s*出错了|something went wrong|\boops\b/i.test(body);
    const isRateZh = /请求过多/.test(body) && /请稍后重试/.test(body);
    const isRateEn = /too many requests/i.test(body) && /try again later|please try again/i.test(body);
    if (isErrorShell && (isRateZh || isRateEn)) {
      return { code: 'rate_limit_exceeded' };
    }
    return null;
  }).catch(() => null);
}

/** 若当前为限流页则立即抛错，仅终止本账号注册任务（其它并发任务不受影响）。 */
export async function throwIfRateLimited(page, log) {
  const hit = await detectRateLimit(page);
  if (!hit) return;
  const msg = `${RATE_LIMIT_ERROR_PREFIX} OpenAI 请求限流（${hit.code}），本账号终止`;
  log?.(msg, 'error');
  throw new Error(msg);
}
