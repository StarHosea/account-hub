import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { fillCode } = __test;

// 假分格 OTP 页：keyboard.type 写入当前聚焦格并 auto-advance；dropOnce 模拟组件在某格吞掉一个
// 字符并错误跳格（真实 bug 901755→90755 的成因）。evaluate 读回各格拼接值（对应 readSegments）。
function mockOtpPage({ dropOnce = false, cells = 6 } = {}) {
  const buf = Array.from({ length: cells }, () => '');
  let focus = 0;
  let dropped = false;
  const seg = {
    async count() { return buf.length; },
    nth(i) {
      return {
        async click() { focus = i; },
        async press(k) { if (k === 'Backspace') buf[i] = ''; },
      };
    },
  };
  return {
    _value: () => buf.join(''),
    locator() { return seg; },
    keyboard: {
      async type(ch) {
        if (dropOnce && !dropped && focus === 2) { dropped = true; focus += 1; return; } // 吞字符 + 错误跳格
        buf[focus] = ch;
        focus += 1;
      },
    },
    async evaluate() { return buf.join(''); },
    url() { return 'https://auth.openai.com/email-verification'; },
  };
}

test('分格验证码正常填入 → 读回校验通过', async () => {
  const page = mockOtpPage();
  const logs = [];
  await fillCode(page, '901755', (m) => logs.push(m));
  assert.equal(page._value(), '901755');
  assert.match(logs.join('\n'), /读回校验通过/);
});

test('首轮丢字符（901755→90755）被读回校验发现并自动重填修正', async () => {
  const page = mockOtpPage({ dropOnce: true });
  const logs = [];
  await fillCode(page, '901755', (m) => logs.push(m));
  assert.equal(page._value(), '901755', '重填后应为完整 6 位验证码');
  assert.match(logs.join('\n'), /校验不符/);
  assert.match(logs.join('\n'), /填入「90755」/);
});

test('空验证码 → 跳过填码、不抛异常', async () => {
  const page = mockOtpPage();
  const logs = [];
  await fillCode(page, '', (m) => logs.push(m));
  assert.match(logs.join('\n'), /验证码为空/);
  assert.equal(page._value(), '');
});

test('验证码含空白 → 先清洗再填', async () => {
  const page = mockOtpPage();
  const logs = [];
  await fillCode(page, ' 90 17 55 ', (m) => logs.push(m));
  assert.equal(page._value(), '901755');
});
