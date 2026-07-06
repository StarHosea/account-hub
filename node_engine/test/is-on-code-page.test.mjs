import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../flows/openai/register.js';
import { PROFILE_SUBMIT_TEXTS } from '../flows/openai/selectors.js';

const { isOnCodePage } = __test;

function mockPage({ url, evaluateResult = false }) {
  return {
    url: () => url,
    evaluate: async () => evaluateResult,
  };
}

test('isOnCodePage：about-you 资料页 URL 直接排除', async () => {
  const page = mockPage({ url: 'https://auth.openai.com/about-you' });
  assert.equal(await isOnCodePage(page), false);
});

test('isOnCodePage：email-verification + 可见验证码输入', async () => {
  const page = mockPage({
    url: 'https://auth.openai.com/email-verification',
    evaluateResult: true,
  });
  assert.equal(await isOnCodePage(page), true);
});

test('isOnCodePage：email-verification 但无验证码 DOM → false', async () => {
  const page = mockPage({
    url: 'https://auth.openai.com/email-verification',
    evaluateResult: false,
  });
  assert.equal(await isOnCodePage(page), false);
});

test('PROFILE_SUBMIT_TEXTS 覆盖日语完成按钮', () => {
  const btn = 'アカウントの作成を完了する';
  const lower = PROFILE_SUBMIT_TEXTS.map((t) => t.toLowerCase());
  assert.ok(lower.some((w) => btn.toLowerCase().includes(w)));
});
