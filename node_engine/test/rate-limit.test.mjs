import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRateLimitPage,
  RATE_LIMIT_ERROR_PREFIX,
} from '../flows/openai/rate-limit.js';

const USER_DOM_TEXT = [
  '糟糕，出错了！',
  '请求过多。请稍后重试。',
  '错误代码：rate_limit_exceeded',
  '请求 ID：87de3eb5-09e8-4224-a55a-5c4728018b6e',
  '重试',
].join('\n');

test('classifyRateLimitPage 命中实测限流页', () => {
  assert.deepEqual(classifyRateLimitPage(USER_DOM_TEXT), { code: 'rate_limit_exceeded' });
});

test('classifyRateLimitPage 英文限流错误页', () => {
  const text = 'Something went wrong\nToo many requests. Please try again later.\nError code: rate_limit_exceeded';
  assert.deepEqual(classifyRateLimitPage(text), { code: 'rate_limit_exceeded' });
});

test('classifyRateLimitPage 首页/普通文案不误伤', () => {
  assert.equal(classifyRateLimitPage('ChatGPT\n免费注册\n登录'), null);
  assert.equal(classifyRateLimitPage('Too many requests can slow down the service.'), null);
  assert.equal(classifyRateLimitPage('糟糕，网络不太稳定'), null);
  assert.equal(classifyRateLimitPage('rate_limit_exceeded'), null);
});

test('限流错误前缀供 Python 识别为单账号失败', () => {
  assert.match(`${RATE_LIMIT_ERROR_PREFIX} OpenAI 请求限流`, /^rate_limited:/);
});
