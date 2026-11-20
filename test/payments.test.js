'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPiClient, PI_API_BASE } = require('../api/_lib/pi');
const { createPayments } = require('../api/_lib/payments');
const { createLedger, HORIZON } = require('../api/_lib/stellar');
const { MemoryStore } = require('../api/_lib/store');
const { handler } = require('../api/_lib/http');
const { HttpError } = require('../api/_lib/errors');

// Synthetic fixture identities only. No real access token, API key, or seed is used.
const user = () => ({ uid: 'fixture-user', wallet_address: 'fixture-wallet', credentials: { scopes: ['wallet_address'] } });
const payment = (overrides = {}) => ({
  identifier: 'fixture-payment', user_uid: 'fixture-user', direction: 'user_to_app',
  amount: 1, network: 'Pi Testnet', metadata: { product: 'full_health_check' },
  from_address: 'fixture-app-wallet', to_address: 'fixture-wallet',
  status: { developer_approved: false, developer_completed: false, transaction_verified: false },
  transaction: null, ...overrides,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(overrides = {}) {
  const store = new MemoryStore();
  let current = payment(overrides);
  let identity = user();
  let createCalls = 0, approveCalls = 0, completeCalls = 0, submitCalls = 0, prepareCalls = 0;
  let crash = null, chainTx = null, ongoing = [];
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url.startsWith(PI_API_BASE)) {
      const path = url.slice(PI_API_BASE.length);
      if (path === '/me') {
        assert.match(options.headers.Authorization, /^Bearer /);
        return json(identity);
      }
      assert.match(options.headers.Authorization, /^Key /);
      if (path === '/payments/incomplete_server_payments') return json({ incomplete_server_payments: ongoing });
      if (path === '/payments' && options.method === 'POST') {
        createCalls++;
        const data = JSON.parse(options.body).payment;
        assert.equal(data.uid, user().uid);
        assert.equal(data.amount, 0.5);
        current = payment({ ...data, user_uid: data.uid, direction: 'app_to_user', status: { developer_approved: true } });
        ongoing = [current];
        if (crash === 'create') { crash = null; throw new Error('simulated lost create response'); }
        return json(current);
      }
      if (path.endsWith('/approve')) {
        approveCalls++;
        current.status.developer_approved = true;
        return json(current);
      }
      if (path.endsWith('/complete')) {
        completeCalls++;
        if (crash === 'before_complete') { crash = null; throw new Error('simulated unavailable complete'); }
        const { txid } = JSON.parse(options.body);
        current.transaction = { txid, verified: true };
        Object.assign(current.status, { developer_completed: true, transaction_verified: true });
        ongoing = [];
        if (crash === 'after_complete') { crash = null; throw new Error('simulated lost completion response'); }
        return json(current);
      }
      if (path.startsWith('/payments/')) return json(current);
    }
    if (url === HORIZON + '/transactions/fixture-tx') return chainTx ? json(chainTx) : json({}, 404);
    if (url === HORIZON + '/transactions' && options.method === 'POST') {
      submitCalls++;
      assert.equal(new URLSearchParams(options.body).get('tx'), 'fixture-envelope');
      chainTx = { hash: 'fixture-tx', successful: true };
      if (crash === 'submit') { crash = null; throw new Error('simulated lost submission response'); }
      return json(chainTx);
    }
    throw new Error('Unexpected fixture URL');
  };
  const pi = createPiClient({ fetchImpl, env: { PI_NETWORK_API_KEY: 'fixture-api-credential' } });
  const ledger = createLedger({ fetchImpl, env: {} });
  // Signing requires the external SDK. Only the envelope builder is replaced;
  // production Horizon lookup / submission and the Pi client use mocked fetch.
  ledger.prepare = async () => {
    prepareCalls++;
    return { xdr: 'fixture-envelope', txid: 'fixture-tx' };
  };
  const service = () => createPayments({ pi, ledger, store });
  return {
    store, pi, ledger, service, requests,
    get current() { return current; },
    set current(value) { current = value; },
    set identity(value) { identity = value; },
    set crash(value) { crash = value; },
    set ongoing(value) { ongoing = value; },
    counts: () => ({ createCalls, approveCalls, completeCalls, submitCalls, prepareCalls }),
  };
}

