'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const html = readFileSync(require.resolve('../index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function browser({ incomplete = false, fail = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, disabled: false, textContent: '', children: [],
      addEventListener(event, callback) { this[event] = callback; },
      appendChild(child) { this.children.push(child); },
    });
    return elements.get(id);
  };
  const calls = [];
  let callbacks, paymentData, init;
  const Pi = {
    init(options) { init = options; },
    async authenticate(scopes, callback) {
      assert.deepEqual(Array.from(scopes), ['username', 'payments', 'wallet_address']);
      if (incomplete) await callback({ identifier: 'fixture-payment' });
      return { accessToken: 'fixture-access-token', user: { username: 'fixture-name' } };
    },
    async createPayment(data, handlers) { paymentData = data; callbacks = handlers; },
  };
  const context = vm.createContext({ Pi, document: { getElementById: element, createElement: () => ({}) },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: !fail, json: async () => fail ? { error: 'missing_scope' } : { status: 'completed', healthCheck: 'fulfilled' } };
    },
  });
  vm.runInContext(source, context);
  return { element, calls, get callbacks() { return callbacks; }, get paymentData() { return paymentData; }, get init() { return init; } };
}

test('frontend queues incomplete payment until the token is available', async () => {
  const b = browser({ incomplete: true });
  await b.element('signin').click();
  assert.equal(b.init.sandbox, true);
  assert.equal(b.init.version, '2.0');
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, 'https://node-health-report.vercel.app/api/payments/resume');
  assert.equal(b.calls[0].headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(b.element('report').hidden, false);
  assert.match(b.element('payment-status').children.at(-1).textContent, /completed/);
});

test('frontend wires both U2A callbacks and payout to the absolute backend', async () => {
  const b = browser();
  await b.element('signin').click();
  await b.element('health-check').click();
  assert.equal(b.paymentData.amount, 1);
  assert.equal(b.paymentData.metadata.product, 'full_health_check');
  await b.callbacks.onReadyForServerApproval('fixture-payment');
  await b.callbacks.onReadyForServerCompletion('fixture-payment', 'fixture-tx');
  await b.element('payout').click();
  assert.deepEqual(b.calls.map(c => c.url), [
    'https://node-health-report.vercel.app/api/payments/approve',
    'https://node-health-report.vercel.app/api/payments/complete',
    'https://node-health-report.vercel.app/api/payout',
  ]);
  for (const call of b.calls) assert.equal(call.headers.Authorization, 'Bearer fixture-access-token');
  assert.deepEqual(JSON.parse(b.calls[1].body), { paymentId: 'fixture-payment', txid: 'fixture-tx' });
  assert.deepEqual(JSON.parse(b.calls[2].body), {});
});

test('frontend reports backend failures, cancellation and SDK errors', async () => {
  const b = browser({ fail: true });
  await b.element('signin').click();
  await b.element('health-check').click();
  await b.callbacks.onReadyForServerCompletion('fixture-payment', 'fixture-tx');
  assert.match(b.element('payment-status').children.at(-1).textContent, /Completion pending/);
  b.callbacks.onCancel();
  assert.equal(b.element('health-check').disabled, false);
  b.callbacks.onError(new Error('private SDK internals'));
  assert.doesNotMatch(b.element('payment-status').children.at(-1).textContent, /private/);
  await b.element('payout').click();
  assert.match(b.element('payment-status').children.at(-1).textContent, /Wallet address permission is missing/);
});
