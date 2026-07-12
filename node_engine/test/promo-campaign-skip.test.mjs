import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

const { isPromoCampaignUrl, skipPromoCampaignLanding } = __test;

test('isPromoCampaignUrl 只识别 chatgpt.com 上的 promo_campaign', () => {
  assert.equal(isPromoCampaignUrl('https://chatgpt.com/?promo_campaign=plus-1-month-free'), true);
  assert.equal(isPromoCampaignUrl('https://chatgpt.com/'), false);
  assert.equal(isPromoCampaignUrl('https://auth.openai.com/log-in?promo_campaign=x'), false);
  assert.equal(isPromoCampaignUrl(''), false);
});

test('skipPromoCampaignLanding 去掉 promo 参数，只跳转一次', async () => {
  const logs = [];
  const gotoUrls = [];
  let current = 'https://chatgpt.com/?promo_campaign=plus-1-month-free';
  const page = {
    url: () => current,
    goto: async (url) => {
      gotoUrls.push(url);
      if (url === 'https://chatgpt.com/') {
        current = 'https://chatgpt.com/?promo_campaign=plus-1-month-free';
        return;
      }
      current = url;
    },
  };

  const changed = await skipPromoCampaignLanding(page, (msg) => logs.push(msg));
  assert.equal(changed, true);
  assert.deepEqual(gotoUrls, ['https://chatgpt.com/']);
  assert.equal(current, 'https://chatgpt.com/?promo_campaign=plus-1-month-free');
  assert.match(logs.join('\n'), /plus-1-month-free/);
});

test('skipPromoCampaignLanding 已是正常首页时不导航', async () => {
  let gotoCount = 0;
  const page = {
    url: () => 'https://chatgpt.com/',
    goto: async () => { gotoCount += 1; },
  };
  const changed = await skipPromoCampaignLanding(page, () => {});
  assert.equal(changed, false);
  assert.equal(gotoCount, 0);
});
