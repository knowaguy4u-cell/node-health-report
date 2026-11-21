'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const html = readFileSync(require.resolve('../index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function browser({ incomplete = false, fail = false, storage = new Map(), checkResponse, checkError, networkFailure = false } = {}) {
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
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const context = vm.createContext({ Pi, localStorage, document: { getElementById: element, createElement: () => ({}) },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/api/check')) {
        if (networkFailure) throw new Error('fixture network failure');
        return { ok: !checkError, json: async () => checkError ? { error: checkError } : checkResponse };
      }
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
  assert.deepEqual(JSON.parse(b.calls[2].body), { purchasePaymentId: 'fixture-payment' });
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


test('frontend sends an empty payout body when no purchase is stored', async () => {
  const b = browser();
  await b.element('signin').click();
  await b.element('payout').click();
  assert.deepEqual(JSON.parse(b.calls[0].body), {});
});

test('frontend remembers the purchase across a reload for the payout body', async () => {
  const storage = new Map();
  const a = browser({ storage });
  await a.element('signin').click();
  await a.element('health-check').click();
  await a.callbacks.onReadyForServerApproval('fixture-payment');
  await a.callbacks.onReadyForServerCompletion('fixture-payment', 'fixture-tx');
  const b = browser({ storage });
  await b.element('signin').click();
  await b.element('payout').click();
  assert.deepEqual(JSON.parse(b.calls[0].body), { purchasePaymentId: 'fixture-payment' });
});

const checkReport = {
  host: 'example.com', checkedAt: '2026-11-20T12:00:00.000Z',
  sections: { status: { level: 'ok', line: 'Your node looks healthy' },
    sync: { level: 'ok', line: 'Your node is 0 ledgers behind the network' },
    ports: { level: 'ok', line: 'All 10 node ports are open' } },
  fixes: [{ title: 'Nothing to fix — run this check weekly', why: 'Healthy.', how: 'Check weekly.' }],
};

async function runCheck(b) {
  b.element('own-node').checked = true;
  b.element('node-host').value = 'example.com';
  b.element('node-ledger').value = '100';
  await b.element('run-form').submit({ preventDefault() {} });
}

test('frontend reveals check after payment, renders results and restores saved history', async () => {
  const storage = new Map();
  const b = browser({ storage, checkResponse: checkReport });
  await b.element('signin').click();
  assert.equal(b.element('run-panel').hidden, true);
  await b.element('health-check').click();
  await b.callbacks.onReadyForServerCompletion('fixture-payment', 'fixture-tx');
  assert.equal(b.element('run-panel').hidden, false);
  await runCheck(b);
  const call = b.calls.at(-1);
  assert.equal(call.url, 'https://node-health-report.vercel.app/api/check');
  assert.equal(call.headers.Authorization, 'Bearer fixture-access-token');
  assert.deepEqual(JSON.parse(call.body), { host: 'example.com', nodeLedger: 100, paymentId: 'fixture-payment' });
  assert.equal(b.element('check-node').textContent, checkReport.sections.status.line);
  assert.equal(b.element('check-sync').textContent, checkReport.sections.sync.line);
  assert.equal(b.element('check-ports').textContent, checkReport.sections.ports.line);
  assert.match(b.element('fixes').children.at(-1).textContent, /weekly/);
  const reloaded = browser({ storage });
  assert.match(reloaded.element('report-history').textContent, /example.com/);
  assert.equal(reloaded.element('check-node').textContent, checkReport.sections.status.line);
  assert.doesNotMatch(storage.get('nhr:lastReport'), /fixture-access-token/);
});

for (const [checkError, expected] of [
  ['no_completed_check', /Buy the full health check first/],
  ['check_too_frequent', /60 seconds/], ['invalid_host', /valid public hostname/],
]) {
  test(`frontend explains ${checkError}`, async () => {
    const b = browser({ checkError }); await b.element('signin').click();
    await runCheck(b);
    assert.match(b.element('check-result').textContent, expected);
    assert.equal(b.element('run-check').disabled, false);
  });
}

test('frontend explains network failures and requires node ownership', async () => {
  const b = browser({ networkFailure: true }); await b.element('signin').click();
  await b.element('run-form').submit({ preventDefault() {} });
  assert.equal(b.calls.length, 0);
  await runCheck(b);
  assert.match(b.element('check-result').textContent, /Check your connection/);
});

test('frontend reveals check panel on sign-in when purchase is already remembered', async () => {
  const storage = new Map([['nhr:lastPurchasePaymentId', 'previous-payment']]);
  const b = browser({ storage });
  await b.element('signin').click();
  assert.equal(b.element('run-panel').hidden, false);
  assert.equal(b.element('report-ready').hidden, false);
});

test('frontend trims whitespace from node host input', async () => {
  const b = browser({ checkResponse: checkReport });
  await b.element('signin').click();
  b.element('own-node').checked = true;
  b.element('node-host').value = '  example.com  ';
  b.element('node-ledger').value = ' 100 ';
  await b.element('run-form').submit({ preventDefault() {} });
  const call = b.calls.at(-1);
  assert.deepEqual(JSON.parse(call.body), { host: 'example.com', nodeLedger: 100 });
});
