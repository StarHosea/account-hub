import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';
import { classifyRateLimitPage } from '../flows/openai/rate-limit.js';

const { classifyRetryableNetworkError } = __test;

const ROUTE_ERROR_DOM = [
  'Oops, an error occurred! - OpenAI',
  'Oops, an error occurred!',
  'Route Error (400 Invalid content type: text/html; charset=UTF-8): "Invalid content type: text/html; charset=UTF-8"',
  'Try again',
  'Code',
].join('\n');

test('classifyRetryableNetworkError 命中 Route Error 实测页', () => {
  assert.equal(classifyRetryableNetworkError(ROUTE_ERROR_DOM), true);
});

test('classifyRetryableNetworkError 保留原有网络异常文案', () => {
  assert.equal(classifyRetryableNetworkError('网络异常，请稍后重试'), true);
  assert.equal(classifyRetryableNetworkError('Failed to fetch'), true);
  assert.equal(classifyRetryableNetworkError('Something went wrong'), true);
});

test('classifyRetryableNetworkError 不误伤正常注册页', () => {
  assert.equal(classifyRetryableNetworkError('Continue\nResend email\nCode'), false);
  assert.equal(classifyRetryableNetworkError('Tell us about you\nFirst name'), false);
});

test('限流页由 throwIfRateLimited 先于 clickRetryIfError 拦截', () => {
  const rateLimitText = [
    '糟糕，出错了！',
    '请求过多。请稍后重试。',
    '错误代码：rate_limit_exceeded',
    '重试',
  ].join('\n');
  assert.deepEqual(classifyRateLimitPage(rateLimitText), { code: 'rate_limit_exceeded' });
  // 文案含「请稍后重试」可能同时命中网络重试正则；实际重试前会 throwIfRateLimited
  assert.equal(classifyRetryableNetworkError(rateLimitText), true);
});
