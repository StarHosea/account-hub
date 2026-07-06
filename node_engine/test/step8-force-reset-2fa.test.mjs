import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { shouldForceReset2faWhenAlreadyEnabled, detectAuthenticator2faEnabledFromText } = __test;

test('本地无 secret 且 2FA 已开启 → 需要强制重设', () => {
  assert.equal(shouldForceReset2faWhenAlreadyEnabled({ forceReset2fa: false, existingTotpSecret: '' }), true);
});

test('本地有 secret 且未显式 force → 不重设', () => {
  assert.equal(
    shouldForceReset2faWhenAlreadyEnabled({ forceReset2fa: false, existingTotpSecret: 'JBSWY3DPEHPK3PXP' }),
    false,
  );
});

test('显式 forceReset2fa → 即使本地有 secret 也重设', () => {
  assert.equal(
    shouldForceReset2faWhenAlreadyEnabled({ forceReset2fa: true, existingTotpSecret: 'JBSWY3DPEHPK3PXP' }),
    true,
  );
});

test('新版 MFA「添加另一种方法」且无移除入口 → 未启用', () => {
  const t = '多因素身份验证 (MFA)\n添加另一种方法以防止锁定\nAuthenticator app\n使用来自验证器应用的一次性验证码。';
  assert.equal(detectAuthenticator2faEnabledFromText(t), false);
});

test('有移除验证器入口 → 已启用', () => {
  assert.equal(detectAuthenticator2faEnabledFromText('验证器应用已启用\n移除验证器应用'), true);
});
