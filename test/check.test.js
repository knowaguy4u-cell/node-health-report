'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createCheck, probePorts, validHost, verdicts } = require('../api/_lib/check');
const { MemoryStore } = require('../api/_lib/store');
const { createLedger, HORIZON } = require('../api/_lib/stellar');
const { handler } = require('../api/_lib/http');
const { HttpError } = require('../api/_lib/errors');

const ports = open => Array.from({ length: 10 }, (_, i) => ({ port: 31400 + i, open }));

test('probe opens a listening port and closes a refused port', async t => {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('Sandbox disallows local TCP listeners'); return; }
    throw error;
  }
  const port = server.address().port;
  try { assert.deepEqual(await probePorts('127.0.0.1', [port], 100), [{ port, open: true }]); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(await probePorts('127.0.0.1', [port], 100), [{ port, open: false }]);
});

test('probe timeout resolves and destroys a hanging socket', async () => {
  const original = net.Socket.prototype.connect;
  let socket;
  net.Socket.prototype.connect = function () { socket = this; return this; };
  try {
    assert.deepEqual(await probePorts('example.com', [31400], 5), [{ port: 31400, open: false }]);
    assert.equal(socket.destroyed, true);
  } finally { net.Socket.prototype.connect = original; }
});

for (const host of [
  'localhost', 'LOCALHOST.', '127.0.0.1', '127.5.6.7', '::1', '0:0:0:0:0:0:0:1',
  '169.254.169.254', '0.0.0.0', 'garbage / host', 'http://example.com', '999.1.1.1',
  '0x7f000001', '0x7f000001.', '0x7f.0.0.1', '0xa9fe0001', '0x7f.1', '0x0',
  '127.0.0.1.', '0.0.0.0.', '0177.0.0.1', '017700000001', '2130706433',
  'user@example.com', 'user:pass@127.0.0.1', 'example.com:31400', '127.0.0.1:80',
]) {
  test(`rejects host ${host}`, () => assert.equal(validHost(host), false));
}
for (const host of ['example.com', 'example.com.', '8.8.8.8', '192.168.1.1', '2001:4860:4860::8888']) {
  test(`accepts host ${host}`, () => assert.equal(validHost(host), true));
}

test('verdicts cover healthy, blocked ports, sync lag and missing ledger', () => {
  const healthy = verdicts(ports(true), 100, 100);
  assert.equal(healthy.sections.status.level, 'ok');
  assert.equal(healthy.fixes.length, 1);
  assert.match(healthy.fixes[0].title, /weekly/);
  const blocked = verdicts(ports(false), 100, 100);
  assert.equal(blocked.sections.ports.level, 'bad');
  assert.equal(blocked.fixes[0].title, 'Open your node ports');
  assert.match(blocked.fixes[0].how, /No router setting can fix a CGNAT block/);
  assert.match(blocked.fixes[0].how, /100\.64\.0\.0 – 100\.127\.255\.255/);
  assert.equal(verdicts(ports(true), 6000, 1000).sections.sync.level, 'bad');
  const missing = verdicts(ports(true), 100);
  assert.equal(missing.sections.sync.level, 'warn');
  assert.equal(missing.fixes[0].title, 'Add your node ledger next time');
  const partial = ports(true); partial[2].open = false;
  const ranked = verdicts(partial, 6000, 1000);
  assert.equal(ranked.fixes[0].title, 'Let your node catch up');
  assert.match(ranked.fixes[1].why, /31402/);
  const published = ports(false).map((p,i) => ({ ...p, open: i >= 1 && i <= 3 }));
  const software = verdicts(published, 100, 100);
  assert.equal(software.fixes[0].title, 'No action needed — software range');
  assert.match(software.fixes[0].why, /found 31401, 31402, 31403 open/);
  const subset = verdicts(ports(false).map((p,i) => ({ ...p, open: i === 1 || i === 2 })), 100, 100);
  assert.equal(subset.fixes[0].title, 'No action needed — software range');
  assert.match(subset.fixes[0].why, /found 31401, 31402 open/);
  for (const [gap, level] of [[10, 'ok'], [11, 'warn'], [1000, 'warn'], [1001, 'bad']]) {
    assert.equal(verdicts(ports(true), 2000, 2000 - gap).sections.sync.level, level);
  }
});