const approval = { paymentId: 'fixture-payment', accessToken: 'fixture-access-token' };
const completion = { ...approval, txid: 'fixture-tx' };
const payout = { accessToken: 'fixture-access-token', amount: 100, uid: 'attacker', wallet_address: 'attacker' };

test('approve rejects wrong amount before approval', async () => {
  const f = fixture({ amount: 2 });
  await assert.rejects(f.service().approve(approval), { code: 'wrong_amount', status: 400 });
  assert.equal(f.counts().approveCalls, 0);
});

test('approve rejects wrong product before approval', async () => {
  const f = fixture({ metadata: { product: 'different' } });
  await assert.rejects(f.service().approve(approval), { code: 'wrong_product' });
  assert.equal(f.counts().approveCalls, 0);
});

for (const [field, value, code] of [
  ['user_uid', 'another-user', 'payment_owner_mismatch'],
  ['direction', 'app_to_user', 'wrong_direction'],
  ['network', 'Pi Network', 'wrong_network'],
  ['status', { cancelled: true }, 'payment_cancelled'],
]) {
  test(`approve rejects invalid ${field}`, async () => {
    const f = fixture({ [field]: value });
    await assert.rejects(f.service().approve(approval), { code });
    assert.equal(f.counts().approveCalls, 0);
  });
}

test('re-approve is idempotent and persists state', async () => {
  const f = fixture();
  assert.equal((await f.service().approve(approval)).status, 'approved');
  assert.equal((await f.service().approve(approval)).status, 'approved');
  assert.equal(f.counts().approveCalls, 1);
  assert.equal((await f.store.get('payment:fixture-payment')).status, 'approved');
});

test('complete is idempotent and fulfills exactly once', async () => {
  const f = fixture();
  await f.service().approve(approval);
  assert.equal((await f.service().complete(completion)).healthCheck, 'fulfilled');
  await f.service().complete(completion);
  await f.service().approve(approval);
  assert.equal(f.counts().completeCalls, 1);
  assert.equal((await f.store.get('payment:fixture-payment')).fulfillmentCount, 1);
});

test('complete revalidates price and ownership even with no local approval record', async () => {
  const f = fixture({ amount: 5, status: { developer_approved: true } });
  await assert.rejects(f.service().complete(completion), { code: 'wrong_amount' });
  assert.equal(f.counts().completeCalls, 0);
});

test('complete refuses mismatched txid and unapproved payment', async () => {
  const f = fixture();
  await assert.rejects(f.service().complete(completion), { code: 'payment_not_approved' });
  f.current.transaction = { txid: 'other-tx' };
  await assert.rejects(f.service().complete(completion), { code: 'txid_mismatch' });
});

test('lost completion response reconciles without second completion or fulfillment', async () => {
  const f = fixture();
  await f.service().approve(approval);
  f.crash = 'after_complete';
  await assert.rejects(f.service().complete(completion));
  assert.equal((await f.service().complete(completion)).status, 'completed');
  assert.equal(f.counts().completeCalls, 1);
  assert.equal((await f.store.get('payment:fixture-payment')).fulfillmentCount, 1);
});

test('resume ignores forged SDK flags, txid and amount and uses Pi state', async () => {
  const f = fixture({ transaction: { txid: 'fixture-tx', verified: true } });
  const result = await f.service().resume({ accessToken: approval.accessToken, payment: {
    identifier: 'fixture-payment', amount: 99, transaction: { txid: 'forged' }, status: { developer_completed: true },
  } });
  assert.equal(result.healthCheck, 'fulfilled');
  assert.equal(f.counts().approveCalls, 1);
  assert.equal(f.counts().completeCalls, 1);
});

test('resume waits for user transaction when none exists', async () => {
  const f = fixture();
  assert.equal((await f.service().resume({ accessToken: approval.accessToken, payment: { identifier: 'fixture-payment' } })).status,
    'awaiting_user_transaction');
  assert.equal(f.counts().completeCalls, 0);
});

