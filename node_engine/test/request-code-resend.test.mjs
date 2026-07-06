import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { requestCodeWithResend } = __test;

class FakeResendPage {
  constructor() {
    this.resendClicks = 0;
  }

  async evaluate(fn) {
    const src = String(fn);
    if (src.includes('wanted') && src.includes('mark')) return '重新发送';
    if (src.includes('requestSubmit') || src.includes('closest')) return false;
    return null;
  }

  locator() {
    const self = this;
    return {
      scrollIntoViewIfNeeded: async () => {},
      click: async () => { self.resendClicks += 1; },
    };
  }
}

test('requestCodeWithResend：首轮成功直接返回', async () => {
  const result = await requestCodeWithResend({}, async () => '123456', () => {}, { purpose: 'login' });
  assert.equal(result.code, '123456');
  assert.equal(result.purpose, 'login');
  assert.equal(result.resendRounds, 0);
});

test('requestCodeWithResend：返回 receivedAt', async () => {
  const result = await requestCodeWithResend({}, async () => ({ code: '123456', receivedAt: '2026-07-01 22:45:38' }), () => {}, { purpose: 'register' });
  assert.equal(result.code, '123456');
  assert.equal(result.receivedAt, '2026-07-01 22:45:38');
});

test('requestCodeWithResend：单轮超时后点重新发送再取码', async () => {
  const page = new FakeResendPage();
  const logs = [];
  let attempts = 0;

  const result = await requestCodeWithResend(page, async () => {
    attempts += 1;
    if (attempts < 2) throw new Error('取码超时（Python 侧未拿到验证码）');
    return { code: '998877', receivedAt: '2026-07-01 23:00:00' };
  }, (msg) => logs.push(msg), { purpose: 'login', maxRounds: 3 });

  assert.equal(result.code, '998877');
  assert.equal(result.receivedAt, '2026-07-01 23:00:00');
  assert.equal(result.resendRounds, 1);
  assert.equal(attempts, 2);
  assert.ok(page.resendClicks >= 1);
  assert.match(logs.join('\n'), /重新发送/);
});

test('requestCodeWithResend：全部轮次失败则抛出最后一次错误', async () => {
  const page = new FakeResendPage();
  await assert.rejects(
    () => requestCodeWithResend(page, async () => { throw new Error('取码超时'); }, () => {}, { maxRounds: 2 }),
    /取码超时/,
  );
});