function fixture() {
  const store = new MemoryStore();
  const purchase = { identifier: 'purchase', direction: 'user_to_app', amount: 1,
    network: 'Pi Testnet', metadata: { product: 'full_health_check' }, user_uid: 'user', from_address: 'wallet',
    status: { developer_completed: true, transaction_verified: true }, transaction: { verified: true, txid: 'tx' } };
  let user = { uid: 'user', wallet_address: 'wallet' }, probes = 0;
  const ledger = { currentProtocolVersion: async () => 24, findPaymentsFrom: async () => [{ memo: 'purchase', txid: 'tx' }], latestLedger: async () => ({ sequence: 100, protocolVersion: 23 }) };
  const pi = { getMe: async () => user, getPayment: async () => purchase };
  const check = createCheck({ pi, ledger, store, probe: async (host, list, timeout) => {
    probes++;
    assert.equal(host, 'example.com'); assert.equal(timeout, 1200); assert.equal(list.length, 10);
    return ports(true);
  } });
  return { check, ledger, purchase, store, setUser: value => { user = value; }, probes: () => probes };
}
const request = { accessToken: 'fixture-token', host: 'example.com', nodeLedger: 99 };

test('check identifies before probing and denies missing entitlement', async () => {
  const f = fixture();
  await assert.rejects(f.check({ host: 'example.com' }), { status: 401 });
  f.ledger.findPaymentsFrom = async () => [];
  await assert.rejects(f.check(request), { status: 403, code: 'no_completed_check' });
  assert.equal(f.probes(), 0);
});

test('entitled check returns report and rate limits repeat calls', async () => {
  const f = fixture();
  const report = await f.check(request);
  assert.equal(report.currentProtocolVersion, 24);
  assert.equal(report.networkLedger, 100);
  assert.deepEqual(report.ports, ports(true));
  assert.equal(report.syncGap, 1);
  assert.equal(report.host, 'example.com');
  assert.equal(new Date(report.checkedAt).toISOString(), report.checkedAt);
  assert.equal('uid' in report, false); assert.equal('accessToken' in report, false);
  await assert.rejects(f.check(request), { status: 429, code: 'check_too_frequent' });
  await f.store.set('check-at:user', Date.now() - 60001);
  await f.check(request);
  assert.equal(f.probes(), 2);
});

for (const change of [p => { p.user_uid = 'other'; }, p => { p.amount = 2; }, p => { p.metadata.product = 'other'; }, p => { p.direction = 'app_to_user'; }, p => { p.transaction.txid = 'other'; }, p => { p.transaction.verified = false; }, p => { p.status.developer_completed = false; }, p => { p.status.transaction_verified = false; }]) {
  test('check rejects an unverified or mismatched chain purchase', async () => {
    const f = fixture(); change(f.purchase);
    await assert.rejects(f.check(request), { status: 403 });
    assert.equal(f.probes(), 0);
  });
}

test('check uses the store index when the wallet has no chain candidates', async () => {
  const f = fixture();
  f.ledger.findPaymentsFrom = async () => [];
  await f.store.set('user-payment:user', 'purchase');
  const report = await f.check(request);
  assert.equal(report.portsOpen, 10);
  assert.equal(report.currentProtocolVersion, 24);
  assert.equal(report.networkLedger, 100);
  assert.equal(f.probes(), 1);
});

test('check accepts a payment hint without wallet scope or a store index', async () => {
  const f = fixture();
  f.setUser({ uid: 'user' });
  assert.equal(await f.store.get('user-payment:user'), undefined);
  assert.equal((await f.check({ ...request, paymentId: 'purchase' })).portsOpen, 10);
  assert.equal(f.probes(), 1);
});

test('check propagates an invalid Pi identifier from the store-index proof', async () => {
  const f = fixture();
  f.ledger.findPaymentsFrom = async () => [];
  await f.store.set('user-payment:user', 'purchase');
  f.purchase.identifier = 'different';
  await assert.rejects(f.check(request), { status: 502, code: 'invalid_pi_response' });
  assert.equal(f.probes(), 0);
});

