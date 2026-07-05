/**
 * OpenAI 请求限流页检测。
 *
 * 文案来源（2026-07-06 实测 DOM）：
 * - 标题：「糟糕，出错了！」
 * - 副标题：「请求过多。请稍后重试。」
 * - 元数据：「错误代码：rate_limit_exceeded」
 * - 按钮：data-dd-action-name="Try again" / 文案「重试」
 */

export const RATE_LIMIT_PATTERN = /rate_limit_exceeded|请求超出限制|请求过多|too many requests/i;

/** 检测当前页是否为 OpenAI 限流错误页；命中返回 { code }，否则 null。 */
export async function detectRateLimit(page) {
  return page.evaluate((patternSrc) => {
    const re = new RegExp(patternSrc, 'i');
    const text = document.body?.innerText || '';
    if (!re.test(text)) return null;
    const m = text.match(/错误代码[：:]\s*(\S+)|error code[：:]\s*(\S+)/i);
    const code = (m && (m[1] || m[2])) ? (m[1] || m[2]).trim() : 'rate_limit_exceeded';
    return { code };
  }, { patternSrc: RATE_LIMIT_PATTERN.source }).catch(() => null);
}

/** 与 Python openai_register.worker 约定：限流仅终止当前账号任务，不 stop_run。 */
export const RATE_LIMIT_ERROR_PREFIX = 'rate_limited:';

/** 若当前为限流页则立即抛错，仅终止本账号注册任务（其它并发任务不受影响）。 */
export async function throwIfRateLimited(page, log) {
  const hit = await detectRateLimit(page);
  if (!hit) return;
  const msg = `${RATE_LIMIT_ERROR_PREFIX} OpenAI 请求限流（${hit.code}），本账号终止`;
  log?.(msg, 'error');
  throw new Error(msg);
}