test('payout is fixed and once per user, ignoring browser values', async () => {
  const f = fixture();
  assert.equal((await f.service().payout(payout)).status, 'completed');
  assert.equal((await f.service().payout(payout)).status, 'completed');
  assert.deepEqual(f.counts(), { createCalls: 1, approveCalls: 0, completeCalls: 1, submitCalls: 1, prepareCalls: 1 });
  assert.equal((await f.store.get('payout:fixture-user')).xdr, null);
});

test('payout missing_scope when wallet address is absent', async () => {
  const f = fixture();
  f.identity = { ...user(), wallet_address: undefined };
  await assert.rejects(f.service().payout(payout), { code: 'missing_scope', status: 403 });
  assert.equal(f.counts().createCalls, 0);
});

test('payout missing_scope when wallet permission is absent', async () => {
  const f = fixture();
  f.identity = { ...user(), credentials: { scopes: [] } };
  await assert.rejects(f.service().payout(payout), { code: 'missing_scope' });
});

test('payout falls back to the completed purchase sender when /me has no wallet address', async () => {
  const f = fixture({ from_address: 'fixture-wallet', to_address: 'fixture-app-wallet' });
  f.identity = { uid: 'fixture-user', credentials: { scopes: ['username', 'payments', 'wallet_address'] } };
  await f.service().approve(approval);
  await f.service().complete(completion);
  assert.equal(await f.store.get('user-payment:fixture-user'), 'fixture-payment');
  assert.equal((await f.service().payout(payout)).status, 'completed');
  assert.equal(f.counts().createCalls, 1);
  assert.equal(f.counts().prepareCalls, 1);
  assert.equal(f.counts().submitCalls, 1);
});

test('payout fallback refuses a purchase that is not completed', async () => {
  const f = fixture();
  f.identity = { uid: 'fixture-user', credentials: { scopes: ['username', 'payments', 'wallet_address'] } };
  await f.store.set('user-payment:fixture-user', 'fixture-payment');
  await assert.rejects(f.service().payout(payout), { code: 'missing_scope', status: 403 });
  assert.equal(f.counts().createCalls, 0);
});

test('payout refuses when the A2U destination differs from the proven recipient', async () => {
  const f = fixture({ from_address: 'fixture-wallet', to_address: 'fixture-app-wallet' });
  await f.service().approve(approval);
  await f.service().complete(completion);
  f.identity = { uid: 'fixture-user', credentials: { scopes: ['username', 'payments', 'wallet_address'] } };
  const purchase = structuredClone(f.current);
  const getPayment = f.pi.getPayment.bind(f.pi);
  // This scenario has two records; preserve the purchase when the fixture switches to A2U.
  f.pi.getPayment = async id => id === purchase.identifier ? purchase : getPayment(id);
  const alien = payment({ identifier: 'alien-payment', direction: 'app_to_user',
    amount: 0.5, metadata: { product: 'test_payout' },
    from_address: 'fixture-app-wallet', to_address: 'someone-else',
    status: { developer_approved: true } });
  f.current = alien; f.ongoing = [alien];
  await assert.rejects(f.service().payout(payout), { code: 'payout_recipient_mismatch' });
  assert.equal(f.counts().prepareCalls, 0);
  assert.equal(f.counts().submitCalls, 0);
});

function bodyPurchaseFixture(overrides = {}) {
  const f = fixture({
    from_address: 'fixture-wallet', to_address: 'fixture-app-wallet',
    status: { developer_approved: true, developer_completed: true, transaction_verified: true },
    transaction: { txid: 'fixture-tx', verified: true }, ...overrides,
  });
  f.identity = { uid: 'fixture-user', credentials: { scopes: ['username', 'payments', 'wallet_address'] } };
  const purchase = structuredClone(f.current);
  const getPayment = f.pi.getPayment.bind(f.pi);
  f.pi.getPayment = async id => id === purchase.identifier ? purchase : getPayment(id);
  // Give the A2U record its own identifier so both records remain addressable.
  const createA2UPayment = f.pi.createA2UPayment.bind(f.pi);
  f.pi.createA2UPayment = async data => {
    const created = await createA2UPayment(data);
    created.identifier = 'fixture-payout';
    f.current.identifier = created.identifier;
    return created;
  };
  return f;
}