test('check rejects a nonexistent payment hint as missing entitlement', async () => {
  const f = fixture();
  f.setUser({ uid: 'user' });
  const error = new HttpError(502, 'pi_request_failed');
  error.upstreamStatus = 404;
  const check = createCheck({
    pi: { getMe: async () => ({ uid: 'user' }), getPayment: async () => { throw error; } },
    ledger: f.ledger, store: f.store,
    probe: async () => { assert.fail('probe should not be called'); },
  });
  await assert.rejects(check({ ...request, paymentId: 'missing' }), {
    status: 403, code: 'no_completed_check',
  });
});

for (const [name, change] of [
  ['wrong amount', p => { p.amount = 2; }],
  ['wrong product', p => { p.metadata.product = 'other'; }],
  ['wrong direction', p => { p.direction = 'app_to_user'; }],
  ['cancelled', p => { p.status.cancelled = true; }],
  ['missing completed flags', p => { p.status = {}; p.transaction = {}; }],
]) {
  test(`check rejects a payment hint with ${name}`, async () => {
    const f = fixture();
    f.setUser({ uid: 'user' });
    change(f.purchase);
    await assert.rejects(f.check({ ...request, paymentId: 'purchase' }), {
      status: 403, code: 'no_completed_check',
    });
    assert.equal(f.probes(), 0);
  });
}

test('check rejects a non-string payment hint without other proof', async () => {
  const f = fixture();
  f.setUser({ uid: 'user' });
  await assert.rejects(f.check({ ...request, paymentId: 1234 }), {
    status: 403, code: 'no_completed_check',
  });
  assert.equal(f.probes(), 0);
});

test('check rejects a payment hint belonging to another user', async () => {
  const f = fixture();
  f.setUser({ uid: 'user' });
  f.purchase.user_uid = 'other';
  await assert.rejects(f.check({ ...request, paymentId: 'purchase' }), {
    status: 403, code: 'no_completed_check',
  });
  assert.equal(f.probes(), 0);
});

test('check falls back to validated store index without wallet scope', async () => {
  const f = fixture(); f.setUser({ uid: 'user' });
  await f.store.set('user-payment:user', 'purchase');
  assert.equal((await f.check(request)).portsOpen, 10);
});

test('check grants entitlement without wallet scope when purchase from_address is absent', async () => {
  const f = fixture(); f.setUser({ uid: 'user' });
  f.purchase.from_address = null;
  await f.store.set('user-payment:user', 'purchase');
  const report = await f.check(request);
  assert.equal(report.portsOpen, 10);
});

