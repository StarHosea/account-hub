import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { resolveStep8Tolerance } = __test;

test('密码已设 + 2FA 失败且不要求 2FA → 容忍，twoFactorSet=false', () => {
  const partial = {
    passwordSet: true, passwordChanged: true, password: 'Pw!',
    twoFactorSecret: '', twoFactorUri: '', recoveryCodes: [], twoFactorSet: true,
  };
  const r = resolveStep8Tolerance(partial, Boolean(partial.passwordSet));
  assert.ok(r);
  assert.equal(r.twoFactorSet, false);
  assert.equal(r.passwordSet, true);
});

test('密码已设 + 要求 2FA 但无 secret → 不容忍', () => {
  const partial = { passwordSet: true, twoFactorSecret: '', twoFactorUri: '' };
  assert.equal(resolveStep8Tolerance(partial, true, { require2fa: true }), null);
});

test('连密码都没设成 → 不容忍', () => {
  assert.equal(resolveStep8Tolerance({ passwordSet: false }, false), null);
});

test('不要求密码时，未设密码也可容忍（无 2FA）', () => {
  const r = resolveStep8Tolerance({ passwordSet: false }, false, { requirePassword: false });
  assert.ok(r);
  assert.equal(r.twoFactorSet, false);
  assert.equal(r.passwordSet, false);
});

test('不要求密码但要求 2FA 且无 secret → 不容忍', () => {
  assert.equal(resolveStep8Tolerance({ passwordSet: false }, false, { requirePassword: false, require2fa: true }), null);
});

test('2FA 失败但 partial 里已有 secret → 容忍并保留', () => {
  const partial = { passwordSet: false, twoFactorSecret: 'OLD', twoFactorUri: 'otpauth://x' };
  const r = resolveStep8Tolerance(partial, true, { require2fa: true });
  assert.ok(r);
  assert.equal(r.twoFactorSet, true);
  assert.equal(r.twoFactorSecret, 'OLD');
});

test('require2fa 时可从 existingTotpSecret 回填', () => {
  const r = resolveStep8Tolerance({ passwordSet: true }, true, { require2fa: true, existingTotpSecret: 'JBSWY3DPEHPK3PXP' });
  assert.ok(r);
  assert.equal(r.twoFactorSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(r.twoFactorSet, true);
});
