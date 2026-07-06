import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_PASSWORD_MASK_PATTERN,
  SETTINGS_PASSWORD_ROW_PATTERN,
  SETTINGS_PASSWORD_MANAGE_BTN_PATTERN,
} from '../flows/openai/selectors.js';

const maskRe = new RegExp(SETTINGS_PASSWORD_MASK_PATTERN, 'i');
const rowRe = new RegExp(SETTINGS_PASSWORD_ROW_PATTERN, 'i');
const manageRe = new RegExp(SETTINGS_PASSWORD_MANAGE_BTN_PATTERN, 'i');

test('日文安全页：パスワード ****** 识别为已有密码', () => {
  assert.match('パスワード ******', maskRe);
  assert.match('パスワード ******', rowRe);
});

test('日文编辑按钮 編集する 识别为管理操作', () => {
  assert.match('編集する', manageRe);
});

test('中文/英文掩码仍有效', () => {
  assert.match('密码 ******', maskRe);
  assert.match('password ******', maskRe);
});
