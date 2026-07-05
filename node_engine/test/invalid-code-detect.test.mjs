import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFIED_INVALID_CODE_MESSAGES,
  textIndicatesInvalidCode,
  detectInvalidCode,
} from '../flows/openai/code-errors.js';

/** 最小 page mock：evaluate 在 Node 侧执行传入的 fn（与 Playwright 行为一致）。 */
function mockPage({ body = '', codeInvalid = false, alertText = '' } = {}) {
  return {
    async evaluate(fn, args) {
      const doc = {
        body: { innerText: body },
        querySelectorAll(sel) {
          const nodes = [];
          if (sel.includes('input') || sel.includes('totp')) {
            nodes.push({
              getBoundingClientRect: () => ({ width: 100, height: 40 }),
              getAttribute: (n) => (n === 'aria-invalid' && codeInvalid ? 'true' : null),
            });
          }
          if (sel.includes('role="alert"') || sel.includes('aria-live')) {
            if (alertText) {
              nodes.push({
                getBoundingClientRect: () => ({ width: 200, height: 20 }),
                innerText: alertText,
                textContent: alertText,
              });
            }
          }
          return nodes;
        },
        querySelector() { return null; },
      };
      globalThis.document = doc;
      globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
      return fn(args);
    },
  };
}

test('VERIFIED_INVALID_CODE_MESSAGES 覆盖 zh / en / ja 实测文案', () => {
  const texts = VERIFIED_INVALID_CODE_MESSAGES.map((m) => m.text);
  assert.ok(texts.some((t) => /Incorrect code/i.test(t)), 'en');
  assert.ok(texts.some((t) => /验证码错误|代码不正确/.test(t)), 'zh-CN');
  assert.ok(texts.some((t) => /コードが正しくありません|不正確なコード/.test(t)), 'ja-JP');
});

for (const { text, source } of VERIFIED_INVALID_CODE_MESSAGES) {
  test(`textIndicatesInvalidCode: ${source}`, () => {
    assert.ok(textIndicatesInvalidCode(`前缀 ${text} 后缀`), text);
  });
}

test('textIndicatesInvalidCode：无关文案不误判', () => {
  assert.equal(textIndicatesInvalidCode('检查你的收件箱'), false);
  assert.equal(textIndicatesInvalidCode('Enter the code we sent'), false);
});

test('detectInvalidCode：body 命中 zh 验证码错误', async () => {
  const page = mockPage({ body: '验证码错误\n请重试' });
  assert.equal(await detectInvalidCode(page), true);
});

test('detectInvalidCode：body 命中 en Incorrect code', async () => {
  const page = mockPage({ body: 'Incorrect code' });
  assert.equal(await detectInvalidCode(page), true);
});

test('detectInvalidCode：body 命中 ja コードが正しくありません', async () => {
  const page = mockPage({ body: 'コードが正しくありません。もう一度お試しください。' });
  assert.equal(await detectInvalidCode(page), true);
});

test('detectInvalidCode：aria-invalid=true 无文案也判定错误', async () => {
  const page = mockPage({ body: '', codeInvalid: true });
  assert.equal(await detectInvalidCode(page), true);
});

test('detectInvalidCode：role=alert 区域命中', async () => {
  const page = mockPage({ body: '', alertText: 'OTP 验证码无效。请重试。' });
  assert.equal(await detectInvalidCode(page), true);
});

test('detectInvalidCode：正常收码页不误判', async () => {
  const page = mockPage({ body: '检查你的收件箱\n输入验证码' });
  assert.equal(await detectInvalidCode(page), false);
});
