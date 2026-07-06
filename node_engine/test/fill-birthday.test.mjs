import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { fillBirthday } = __test;

function mockAgePage({ initial = '', acceptFill = true } = {}) {
  let value = initial;
  const logs = [];
  const loc = {
    async click() {},
    async fill(v) {
      if (acceptFill) value = String(v);
    },
    async pressSequentially(v) {
      if (acceptFill) value = String(v);
    },
    async inputValue() {
      return value;
    },
  };
  const page = {
    logs,
    async evaluate(fn, args) {
      if (typeof fn === 'function' && fn.toString().includes('input[name="age"]')) {
        if (args?.a != null) {
          value = String(args.a);
          return true;
        }
      }
      // kind detection: age input visible
      return 'age';
    },
    locator() {
      return {
        first: () => loc,
      };
    },
  };
  return { page, getValue: () => value, logs };
}

test('fillBirthday age：fill 成功读回', async () => {
  const { page, getValue, logs } = mockAgePage();
  const ok = await fillBirthday(page, { year: 1996, month: 7, day: 6 }, (msg) => logs.push(msg));
  assert.equal(ok, true);
  assert.equal(getValue(), String(Math.max(18, new Date().getFullYear() - 1996)));
});

test('fillBirthday age：fill 失败时 native 兜底', async () => {
  const { page, getValue, logs } = mockAgePage({ acceptFill: false });
  const ok = await fillBirthday(page, { year: 1996, month: 7, day: 6 }, (msg) => logs.push(msg));
  assert.equal(ok, true);
  assert.notEqual(getValue(), '');
});

test('fillBirthday age：全部失败返回 false', async () => {
  const page = {
    logs: [],
    async evaluate(fn) {
      if (fn.toString().includes('spinbutton')) return 'none';
      return 'age';
    },
    locator() {
      return {
        first: () => ({
          click: async () => {},
          fill: async () => {},
          pressSequentially: async () => {},
          inputValue: async () => '',
        }),
      };
    },
  };
  const ok = await fillBirthday(page, { year: 1996, month: 7, day: 6 }, () => {});
  assert.equal(ok, false);
});