test('payout uses the body purchasePaymentId when /me has no wallet address and no index exists', async () => {
  const f = bodyPurchaseFixture();
  assert.equal(await f.store.get('user-payment:fixture-user'), undefined);
  const result = await f.service().payout({ accessToken: 'fixture-access-token', purchasePaymentId: 'fixture-payment' });
  assert.equal(result.status, 'completed');
  assert.equal(f.counts().createCalls, 1);
  assert.equal(f.counts().prepareCalls, 1);
  assert.equal(f.counts().submitCalls, 1);
});

test('payout refuses a body purchasePaymentId owned by another user', async () => {
  const f = bodyPurchaseFixture({ user_uid: 'someone-else' });
  await assert.rejects(f.service().payout({ ...payout, purchasePaymentId: 'fixture-payment' }), { code: 'missing_scope' });
  assert.equal(f.counts().createCalls, 0);
});

test('payout refuses a body purchasePaymentId that is not completed', async () => {
  const f = bodyPurchaseFixture({ status: { developer_completed: false }, transaction: null });
  await assert.rejects(f.service().payout({ ...payout, purchasePaymentId: 'fixture-payment' }), { code: 'missing_scope' });
  assert.equal(f.counts().createCalls, 0);
});

test('payout diagnostics logs one line with the recipient source and no address', async () => {
  const f = bodyPurchaseFixture();
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    await f.service().payout({ ...payout, purchasePaymentId: 'fixture-payment' });
    const recipients = lines.filter(line => JSON.parse(line).event === 'payout_recipient');
    assert.equal(recipients.length, 1);
    assert.deepEqual(JSON.parse(recipients[0]), { event: 'payout_recipient', source: 'purchase', purchaseStage: null });
    assert.equal(lines[0].includes('fixture-wallet'), false);
    lines.length = 0;
    const noPaths = fixture();
    noPaths.identity = { uid: 'fixture-user', credentials: { scopes: [] } };
    await assert.rejects(noPaths.service().payout(payout), { code: 'missing_scope' });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { event: 'payout_recipient', source: 'none', purchaseStage: null });
  } finally {
    console.log = originalLog;
  }
});

test('payout reconciles a crash between submit and complete with saved state', async () => {
  const f = fixture();
  f.crash = 'before_complete';
  await assert.rejects(f.service().payout(payout), { code: 'pi_unavailable' });
  assert.equal((await f.store.get('payout:fixture-user')).status, 'failed');
  // A new service represents a restarted worker with its store restored.
  assert.equal((await f.service().payout(payout)).status, 'completed');
  assert.equal(f.counts().submitCalls, 1);
  assert.equal(f.counts().createCalls, 1);
});

test('lost Horizon submission response looks up saved hash without paying again', async () => {
  const f = fixture();
  f.crash = 'submit';
  await assert.rejects(f.service().payout(payout), { code: 'horizon_unavailable' });
  const saved = await f.store.get('payout:fixture-user');
  assert.equal(saved.txid, 'fixture-tx');
  assert.equal(saved.xdr, 'fixture-envelope');
  await f.service().payout(payout);
  assert.equal(f.counts().submitCalls, 1);
  assert.equal(f.counts().prepareCalls, 1);
});

test('lost A2U create response recovers through incomplete server payments', async () => {
  const f = fixture();
  f.crash = 'create';
  await assert.rejects(f.service().payout(payout));
  assert.equal((await f.service().payout(payout)).status, 'completed');
  assert.equal(f.counts().createCalls, 1);
});

test('ambiguous A2U create without a visible payment fails closed', async () => {
  const f = fixture();
  await f.store.set('payout:fixture-user', { status: 'creating' });
  await assert.rejects(f.service().payout(payout), { code: 'payout_reconciliation_required' });
  assert.equal(f.counts().createCalls, 0);
});