test('check rejects hostname resolving to blocked IP range', async () => {
  const f = fixture();
  const check = createCheck({
    pi: { getMe: async () => ({ uid: 'user', wallet_address: 'wallet' }), getPayment: async () => f.purchase },
    ledger: f.ledger, store: f.store,
    probe: async () => { throw new Error('probe should not be called'); },
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  await assert.rejects(check(request), { status: 400, code: 'invalid_host' });
});

test('invalid host never reaches probe and Horizon failure propagates', async () => {
  const f = fixture();
  await assert.rejects(f.check({ ...request, host: 'localhost' }), { status: 400, code: 'invalid_host' });
  assert.equal(f.probes(), 0);
  const { HttpError } = require('../api/_lib/errors');
  f.ledger.latestLedger = async () => { throw new HttpError(502, 'horizon_unavailable'); };
  await assert.rejects(f.check(request), { status: 502 });
});

test('check endpoint follows HTTP error and preflight shape', async () => {
  const f = fixture();
  const res = { setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; }, end() {} };
  await handler(f.check)({ method: 'POST', headers: { 'content-type': 'application/json' }, body: {} }, res);
  assert.equal(res.statusCode, 401); assert.deepEqual(res.body, { error: 'missing_access_token' });
  await require('../api/check')({ method: 'OPTIONS' }, res);
  assert.equal(res.statusCode, 204);
});

const json = body => new Response(JSON.stringify(body));
test('incoming ledger history filters direction and amount, pages at most three times and returns memos', async () => {
  const signer = require('@stellar/stellar-sdk').Keypair.random();
  const app = signer.publicKey();
  const base = { type: 'payment', from: 'wallet', to: app, asset_type: 'native', amount: '1.0000000' };
  let pages = 0;
  const ledger = createLedger({ env: { PI_WALLET_SEED: ' ' + signer.secret() + '\n' }, fetchImpl: async url => {
    if (url.includes('/operations?')) {
      pages++;
      return json({ _embedded: { records: pages === 1 ? [
        { ...base, transaction_hash: 'new' },
        ...[{ from: app }, { to: 'other' }, { amount: '0.5' }, { asset_type: 'credit_alphanum4' }, { type: 'create_account' }].map(p => ({ ...base, ...p, transaction_hash: 'excluded' })),
      ] : [{ ...base, transaction_hash: pages === 2 ? 'failed' : 'old' }] },
      _links: { next: { href: HORIZON + '/accounts/' + app + '/operations?cursor=' + pages } } });
    }
    if (url.endsWith('/new')) return json({ hash: 'new', memo: 'new-purchase', successful: true });
    if (url.endsWith('/old')) return json({ hash: 'old', memo: 'old-purchase', successful: true });
    if (url.endsWith('/failed')) return json({ successful: false });
    throw new Error('Unexpected URL');
  } });
  assert.deepEqual(await ledger.findPaymentsFrom('wallet', '1'), [{ txid: 'new', memo: 'new-purchase' }, { txid: 'old', memo: 'old-purchase' }]);
  assert.equal(pages, 3);
});

test('latestLedger reads configured Horizon and sanitizes failures', async () => {
  const ledger = createLedger({ env: { PI_HORIZON_URL: 'https://fixture.invalid' }, fetchImpl: async url => {
    assert.equal(url, 'https://fixture.invalid/ledgers?order=desc&limit=1');
    return json({ _embedded: { records: [{ sequence: 123, protocol_version: 23 }] } });
  } });
  assert.deepEqual(await ledger.latestLedger(), { sequence: 123, protocolVersion: 23, closedAt: null });
  await assert.rejects(createLedger({ fetchImpl: async () => { throw new Error('private'); } }).latestLedger(), { status: 502, code: 'horizon_unavailable' });
});

test('latestLedger keeps a valid closed_at and treats missing or bad dates as null', async () => {
  for (const [closed_at, expected] of [['2026-11-20T12:00:00Z','2026-11-20T12:00:00Z'],[undefined,null],['not-a-date',null]]) {
    const ledger=createLedger({env:{PI_HORIZON_URL:'https://fixture.invalid'},fetchImpl:async()=>json({_embedded:{records:[{sequence:1,protocol_version:2,...(closed_at===undefined?{}:{closed_at})}]}})});
    assert.equal((await ledger.latestLedger()).closedAt,expected);
  }
});

 test('current protocol comes from Horizon root and rejects invalid data', async () => {
   const ledger = createLedger({ env: { PI_HORIZON_URL: 'https://fixture.invalid' }, fetchImpl: async url => {
     assert.equal(url, 'https://fixture.invalid/');
     return json({ current_protocol_version: 24, supported_protocol_version: 25 });
   } });
   assert.equal(await ledger.currentProtocolVersion(), 24);
   for (const value of [null, '24', -1, 1.5]) {
     await assert.rejects(createLedger({ fetchImpl: async () => json({ current_protocol_version: value }) }).currentProtocolVersion(), { code: 'invalid_horizon_response' });
   }
 });

test('check succeeds with null protocol when the Horizon root read fails', async () => {
  const f = fixture();
  f.ledger.currentProtocolVersion = async () => { throw new HttpError(502, 'horizon_unavailable'); };
  const report = await f.check(request);
  assert.equal(report.currentProtocolVersion, null);
  assert.equal(report.networkLedger, 100);
  assert.equal(report.sections.status.level, 'ok');
});
