import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../flows/openai/register.js';

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  first() { return this; }
  last() { return this; }
  nth() { return this; }

  async count() {
    return this.page.isVisibleSelector(this.selector) ? 1 : 0;
  }

  async waitFor() {
    if (!this.page.isVisibleSelector(this.selector)) throw new Error(`not visible: ${this.selector}`);
  }

  async click() {}
  async fill(value) { this.page.typedCode = String(value); }

  async press(key) {
    if (key === 'Enter') this.page.submitCode();
  }

  async pressSequentially(value) {
    this.page.typedCode = String(value);
  }
}

class FakeMfaPage {
  constructor() {
    this.currentUrl = 'https://auth.openai.com/mfa-challenge/test';
    this.mode = 'totp';
    this.typedCode = '';
    this.submittedCode = '';
    this.logs = [];
  }

  url() { return this.currentUrl; }
  locator(selector) { return new FakeLocator(this, selector); }

  isVisibleSelector(selector) {
    if (selector.includes('#totp_otp') || selector.includes('totp_otp')) return this.mode === 'totp';
    if (selector.includes('input[name="code"]') || selector.includes('one-time-code') || selector.includes('inputmode="numeric"')) {
      return this.mode === 'email-code';
    }
    if (selector.includes('input[maxlength="1"]')) return false;
    return false;
  }

  async click(selector) {
    if (selector.includes('data-reg-click')) this.mode = 'email-code';
  }

  async keyboardType(value) {
    this.typedCode = String(value);
  }

  get keyboard() {
    return { type: (value) => this.keyboardType(value) };
  }

  async waitForFunction() {
    return false;
  }

  async evaluate(fn) {
    const source = String(fn);
    if (source.includes('querySelectorAll') && source.includes('wanted') && source.includes('mark')) {
      return this.mode === 'totp' ? 'email a code' : null;
    }
    if (source.includes('check your inbox') || source.includes('verification code')) {
      return this.mode === 'email-code';
    }
    if (source.includes('mfa-challenge') || source.includes('totp_otp')) {
      return this.mode === 'totp' || this.mode === 'email-code';
    }
    if (source.includes('invalid') || source.includes('incorrect')) return false;
    if (source.includes('requestSubmit')) {
      this.submitCode();
      return undefined;
    }
    return false;
  }

  submitCode() {
    if (this.mode === 'email-code') {
      this.submittedCode = this.typedCode;
      this.currentUrl = 'https://chatgpt.com/';
      this.mode = 'done';
    }
  }
}

test('MFA without stored TOTP can use email verification fallback', async () => {
  const page = new FakeMfaPage();
  const codeRequests = [];
  const logs = [];

  const handled = await __test.handleLoginTotpPrompt(
    page,
    '',
    async (purpose) => {
      codeRequests.push(purpose);
      return '123456';
    },
    (message) => logs.push(message),
  );

  assert.equal(handled, true);
  assert.deepEqual(codeRequests, ['login']);
  assert.equal(page.submittedCode, '123456');
  assert.match(logs.join('\n'), /邮箱|email/i);
});
