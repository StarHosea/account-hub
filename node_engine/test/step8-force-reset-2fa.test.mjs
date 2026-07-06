import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { shouldForceReset2faWhenAlreadyEnabled, detectAuthenticator2faEnabledFromText } = __test;

test('安全页 2FA 已开启 → 一律强制重设（与本地 secret 无关）', () => {
  assert.equal(shouldForceReset2faWhenAlreadyEnabled(), true);
  assert.equal(
    shouldForceReset2faWhenAlreadyEnabled({ forceReset2fa: false, existingTotpSecret: 'JBSWY3DPEHPK3PXP' }),
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
