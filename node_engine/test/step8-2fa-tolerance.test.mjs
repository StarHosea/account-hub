import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { resolveStep8Tolerance } = __test;

// step8（设密码 + 开 2FA）失败后的收尾决策：2FA 为可选加固，失败可容忍、仍标记注册成功入池；
// 只有连密码都没设成才算真失败。resolveStep8Tolerance 是 registerChatGPT / secureExistingChatGPT
// 两处 catch 实际调用的决策函数。

test('密码已设 + 2FA 失败 → 容忍，标记成功入池（twoFactorSet 强制 false，其余字段保留）', () => {
  const partial = {
    passwordSet: true, passwordChanged: true, password: 'Pw!',
    twoFactorSecret: '', twoFactorUri: '', recoveryCodes: [], twoFactorSet: true,
  };
  const r = resolveStep8Tolerance(partial, Boolean(partial.passwordSet));
  assert.ok(r, '密码已设应容忍 2FA 失败');
  assert.equal(r.twoFactorSet, false);
  assert.equal(r.passwordSet, true);
  assert.equal(r.passwordChanged, true);
});

test('连密码都没设成 → 不容忍，返回 null（上层抛错、走异常清单）', () => {
  assert.equal(resolveStep8Tolerance({ passwordSet: false }, false), null);
});

test('老账号忘记密码重设后 2FA 失败 → 容忍，保留原 2FA secret（不空值覆盖）', () => {
  const partial = { passwordSet: false, twoFactorSecret: 'OLD', twoFactorUri: 'otpauth://x' };
  const r = resolveStep8Tolerance(partial, Boolean('NewReset1!' || partial.passwordSet));
  assert.ok(r, '忘记密码重设后应容忍 2FA 失败');
  assert.equal(r.twoFactorSet, false);
  assert.equal(r.twoFactorSecret, 'OLD');
});

test('健壮性：partial 为空不抛异常', () => {
  assert.equal(resolveStep8Tolerance(undefined, false), null);
  const r = resolveStep8Tolerance(undefined, true);
  assert.ok(r && r.twoFactorSet === false);
});
