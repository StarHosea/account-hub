import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRateLimit, RATE_LIMIT_PATTERN, RATE_LIMIT_ERROR_PREFIX } from '../flows/openai/rate-limit.js';

test('RATE_LIMIT_PATTERN 命中实测限流页文案', () => {
  const text = '糟糕，出错了！\n请求过多。请稍后重试。\n错误代码：rate_limit_exceeded';
  assert.match(text, RATE_LIMIT_PATTERN);
});

test('detectRateLimit 识别限流页并提取错误码', async () => {
  const page = {
    evaluate: async () => ({ code: 'rate_limit_exceeded' }),
  };
  const hit = await detectRateLimit(page);
  assert.deepEqual(hit, { code: 'rate_limit_exceeded' });
});

test('detectRateLimit 正常页返回 null', async () => {
  const page = {
    evaluate: async () => null,
  };
  assert.equal(await detectRateLimit(page), null);
});

test('限流错误前缀供 Python 识别为单账号失败', () => {
  assert.match(`${RATE_LIMIT_ERROR_PREFIX} OpenAI 请求限流`, /^rate_limited:/);
});