test('payout uses Pi linked transaction without preparing or submitting', async () => {
  const f = fixture();
  f.current = payment({ amount: 0.5, metadata: { product: 'test_payout' }, direction: 'app_to_user',
    status: { developer_approved: true }, transaction: { txid: 'linked-tx', verified: true } });
  await f.store.set('payout:fixture-user', { status: 'created', paymentId: 'fixture-payment' });
  await f.service().payout(payout);
  assert.equal(f.counts().submitCalls, 0);
  assert.equal(f.counts().prepareCalls, 0);
});

test('concurrent payouts allow only one in flight', async () => {
  const f = fixture();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const original = f.ledger.prepare;
  f.ledger.prepare = async p => { entered(); await wait; return original(p); };
  const first = f.service().payout(payout);
  await ready;
  await assert.rejects(f.service().payout(payout), { code: 'operation_in_flight' });
  release();
  await first;
  assert.equal(f.counts().createCalls, 1);
});

test('payout rejects mainnet before building a transaction', async () => {
  const f = fixture();
  f.current = payment({ amount: 0.5, network: 'Pi Network', direction: 'app_to_user', metadata: { product: 'test_payout' } });
  await f.store.set('payout:fixture-user', { status: 'created', paymentId: 'fixture-payment' });
  await assert.rejects(f.service().payout(payout), { code: 'wrong_network' });
  assert.equal(f.counts().prepareCalls, 0);
});

async function call(route, req = {}) {
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
    status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
  await route({ method: 'POST', headers: { 'content-type': 'application/json' }, body: {}, ...req }, res);
  return res;
}

test('HTTP CORS allows both app origins and preflights without auth', async () => {
  for (const origin of ['https://knowaguy4u-cell.github.io', 'https://testjra7998.pinet.com']) {
    const res = await call(handler(() => { throw new Error('must not run'); }), { method: 'OPTIONS', headers: { origin } });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['Access-Control-Allow-Origin'], origin);
  }
  const rejected = await call(handler(() => ({})), { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['Access-Control-Allow-Origin'], undefined);
});

