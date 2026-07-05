import test from 'node:test';
import assert from 'node:assert/strict';

import { __test, PAGE_STATE } from '../flows/openai/auth-state.js';

const { classifyState, isLoggedInUrl, normalizePredicate } = __test;

// classifyState 是纯函数：喂原始 signals（含 url），返回 {pageState, accountFacts, confidence, ...}。
// 判据分层从最确定到最模糊，这里逐个 pageState 验证命中与优先级。

test('MFA_TOTP：mfa-challenge URL 或 totp 输入框命中', () => {
  assert.equal(classifyState({ url: 'https://auth.openai.com/mfa-challenge/abc' }).pageState, PAGE_STATE.MFA_TOTP);
  assert.equal(classifyState({ url: 'https://auth.openai.com/x', hasTotp: true }).pageState, PAGE_STATE.MFA_TOTP);
});

test('MFA_EMAIL：mfa-challenge 但已切邮箱模式（有邮箱提示+码框，无 totp）不误判为 TOTP', () => {
  const st = classifyState({
    url: 'https://auth.openai.com/mfa-challenge/abc',
    mfaEmailHint: true, hasCode: true, hasTotp: false,
  });
  assert.equal(st.pageState, PAGE_STATE.MFA_EMAIL);
});

test('RESET_PASSWORD：reset-password URL', () => {
  assert.equal(classifyState({ url: 'https://auth.openai.com/reset-password' }).pageState, PAGE_STATE.RESET_PASSWORD);
});

test('EMAIL_CODE：email-verification URL（高置信）或 码框+收件箱提示（中置信）', () => {
  const a = classifyState({ url: 'https://auth.openai.com/email-verification' });
  assert.equal(a.pageState, PAGE_STATE.EMAIL_CODE);
  assert.equal(a.confidence, 'high');
  const b = classifyState({ url: 'https://auth.openai.com/x', hasCode: true, checkInbox: true });
  assert.equal(b.pageState, PAGE_STATE.EMAIL_CODE);
  assert.equal(b.confidence, 'medium');
});

test('EXISTING_PASSWORD_LOGIN：log-in/password URL，或密码框+忘记密码/欢迎回来文案', () => {
  assert.equal(
    classifyState({ url: 'https://auth.openai.com/log-in/password', hasPassword: true }).pageState,
    PAGE_STATE.EXISTING_PASSWORD_LOGIN,
  );
  assert.equal(
    classifyState({ url: 'https://auth.openai.com/log-in', hasPassword: true, forgotOrWelcomeBack: true }).pageState,
    PAGE_STATE.EXISTING_PASSWORD_LOGIN,
  );
});

test('SETTINGS_SECURITY：onSecurity 时才产出 accountFacts（passwordSet/mfaEnabled）', () => {
  const st = classifyState({ url: 'https://chatgpt.com/#settings', onSecurity: true, passwordSet: true, mfaEnabled: false });
  assert.equal(st.pageState, PAGE_STATE.SETTINGS_SECURITY);
  assert.deepEqual(st.accountFacts, { passwordSet: true, mfaEnabled: false });
});

test('accountFacts 在非设置页恒为 null（不臆测账号事实）', () => {
  const st = classifyState({ url: 'https://auth.openai.com/log-in/password', hasPassword: true, passwordSet: true });
  assert.deepEqual(st.accountFacts, { passwordSet: null, mfaEnabled: null });
});

test('NEW_NEEDS_PROFILE：资料输入框', () => {
  assert.equal(
    classifyState({ url: 'https://auth.openai.com/create-account', hasProfile: true }).pageState,
    PAGE_STATE.NEW_NEEDS_PROFILE,
  );
});

test('NEW_NEEDS_PASSWORD：创建密码页（密码框 + 注册相关 URL）', () => {
  assert.equal(
    classifyState({ url: 'https://auth.openai.com/create-account/password', hasPassword: true }).pageState,
    PAGE_STATE.NEW_NEEDS_PASSWORD,
  );
});

test('LOGGED_IN：chatgpt.com 干净 URL + 主界面文案（高置信）', () => {
  const st = classifyState({ url: 'https://chatgpt.com/', success: true });
  assert.equal(st.pageState, PAGE_STATE.LOGGED_IN);
  assert.equal(st.confidence, 'high');
  assert.equal(st.evidence.tokenLikely, true);
});

test('NEW_EMAIL_ENTRY：邮箱框（非登录态 URL）', () => {
  assert.equal(
    classifyState({ url: 'https://auth.openai.com/', hasEmail: true }).pageState,
    PAGE_STATE.NEW_EMAIL_ENTRY,
  );
});

test('UNKNOWN：无信号 / DOM 读取失败 → 低置信，编排器应继续轮询', () => {
  assert.equal(classifyState({}).pageState, PAGE_STATE.UNKNOWN);
  const err = classifyState({ evalError: 'boom' });
  assert.equal(err.pageState, PAGE_STATE.UNKNOWN);
  assert.equal(err.confidence, 'low');
});

test('isLoggedInUrl：只认 https 的 chatgpt.com 且非 auth/log-in/create 路径', () => {
  assert.equal(isLoggedInUrl('https://chatgpt.com/'), true);
  assert.equal(isLoggedInUrl('https://chatgpt.com/c/abc'), true);
  assert.equal(isLoggedInUrl('https://auth.openai.com/log-in'), false);
  assert.equal(isLoggedInUrl('https://chatgpt.com/auth/login'), false);
  assert.equal(isLoggedInUrl('http://chatgpt.com/'), false);
});

test('normalizePredicate：字符串 / 数组 / 函数三种形态', () => {
  const p1 = normalizePredicate(PAGE_STATE.LOGGED_IN);
  assert.equal(p1({ pageState: PAGE_STATE.LOGGED_IN }), true);
  assert.equal(p1({ pageState: PAGE_STATE.UNKNOWN }), false);
  const p2 = normalizePredicate([PAGE_STATE.EMAIL_CODE, PAGE_STATE.MFA_TOTP]);
  assert.equal(p2({ pageState: PAGE_STATE.MFA_TOTP }), true);
  const p3 = normalizePredicate((s) => s.confidence === 'high');
  assert.equal(p3({ confidence: 'high' }), true);
});
