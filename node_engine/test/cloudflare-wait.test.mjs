import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { isCloudflareChallengePage, waitForCloudflareClear } = __test;

function mockPage({ blocked = true, stuck = false, afterReload = false } = {}) {
  let reloads = 0;
  let blockedNow = blocked;
  return {
    reloads: () => reloads,
    page: {
      evaluate: async (fn) => {
        if (fn.toString().includes('応答を待っています')) return stuck && blockedNow;
        if (fn.toString().includes('cf-turnstile-response')) return blockedNow;
        return blockedNow;
      },
      reload: async () => {
        reloads += 1;
        if (afterReload) blockedNow = false;
      },
    },
  };
}

test('isCloudflareChallengePage 通过 evaluate 探测', async () => {
  const yes = { evaluate: async () => true };
  const no = { evaluate: async () => false };
  assert.equal(await isCloudflareChallengePage(yes), true);
  assert.equal(await isCloudflareChallengePage(no), false);
});

test('waitForCloudflareClear 已离开挑战页立即返回', async () => {
  const { page } = mockPage({ blocked: false });
  assert.equal(await waitForCloudflareClear(page, { timeoutMs: 3000 }), true);
});

test('waitForCloudflareClear 卡住后 reload 可恢复', async () => {
  const { page, reloads } = mockPage({ blocked: true, stuck: true, afterReload: true });
  const ok = await waitForCloudflareClear(page, { timeoutMs: 50000, log: () => {} });
  assert.equal(ok, true);
  assert.equal(reloads(), 1);
});
