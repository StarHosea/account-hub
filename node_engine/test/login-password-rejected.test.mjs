import test from 'node:test';
import assert from 'node:assert/strict';

import * as S from '../flows/openai/selectors.js';
import { __test } from '../flows/openai/register.js';

test('WRONG_LOGIN_PASSWORD_PATTERN matches OpenAI login error copy', () => {
  assert.match('Incorrect email address or password', S.WRONG_LOGIN_PASSWORD_PATTERN);
  assert.match('密码不正确', S.WRONG_LOGIN_PASSWORD_PATTERN);
  assert.match('邮箱或密码错误', S.WRONG_LOGIN_PASSWORD_PATTERN);
  assert.doesNotMatch('How can I help you today', S.WRONG_LOGIN_PASSWORD_PATTERN);
});

test('FORGOT_PASSWORD_PATTERN matches ja/zh/en forgot-password links', () => {
  assert.match('Forgot password?', S.FORGOT_PASSWORD_PATTERN);
  assert.match('忘记了密码？', S.FORGOT_PASSWORD_PATTERN);
  assert.match('パスワードをお忘れですか？', S.FORGOT_PASSWORD_PATTERN);
  assert.doesNotMatch('パスワードを表示します', S.FORGOT_PASSWORD_PATTERN);
});

test('waitForLoginPasswordOutcome returns rejected when error appears quickly', async () => {
  const beforeUrl = 'https://auth.openai.com/log-in/password';
  let polls = 0;
  const page = {
    url: () => beforeUrl,
    evaluate: async () => {
      polls += 1;
      return polls >= 2; // 第 2 次轮询时出现报错
    },
  };
  const outcome = await __test.waitForLoginPasswordOutcome(page, beforeUrl, { timeoutMs: 2000, pollMs: 50 });
  assert.equal(outcome, 'rejected');
  assert.ok(polls >= 2);
});

test('waitForLoginPasswordOutcome returns navigated on URL change', async () => {
  let url = 'https://auth.openai.com/log-in/password';
  const page = {
    url: () => url,
    evaluate: async () => false,
  };
  setTimeout(() => { url = 'https://auth.openai.com/mfa-challenge/totp'; }, 120);
  const outcome = await __test.waitForLoginPasswordOutcome(page, 'https://auth.openai.com/log-in/password', { timeoutMs: 2000, pollMs: 50 });
  assert.equal(outcome, 'navigated');
});
