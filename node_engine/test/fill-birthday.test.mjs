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
    keyboard: {
      async press() {},
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
    keyboard: { async press() {} },
  };
  const ok = await fillBirthday(page, { year: 1996, month: 7, day: 6 }, () => {});
  assert.equal(ok, false);
});

/**
 * spinbutton mock：模拟 RA DateField 读回。
 * - kind 检测返回 spinbutton
 * - 首次读回为空（旧路径会假成功），写入后读回完整日期
 */
function mockSpinPage({
  failAttempts = 0,
  /** 写入后 hidden birthday 是否同步 */
  syncHidden = true,
} = {}) {
  let writes = 0;
  let committed = null; // {y,m,d} after successful fill
  const typed = { day: '', month: '', year: '' };
  const logs = [];

  const page = {
    logs,
    keyboard: {
      async press() {},
    },
    async evaluate(fn) {
      const src = typeof fn === 'function' ? fn.toString() : '';
      // kind detection loop
      if (src.includes("return 'spinbutton'") || src.includes('data-type="year"')) {
        // first evaluate in fillBirthday is kind detector
        if (src.includes("return 'age'") && src.includes("return 'spinbutton'")) {
          return 'spinbutton';
        }
      }
      if (src.includes('data-placeholder') && src.includes('aria-valuenow')) {
        // readSpin
        if (!committed) {
          return {
            day: { present: true, value: null, placeholder: true },
            month: { present: true, value: null, placeholder: true },
            year: { present: true, value: null, placeholder: true },
            birthday: '',
          };
        }
        const { y, m, d } = committed;
        const birthday = syncHidden
          ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          : '';
        return {
          day: { present: true, value: d, placeholder: false },
          month: { present: true, value: m, placeholder: false },
          year: { present: true, value: y, placeholder: false },
          birthday,
        };
      }
      // blur evaluate
      return undefined;
    },
    locator(sel) {
      const type = /data-type="(day|month|year)"/.exec(sel)?.[1] || 'day';
      return {
        first: () => ({
          async count() { return 1; },
          async click() {},
          async pressSequentially(text) {
            typed[type] = String(text);
            writes += 1;
            // After a full order (3 segments), maybe commit
            if (typed.day && typed.month && typed.year) {
              if (failAttempts > 0) {
                failAttempts -= 1;
                typed.day = '';
                typed.month = '';
                typed.year = '';
                committed = null;
                return;
              }
              committed = {
                y: Number(typed.year),
                m: Number(typed.month),
                d: Number(typed.day),
              };
            }
          },
        }),
      };
    },
  };
  return {
    page,
    logs,
    getCommitted: () => committed,
    getWrites: () => writes,
  };
}

test('fillBirthday spinbutton：补零写入 + 读回成功', async () => {
  const { page, logs, getCommitted } = mockSpinPage();
  const ok = await fillBirthday(page, { year: 1997, month: 11, day: 6 }, (msg, lvl) => logs.push({ msg, lvl }));
  assert.equal(ok, true);
  assert.deepEqual(getCommitted(), { y: 1997, m: 11, d: 6 });
  assert.ok(logs.some((l) => String(l.msg || l).includes('已填写生日 1997-11-06')));
});

test('fillBirthday spinbutton：读回失败则 return false（不再假成功）', async () => {
  const { page, logs } = mockSpinPage({ failAttempts: 99 });
  const ok = await fillBirthday(page, { year: 1997, month: 11, day: 6 }, (msg, lvl) => logs.push({ msg, lvl }));
  assert.equal(ok, false);
  assert.ok(logs.some((l) => String(l.msg || l).includes('读回失败')));
});

test('fillBirthday spinbutton：前两次失败第三次读回成功', async () => {
  const { page, logs, getCommitted } = mockSpinPage({ failAttempts: 2 });
  const ok = await fillBirthday(page, { year: 1997, month: 11, day: 6 }, (msg, lvl) => logs.push({ msg, lvl }));
  assert.equal(ok, true);
  assert.deepEqual(getCommitted(), { y: 1997, m: 11, d: 6 });
  assert.ok(logs.some((l) => String(l.msg || l).includes('attempt=3')));
});