test('HTTP accepts bearer token, rejects invalid JSON and methods, sanitizes errors', async () => {
  let seen;
  const route = handler(body => { seen = body; return { ok: true }; });
  const res = await call(route, { headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-access-token' } });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.accessToken, 'fixture-access-token');
  assert.equal((await call(route, { body: '{' })).statusCode, 400);
  assert.equal((await call(route, { method: 'GET' })).statusCode, 405);
  const failed = await call(handler(() => { throw new Error('upstream private details'); }));
  assert.deepEqual(failed.body, { error: 'internal_error' });
});

test('Pi errors never expose upstream response data', async () => {
  const pi = createPiClient({ fetchImpl: async () => json({ error: 'private upstream details' }, 401) });
  await assert.rejects(pi.getMe('fixture-access-token'), { code: 'invalid_access_token', status: 401 });
});

test('all four Vercel exports handle preflight without credentials or SDK', async () => {
  for (const path of ['payments/approve', 'payments/complete', 'payments/resume', 'payout']) {
    const route = require('../api/' + path);
    assert.equal((await call(route, { method: 'OPTIONS' })).statusCode, 204);
  }
});

async function captureLogs(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try { await fn(lines); }
  finally { console.log = originalLog; }
}

const stageLines = lines => lines.map(line => JSON.parse(line)).filter(line => line.event === 'payout_stage');
const successfulStages = names => names.map(stage => ({ event: 'payout_stage', stage, ok: true }));

test('payout logs each successful stage once in order', async () => {
  const f = fixture();
  await captureLogs(async lines => {
    await f.service().payout(payout);
    assert.deepEqual(stageLines(lines), successfulStages(['create', 'fetch', 'prepare', 'submit', 'complete']));
    await f.service().payout(payout);
    assert.equal(stageLines(lines).length, 5);
  });
});

for (const error of [new HttpError(503, 'transaction_build_failed'), new Error('private failure')]) {
  test(`payout logs failed prepare with ${error.code || 'internal_error'} and rethrows the same error`, async () => {
    const f = fixture();
    f.ledger.prepare = async () => { throw error; };
    await captureLogs(async lines => {
      await assert.rejects(f.service().payout(payout), actual => actual === error);
      assert.deepEqual(stageLines(lines), [
        ...successfulStages(['create', 'fetch']),
        { event: 'payout_stage', stage: 'prepare', ok: false, code: error.code || 'internal_error' },
      ]);
    });
  });
}

test('payout logs completion failure and reconciliation without rebuilding', async () => {
  const f = fixture();
  f.crash = 'after_complete';
  await captureLogs(async lines => {
    await assert.rejects(f.service().payout(payout), { code: 'pi_unavailable' });
    assert.deepEqual(stageLines(lines), [
      ...successfulStages(['create', 'fetch', 'prepare', 'submit']),
      { event: 'payout_stage', stage: 'complete', ok: false, code: 'pi_unavailable' },
    ]);
    lines.length = 0;
    await f.service().payout(payout);
    assert.deepEqual(stageLines(lines), successfulStages(['fetch', 'complete']));
  });
});

test('payout logs only fetch and complete for a Pi linked transaction', async () => {
  const f = fixture();
  f.current = payment({ amount: 0.5, metadata: { product: 'test_payout' }, direction: 'app_to_user',
    status: { developer_approved: true }, transaction: { txid: 'linked-tx', verified: true } });
  await f.store.set('payout:fixture-user', { status: 'created', paymentId: 'fixture-payment' });
  await captureLogs(async lines => {
    await f.service().payout(payout);
    assert.deepEqual(stageLines(lines), successfulStages(['fetch', 'complete']));
  });
});

for (const scenario of ['valid', 'wrong_wallet', 'malformed', 'missing', 'padded', 'empty']) {
  test(`real ledger prepare logs safe keypair booleans for ${scenario} seed`, async () => {
    const { Keypair } = require('@stellar/stellar-sdk');
    const a = Keypair.random(), b = Keypair.random();
    const secret = a.secret();
    const seed = { valid: secret, wrong_wallet: b.secret(), malformed: 'S' + '!'.repeat(55),
      missing: undefined, padded: '  ' + secret + '\n', empty: ' \n' }[scenario];
    const valid = !['malformed', 'missing', 'empty'].includes(scenario);
    const matches = valid && scenario !== 'wrong_wallet';
    const code = { wrong_wallet: 'app_wallet_mismatch', malformed: 'transaction_build_failed',
      missing: 'server_not_configured', empty: 'server_not_configured' }[scenario];
    const requests = [];
    const ledger = createLedger({
      env: seed === undefined ? {} : { PI_WALLET_SEED: seed },
      fetchImpl: async url => {
        requests.push(url);
        if (url === HORIZON + '/accounts/' + a.publicKey()) return json({ sequence: '1' });
        if (url === HORIZON + '/fee_stats') return json({ last_ledger_base_fee: '100000' });
        throw new Error('Unexpected fixture URL');
      },
    });
    await captureLogs(async lines => {
      const preparing = ledger.prepare({ from_address: a.publicKey(), to_address: b.publicKey(), identifier: 'fixture-payment' });
      if (code) await assert.rejects(preparing, { code, status: scenario === 'wrong_wallet' ? 409 : 503 });
      else {
        const prepared = await preparing;
        assert.equal(typeof prepared.xdr, 'string');
        assert.match(prepared.txid, /^[a-f0-9]{64}$/);
      }
      assert.deepEqual(lines.map(line => JSON.parse(line)), [
        { event: 'payout_stage', stage: 'keypair', seedValid: valid, seedMatchesWallet: matches },
      ]);
      for (const line of lines) {
        for (const sensitive of [seed, secret, b.secret(), a.publicKey(), b.publicKey()].filter(Boolean)) {
          assert.equal(line.includes(sensitive), false);
        }
      }
      assert.equal(requests.length, code ? 0 : 2);
    });
  });
}
