import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../cloakbrowser.js';

const {
  isLocalDevProxy,
  shouldUseGeoip,
  effectiveBrowserTimezone,
  resolveTimezone,
} = __test;

test('isLocalDevProxy 识别本机转发代理', () => {
  assert.equal(isLocalDevProxy('http://127.0.0.1:7890'), true);
  assert.equal(isLocalDevProxy('http://localhost:7890'), true);
  assert.equal(isLocalDevProxy('http://user:pass@127.0.0.1:7890'), true);
  assert.equal(isLocalDevProxy('http://gate2.ipweb.cc:7778'), false);
});

test('shouldUseGeoip 住宅代理开 geoip、本机关', () => {
  assert.equal(shouldUseGeoip('http://gate2.ipweb.cc:7778'), true);
  assert.equal(shouldUseGeoip('http://127.0.0.1:7890'), false);
  assert.equal(shouldUseGeoip(''), false);
});

test('effectiveBrowserTimezone 生产代理不交手动时区', () => {
  assert.equal(
    effectiveBrowserTimezone('http://gate2.ipweb.cc:7778', 'America/New_York'),
    null,
  );
  assert.equal(
    effectiveBrowserTimezone('http://127.0.0.1:7890', 'Asia/Tokyo'),
    'Asia/Tokyo',
  );
  assert.equal(resolveTimezone(null, 'ja-JP'), 'Asia/Tokyo');
});
