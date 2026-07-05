import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { isChromeErrorUrl, recoverFromChromeError } = __test;

test('isChromeErrorUrl 识别浏览器加载错误页，放过正常页', () => {
  assert.equal(isChromeErrorUrl('chrome-error://chromewebdata/'), true);
  assert.equal(isChromeErrorUrl('about:neterror?e=dnsNotFound'), true);
  assert.equal(isChromeErrorUrl('https://auth.openai.com/mfa-challenge/email-otp'), false);
  assert.equal(isChromeErrorUrl('https://chatgpt.com/'), false);
  assert.equal(isChromeErrorUrl(''), false);
  assert.equal(isChromeErrorUrl(null), false);
});

// 错误页：reload 后恢复到真实 URL → 返回 true 且只 reload 一次
test('recoverFromChromeError 在错误页刷新一次即恢复', async () => {
  const logs = [];
  let reloads = 0;
  const urls = ['chrome-error://chromewebdata/', 'https://auth.openai.com/mfa-challenge/email-otp'];
  const page = {
    url: () => urls[Math.min(reloads, urls.length - 1)],
    reload: async () => { reloads += 1; },
  };
  const did = await recoverFromChromeError(page, (m, lvl) => logs.push([lvl, m]), { max: 3 });
  assert.equal(did, true);
  assert.equal(reloads, 1);
  assert.match(logs.map((l) => l[1]).join('\n'), /浏览器加载错误页/);
});

// 正常页：不刷新，返回 false
test('recoverFromChromeError 正常页不刷新', async () => {
  let reloads = 0;
  const page = {
    url: () => 'https://chatgpt.com/',
    reload: async () => { reloads += 1; },
  };
  const did = await recoverFromChromeError(page, () => {}, { max: 3 });
  assert.equal(did, false);
  assert.equal(reloads, 0);
});

// 持续错误页：reload 无效时不超过 max 次，仍返回 true（交给上层判失败）
test('recoverFromChromeError 持续错误页最多刷新 max 次', async () => {
  let reloads = 0;
  const page = {
    url: () => 'chrome-error://chromewebdata/',
    reload: async () => { reloads += 1; },
  };
  const did = await recoverFromChromeError(page, () => {}, { max: 2 });
  assert.equal(did, true);
  assert.equal(reloads, 2);
});
