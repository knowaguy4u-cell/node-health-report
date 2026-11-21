'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const html = readFileSync(require.resolve('../index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function browser({ incomplete = false, fail = false, storage = new Map(), checkResponse, checkError, networkFailure = false, throwingStorage = false } = {}) {
  const elements = new Map();
  const makeElement = () => {
    const el = {
      hidden: true, disabled: false, children: [],
      addEventListener(event, callback) { this[event] = callback; },
      appendChild(child) { this.children.push(child); },
    };
    let own = '';
    Object.defineProperty(el, 'textContent', {
      get() { return own + this.children.map(child => child.textContent ?? '').join(''); },
      set(value) { own = String(value); this.children = []; },
    });
    return el;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
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
  const events = {};
  const localStorage = {
    getItem: key => { if (throwingStorage) throw Error('blocked'); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (throwingStorage) throw Error('blocked'); return storage.set(key, String(value)); },
    removeItem: key => storage.delete(key),
  };
  const context = vm.createContext({ Pi, localStorage, document: { getElementById: element, createElement: makeElement, addEventListener: (event, cb) => { events[event] = cb; } }, window: { addEventListener: (event, cb) => { events[event] = cb; } },
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
  return { context, element, calls, events, get callbacks() { return callbacks; }, get paymentData() { return paymentData; }, get init() { return init; } };
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
  assert.equal(b.element('fixes-panel').hidden, true);
  const reloaded = browser({ storage });
  assert.match(reloaded.element('report-history').textContent, /example.com/);
  assert.equal(reloaded.element('check-node').textContent, checkReport.sections.status.line);
  assert.doesNotMatch(storage.get('nhr:lastReport'), /fixture-access-token/);
});

for (const [checkError, expected] of [
  ['no_completed_check', /Buy the full health check first/],
  ['check_too_frequent', /Queue position 1 — about 1 minute/], ['invalid_host', /valid public hostname/],
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


test('frontend buttons have a 44px minimum height and visible keyboard focus', () => {
  assert.match(html, /button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(html, /:focus-visible\s*\{[^}]*outline:\s*2px solid #f59e0b;[^}]*outline-offset:\s*2px;/);
});

test('frontend purchase and payout buttons describe their existing status lines', () => {
  for (const [button, hint] of [['health-check', 'check-hint'], ['payout', 'payout-hint']]) {
    assert.match(html, new RegExp('<button id="' + button + '"[^>]*aria-describedby="' + hint + ' latest-status"'));
    assert.match(html, new RegExp('<p id="' + hint + '"'));
  }
  assert.match(html, /<p id="latest-status"/);
});

const observed = (host, time, gap, level = 'warn', open = 10) => ({
  ...checkReport, host, checkedAt: time, nodeLedger: 1000 - gap,
  networkLedger: 1000, currentProtocolVersion: 24, syncGap: gap, portsOpen: open,
  sections: { ...checkReport.sections, status: { level, line: level === 'ok' ? 'Healthy' : 'Needs attention' } },
});
const evaluate = (b, code) => vm.runInContext(code, b.context);

test('fleet add and remove persist labels and hosts across reload', async () => {
  const storage = new Map(), b = browser({ storage });
  b.element('node-host').value = 'EXAMPLE.COM'; b.element('node-label').value = 'Observatory';
  b.element('own-node').checked = true;
  await b.element('add-node').click();
  assert.deepEqual(JSON.parse(storage.get('nhr:fleet')), [{ host: 'example.com', label: 'Observatory' }]);
  const restored = browser({ storage });
  assert.match(restored.element('fleet-verdict').textContent, /1 node watched. 1 needs attention/);
  const entry = restored.element('fleet-list').children.at(-1);
  assert.equal(entry.children[0].children[0].textContent, 'Observatory');
  entry.children.at(-1).onclick();
  assert.deepEqual(JSON.parse(storage.get('nhr:fleet')), []);
});

test('fleet history stores real checks without credentials and migrates old report', async () => {
  const report = observed('example.com', '2026-11-20T12:00:00Z', 0, 'ok');
  const storage = new Map([['nhr:lastReport', JSON.stringify(report)]]);
  const b = browser({ storage, checkResponse: report });
  assert.equal(JSON.parse(storage.get('nhr:history')).length, 1);
  assert.equal(b.element('fleet-verdict').textContent, 'All 1 node is healthy.');
  await b.element('signin').click(); await runCheck(b);
  assert.doesNotMatch(storage.get('nhr:history') + storage.get('nhr:fleet'), /fixture-access-token/);
  assert.match(b.element('network-observation').textContent, /NETWORK LEDGER 1000 · PROTOCOL 24/);
  assert.match(b.element('network-note').textContent, /upgrade status cannot be verified/);
});

test('state change time requires an actual verdict transition and survives repeated observations', () => {
  const rows = [observed('a.example', '2026-11-20T10:00:00Z', 0, 'ok')];
  const b = browser({ storage: new Map([['nhr:history', JSON.stringify(rows)]]) });
  assert.equal(evaluate(b, "changedAt('a.example')"), null);
  evaluate(b, 'history.push(' + JSON.stringify(observed('a.example', '2026-11-20T11:00:00Z', 100)) + ')');
  evaluate(b, 'history.push(' + JSON.stringify(observed('a.example', '2026-11-20T12:00:00Z', 50)) + ')');
  assert.equal(evaluate(b, "changedAt('a.example')"), '2026-11-20T11:00:00Z');
  assert.equal(evaluate(b, "changedAt('b.example')"), null);
});

test('catch-up rate uses declining gap from two timed observations of the same host', () => {
  const b = browser();
  evaluate(b, 'history.push(' + JSON.stringify(observed('a.example', '2026-11-20T10:00:00Z', 1000)) + ')');
  assert.equal(evaluate(b, "catchupRate('a.example')"), null);
  evaluate(b, 'history.push(' + JSON.stringify(observed('other.example', '2026-11-20T11:00:00Z', 100)) + ')');
  assert.equal(evaluate(b, "catchupRate('a.example')"), null);
  evaluate(b, 'history.push(' + JSON.stringify(observed('a.example', '2026-11-20T11:00:00Z', 100)) + ')');
  assert.equal(evaluate(b, "catchupRate('a.example')"), 900);
  evaluate(b, 'history.push(' + JSON.stringify(observed('a.example', '2026-11-20T12:00:00Z', 200)) + ')');
  assert.equal(evaluate(b, "catchupRate('a.example')"), null);
});

function fleetBrowser(count = 3) {
  return browser({ storage: new Map([['nhr:fleet', JSON.stringify(Array.from({ length: count }, (_, i) => ({ label: String(i + 1), host: i + '.example' }))) ]]) });
}
function fakeClock(b) {
  let now = 0;
  const timers = [];
  b.context.Date = class extends Date { static now() { return now; } };
  b.context.setTimeout = (callback, delay) => { timers.push({ callback, delay, at: now + delay }); return timers.length; };
  return { timers, async tick() {
    const timer = timers.shift(); assert.ok(timer);
    now = timer.at;
    await timer.callback();
    await flush();
  }, now: () => now };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test('check all spaces successful and failed attempts by 61 seconds with honest waits', async () => {
  const b = fleetBrowser(), clock = fakeClock(b), times = [];
  b.context.fetch = async (url, options) => {
    times.push(clock.now());
    const body = JSON.parse(options.body); assert.equal(body.nodeLedger, null);
    return { ok: times.length !== 2, json: async () => times.length === 2 ? { error: 'horizon_request_failed' } : observed(body.host, '2026-11-20T12:00:00Z', null) };
  };
  const run = b.element('check-all').click(); await flush();
  assert.deepEqual(times, [0]);
  assert.equal(b.element('fleet-progress').textContent, 'Waiting about 61 seconds before checking 2. Keep this page open.');
  await clock.tick(); assert.deepEqual(times, [0, 61000]);
  assert.match(b.element('fleet-progress').textContent, /before checking 3/);
  await clock.tick(); await run;
  assert.deepEqual(times, [0, 61000, 122000]);
});

test('429 queue states show positions and minute ETAs and retry at 61 second intervals', async () => {
  const b = fleetBrowser(), clock = fakeClock(b);
  b.context.fetch = async () => ({ ok: false, json: async () => ({ error: 'check_too_frequent' }) });
  await evaluate(b, 'checkNode(fleet[0])');
  await evaluate(b, 'checkNode(fleet[1])');
  await evaluate(b, 'checkNode(fleet[2])');
  assert.deepEqual(clock.timers.map(t => t.delay), [61000, 122000, 183000]);
  assert.equal(evaluate(b, 'queueCopy(fleet[0].host)'), 'Queue position 1 — about 1 minute. Keep this page open.');
  assert.equal(evaluate(b, 'queueCopy(fleet[2].host)'), 'Queue position 3 — about 3 minutes. Keep this page open.');
  assert.doesNotMatch(evaluate(b, 'queueCopy(fleet[0].host)'), /under a minute/);
  let attempts = 0;
  b.context.fetch = async (url, options) => { attempts++; return { ok: true, json: async () => observed(JSON.parse(options.body).host, '2026-11-20T12:00:00Z', null) }; };
  await clock.tick(); assert.equal(attempts, 1);
  await clock.tick(); assert.equal(attempts, 2);
  await clock.tick(); assert.equal(attempts, 3);
});

for (const error of ['missing_access_token', 'invalid_access_token', 'no_completed_check']) {
  test('check all aborts immediately on ' + error, async () => {
    const b = fleetBrowser(); fakeClock(b);
    let attempts = 0;
    b.context.fetch = async () => { attempts++; return { ok: false, json: async () => ({ error }) }; };
    await b.element('check-all').click();
    assert.equal(attempts, 1);
    assert.equal(b.element('check-all').disabled, false);
    assert.equal(b.element('fleet-progress').textContent, 'The checks could not be completed — ' + b.element('check-result').textContent);
    assert.match(b.element('check-result').textContent, error === 'no_completed_check' ? /Buy the full health check first/ : /We could not run your check/);
  });
}

for (const checkError of ['invalid_horizon_response', 'horizon_request_failed']) {
  test('frontend maps ' + checkError + ' to network availability copy', async () => {
    const b = browser({ checkError }); await runCheck(b);
    assert.equal(b.element('check-result').textContent, 'Pi network data is temporarily unavailable. Please try again in a moment.');
  });
}

test('fleet chooses one highest-priority fix and keeps unobserved cells empty', () => {
  const healthy = observed('healthy.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const bad = observed('bad.example', '2026-11-20T12:00:00Z', 100, 'bad', 0);
  bad.fixes = [{ title: 'Open ports', why: 'No ports answered.', how: 'Forward ports.' }];
  const b = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: healthy.host, label: 'Healthy' }, { host: bad.host, label: 'Blocked' }, { host: 'new.example', label: 'New' }])],
    ['nhr:history', JSON.stringify([healthy, bad])],
  ]) });
  assert.match(b.element('fixes').children.at(-1).textContent, /^Open ports/);
  const entry = b.element('fleet-list').children.at(-1);
  assert.equal(entry.children[0].children[1].textContent, 'NOT CHECKED');
  assert.deepEqual(entry.children[2].children.map(cell => cell.children[1].textContent), ['—', '—', '—', '—', '—']);
});

test('dark tokens carry readable text contrast including tinted panels', () => {
  function luminance(hex) {
    return hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
  }
  for (const color of ['e6edf7','94a3b8','34d399','f59e0b','f87171']) {
    for (const background of ['060b18','0a1d24','1e1919','20161f','2b2220']) {
      assert.ok((luminance(color)+.05)/(luminance(background)+.05) >= 4.5, color + ' on ' + background);
    }
  }
  assert.doesNotMatch(html.replace(/WHAT WE CAN'T SEE[\s\S]*?<\/section>/, ''), /\b(peers|docker)\b/i);
});

test('removing the final node stays removed after reload without erasing history', () => {
  const report = observed('example.com', '2026-11-20T12:00:00Z', 0, 'ok');
  const storage = new Map([['nhr:lastReport', JSON.stringify(report)]]);
  const b = browser({ storage });
  b.element('fleet-list').children.at(-1).children[3].onclick();
  const reloaded = browser({ storage });
  assert.equal(evaluate(reloaded, 'fleet.length'), 0);
  assert.equal(evaluate(reloaded, 'history.length'), 1);
});

test('stored verdict severity change records its real timestamp even when both are behind', () => {
  const reports = [observed('example.com', '2026-11-20T10:00:00Z', 100), observed('example.com', '2026-11-20T11:00:00Z', 2000, 'bad')];
  const b = browser({ storage: new Map([['nhr:history', JSON.stringify(reports)]]) });
  assert.equal(evaluate(b, "changedAt('example.com')"), '2026-11-20T11:00:00Z');
});

test('fix panel excludes healthy reports and ranks severity, closed ports, then gap', () => {
  const rows = [
    observed('healthy', '2026-11-20T12:00:00Z', 9000, 'ok', 0),
    observed('warn', '2026-11-20T12:00:00Z', 9000, 'warn', 0),
    observed('bad-open', '2026-11-20T12:00:00Z', 9000, 'bad', 10),
    observed('bad-closed-low', '2026-11-20T12:00:00Z', 100, 'bad', 0),
    observed('bad-closed-high', '2026-11-20T12:00:00Z', 200, 'bad', 0),
  ];
  for (const r of rows) r.fixes = [{ title: r.host, why: 'Why.', how: 'How.' }];
  const b = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify(rows.map(r => ({ host: r.host, label: r.host })))],
    ['nhr:history', JSON.stringify(rows)],
  ]) });
  for (const expected of ['bad-closed-high', 'bad-closed-low', 'bad-open', 'warn']) {
    assert.equal(b.element('fixes-panel').hidden, false);
    assert.match(b.element('fixes').children.at(-1).textContent, new RegExp('^' + expected + '\\.'));
    evaluate(b, 'history = history.filter(r => r.host !== ' + JSON.stringify(expected) + '); renderFleet()');
  }
  assert.equal(b.element('fixes-panel').hidden, true);
});

test('check all preserves a 429 retry chain while pacing the next node', async () => {
  const b = fleetBrowser(2), clock = fakeClock(b), times = [];
  b.context.fetch = async (url, options) => {
    times.push(clock.now());
    const host = JSON.parse(options.body).host;
    return { ok: times.length !== 1, json: async () => times.length === 1 ? { error: 'check_too_frequent' } : observed(host, '2026-11-20T12:00:00Z', null) };
  };
  const run = b.element('check-all').click(); await flush();
  assert.equal(evaluate(b, "progress.get('0.example')"), 'CHECK QUEUED');
  // Both the retry and the next fleet node are due after the first window.
  const retry = clock.timers.shift();
  assert.equal(retry.delay, 61000);
  await clock.tick(); await run;
  const retried = retry.callback(); await flush();
  assert.deepEqual(times, [0, 61000]);
  await clock.tick(); await retried;
  assert.deepEqual(times, [0, 61000, 122000]);
});

test('null protocol renders an em dash and hides the network note', () => {
  const report = { ...observed('a.example', '2026-11-20T12:00:00Z', 0, 'ok'), currentProtocolVersion: null };
  const b = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: report.host, label: 'A' }])],
    ['nhr:history', JSON.stringify([report])],
  ]) });
  assert.match(b.element('network-observation').textContent, /PROTOCOL —/);
  assert.equal(b.element('network-note').hidden, true);
});

test('empty fleet uses the directory empty-state grammar and its button opens the add-node flow', async () => {
  const b = browser();
  const empty = b.element('fleet-list').children[0];
  assert.equal(empty.className, 'empty-state');
  assert.equal(empty.children[0].textContent, 'No nodes yet');
  assert.equal(empty.children[1].textContent, 'Add a node and its first check takes under a minute.');
  assert.equal(empty.children[2].textContent, 'Add a node');
  assert.match(html, /\.empty-state h2 \{[^}]*font-weight:\s*700/);
  assert.match(html, /\.empty-state button \{[^}]*background:\s*transparent/);
  assert.equal(b.element('check-all').disabled, true);
  b.element('run-panel').hidden = true;
  empty.children[2].onclick();
  assert.equal(b.element('run-panel').hidden, false);
  b.element('node-host').value = 'new.example';
  b.element('own-node').checked = true;
  await b.element('add-node').click();
  assert.equal(b.element('fleet-list').children.length, 1);
  assert.equal(b.element('fleet-list').children[0].className, 'fleet-entry');
  assert.equal(b.element('check-all').disabled, false);
});

test('queue presentation retains observed stats and explains the real wait', async () => {
  const report = observed('example.com', '2026-11-20T12:00:00Z', 80);
  const b = browser({ checkError: 'check_too_frequent', storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: report.host, label: 'Home' }])],
    ['nhr:history', JSON.stringify([report])],
  ]) });
  fakeClock(b);
  await evaluate(b, 'checkNode(fleet[0])');
  const entry = b.element('fleet-list').children[0];
  assert.equal(entry.children[0].children[1].textContent, 'CHECK QUEUED');
  assert.equal(entry.children[2].children[1].children[1].textContent, '80');
  const note = entry.children.find(child => child.className === 'hint queue-note');
  assert.match(note.textContent, /Queue position 1 — about 1 minute. Keep this page open./);
});

test('verdict hero reflects empty, healthy, and attention states with monospace numerals', () => {
  const empty = browser();
  assert.equal(empty.element('fleet-verdict').className, 'verdict-empty');
  assert.deepEqual(empty.element('fleet-verdict').children.filter(c => c.className).map(c => [c.textContent, c.className]), [['0', 'num'], ['0', 'num']]);

  const healthy = observed('ok.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const okBrowser = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: healthy.host, label: 'OK' }])],
    ['nhr:history', JSON.stringify([healthy])],
  ]) });
  assert.equal(okBrowser.element('fleet-verdict').className, 'verdict-ok');
  assert.deepEqual(okBrowser.element('fleet-verdict').children.filter(c => c.className).map(c => [c.textContent, c.className]), [['1', 'num ok']]);

  const warn = observed('warn.example', '2026-11-20T12:00:00Z', 25, 'warn', 4);
  const warnBrowser = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: warn.host, label: 'Warn' }])],
    ['nhr:history', JSON.stringify([warn])],
  ]) });
  assert.equal(warnBrowser.element('fleet-verdict').className, 'verdict-warn');
  assert.deepEqual(warnBrowser.element('fleet-verdict').children.filter(c => c.className).map(c => [c.textContent, c.className]), [['1', 'num'], ['1', 'num warn']]);
});

test('telemetry line, observation date, network note, and dynamic amounts isolate monospace numbers', async () => {
  const report = observed('ok.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const b = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: report.host, label: 'OK' }])],
    ['nhr:history', JSON.stringify([report])],
  ]) });
  assert.deepEqual(b.element('network-observation').children.filter(c => c.className === 'obs-val').map(c => c.textContent), ['1000', '24']);
  assert.equal(b.element('observation-date').children.at(-1).className, 'num');
  assert.deepEqual(b.element('network-note').children.filter(c => c.className === 'num').map(c => c.textContent), ['24']);
  await b.element('signin').click();
  assert.deepEqual(b.element('health-check').children.filter(c => c.className === 'num').map(c => c.textContent), ['1']);
  assert.equal(b.element('health-check').textContent, 'Run full health check — 1 Test-Pi');
  await b.element('payout').click();
  assert.deepEqual(b.element('payout').children.filter(c => c.className === 'num').map(c => c.textContent), ['0.5']);
  assert.equal(b.element('payout').textContent, 'Send test payout — 0.5 Test-Pi');
});

test('reskin locks single amber fixes highlight, amber test badge, and typography rules', () => {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal((style.match(/linear-gradient/g) || []).length, 1);
  assert.match(style, /#fixes-panel\s*\{[^}]*linear-gradient\([^)]*245,\s*158,\s*11/);
  assert.match(style, /\.badge\s*\{[^}]*color:\s*#f59e0b;[^}]*background:\s*rgba\(245,\s*158,\s*11/);
  assert.match(style, /body\s*\{[^}]*"Times New Roman"/);
  assert.match(style, /\.mono,\s*\.num,\s*dd,\s*input\[type=number\]\s*\{[^}]*ui-monospace/);
});
test('health score math follows port and sync bands and omits null gaps', () => {
  const b = browser();
  const calc = report => evaluate(b, 'scoreFor(' + JSON.stringify(report) + ')');
  assert.equal(calc(observed('a', '2026-11-20T12:00:00Z', 0, 'ok')).value, 100);
  assert.equal(calc(observed('a', '2026-11-20T12:00:00Z', 0, 'ok', 8)).value, 90);
  for (const [gap, sync] of [[0,50],[1,45],[10,45],[11,30],[1000,30],[1001,15],[100000,15],[100001,0]]) {
    assert.equal(calc(observed('a', '2026-11-20T12:00:00Z', gap)).sync, sync, 'gap ' + gap);
  }
  assert.equal(calc(observed('a', '2026-11-20T12:00:00Z', null)), null);
});

test('health score lever selects ports when one open port is the larger loss', () => {
  const b = browser();
  const r = observed('a', '2026-11-20T12:00:00Z', 2000, 'warn', 1);
  r.fixes = [{ title: 'Let your node catch up', why: '', how: '' }, { title: 'Restore port access', why: '', how: '' }];
  assert.equal(evaluate(b, 'scoreFix(' + JSON.stringify(r) + ', scoreFor(' + JSON.stringify(r) + '))'), 'The fix that raises it most: Restore port access (+45).');
});

test('report score block renders score band, fix, null-gap copy and report framing', () => {
  const r = observed('a.example', '2026-11-20T12:00:00Z', 0, 'ok');
  r.fixes = [{ title: 'Almost synced', why: '', how: '' }];
  const b = browser({ storage: new Map([['nhr:lastReport', JSON.stringify(r)]]) });
  assert.equal(b.element('health-score').hidden, false);
  assert.equal(b.element('score-value').textContent, '100 of 100 — Healthy');
  assert.match(b.element('score-fix').textContent, /Full score/);
  const unscored = observed('a.example', '2026-11-20T12:00:00Z', null);
  const c = browser({ storage: new Map([['nhr:lastReport', JSON.stringify(unscored)]]) });
  assert.match(c.element('score-value').textContent, /Not scored yet — enter your node's current ledger/);
  assert.match(html, /Measured from outside — what the network sees/);
  assert.match(html, /OUTSIDE-VERIFIED/);
  assert.match(html, /Judged by ledger progress against the network/);
});

test('fleet score cell shows computed score or em dash', () => {
  const r = observed('a.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const b = browser({ storage: new Map([['nhr:fleet', JSON.stringify([{host:r.host,label:'A'}])],['nhr:history',JSON.stringify([r])]]) });
  const stats = b.element('fleet-list').children[0].children[2].children.map(c => c.children[1].textContent);
  assert.deepEqual(stats.slice(0,3), ['1000','0','10/10']);
  assert.match(stats[3], /^(seconds|\d+ min)$/); assert.equal(stats[4], '100');
  const noGap = observed('b.example', '2026-11-20T12:00:00Z', null);
  const c = browser({ storage: new Map([['nhr:fleet', JSON.stringify([{host:noGap.host,label:'B'}])],['nhr:history',JSON.stringify([noGap])]]) });
  assert.equal(c.element('fleet-list').children[0].children[2].children[4].children[1].textContent, '—');
});

test('trend uses measured stored gaps only, caps at five, labels checks and reports direction', () => {
  const b = browser();
  for (const [gaps, expected] of [[[100,50],'closing'],[[50,100],'growing'],[[50,50],'steady']]) {
    evaluate(b, 'history = ' + JSON.stringify(gaps.map((g,i) => observed('a','2026-11-20T0'+i+':00:00Z',g))));
    const value = evaluate(b, "trendFor('a')");
    assert.match(value, /across your checks/); assert.match(value, new RegExp(expected));
  }
  evaluate(b, 'history = ' + JSON.stringify([1,2,3,4,5,6].map((g,i) => observed('a','2026-11-20T0'+i+':00:00Z',g))));
  assert.equal(evaluate(b, "trendFor('a')").match(/\d+/g).length, 5);
  evaluate(b, 'history = ' + JSON.stringify([observed('a','2026-11-20T00:00:00Z',2), observed('a','2026-11-20T01:00:00Z',null)]));
  assert.equal(evaluate(b, "trendFor('a')"), null);
});

test('what changed uses real report transitions and omits single observations', () => {
  const b = browser();
  const a = observed('a','2026-11-20T10:00:00Z',100,'ok',10), z = observed('a','2026-11-20T11:00:00Z',200,'bad',8);
  evaluate(b, 'history = ' + JSON.stringify([a,z]));
  const text = evaluate(b, "changesFor('a')");
  assert.match(text, /verdict healthy → at risk/); assert.match(text, /sync gap 100 → 200/); assert.match(text, /ports open 10 → 8 of 10/);
  evaluate(b, 'history = ' + JSON.stringify([a,{...a, checkedAt:"2026-11-20T11:00:00Z"}]));
  assert.equal(evaluate(b, "changesFor('a')"), 'Since your last check: no change.');
  evaluate(b, 'history = ' + JSON.stringify([a])); assert.equal(evaluate(b, "changesFor('a')"), null);
});
test('saved report renders score extras on load without breaking history migration', () => {
  const a = observed('a.example', '2026-11-20T10:00:00Z', 100, 'warn', 8);
  const z = observed('a.example', '2026-11-20T11:00:00Z', 0, 'ok', 10);
  const storage = new Map([['nhr:lastReport', JSON.stringify(z)], ['nhr:history', JSON.stringify([a, z])]]);
  const b = browser({ storage });
  assert.equal(JSON.parse(storage.get('nhr:history')).length, 2);
  assert.equal(b.element('health-score').hidden, false);
  assert.equal(b.element('score-value').textContent, '100 of 100 — Healthy');
  assert.match(b.element('report-trend').textContent, /Sync gap across your checks: 100 → 0 — closing\./);
  assert.match(b.element('report-changes').textContent, /Since your last check: verdict needs attention → healthy; sync gap 100 → 0; ports open 8 → 10 of 10/);
});

test('outside-verified badge sits outside the dynamic ports span', () => {
  assert.match(html, /id="check-ports"[^<]*<\/span> <span class="badge">OUTSIDE-VERIFIED<\/span>/);
});

test('score fix line handles the nothing-to-fix report below full score', () => {
  const b = browser();
  const r = observed('a', '2026-11-20T12:00:00Z', 5, 'ok', 10);
  r.fixes = [{ title: 'Nothing to fix — run this check weekly', why: '', how: '' }];
  assert.equal(evaluate(b, 'scoreFix(' + JSON.stringify(r) + ', scoreFor(' + JSON.stringify(r) + '))'), 'Nothing to fix — the remaining points come back as the gap closes.');
});

test('trend direction reads the shown series from first to last', () => {
  const b = browser();
  evaluate(b, 'history = ' + JSON.stringify([1, 50, 40, 30, 20, 25].map((g, i) => observed('a', '2026-11-20T0' + i + ':00:00Z', g))));
  assert.match(evaluate(b, "trendFor('a')"), /50 → 40 → 30 → 20 → 25 — closing\./);
});
test('score value and fleet trend numbers render in monospace spans', () => {
  const r = observed('a.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const b = browser({ storage: new Map([['nhr:lastReport', JSON.stringify(r)]]) });
  assert.deepEqual(b.element('score-value').children.filter(c => (c.className || '').includes('num')).map(c => c.textContent), ['100', '100']);
  const a = observed('h.example', '2026-11-20T10:00:00Z', 100, 'warn', 8);
  const z = observed('h.example', '2026-11-20T11:00:00Z', 0, 'ok', 10);
  const c = browser({ storage: new Map([['nhr:fleet', JSON.stringify([{ host: 'h.example', label: 'H' }])], ['nhr:history', JSON.stringify([a, z])]]) });
  const words = c.element('fleet-list').children[0].children[3];
  assert.match(words.textContent, /across your checks/);
  const nums = words.children.filter(x => x.className === 'num').map(x => x.textContent);
  assert.ok(nums.includes('100') && nums.includes('0'), 'trend numbers are .num spans: ' + nums.join(','));
});

test('share card and proof exports contain only stored report facts', () => {
  const b=browser(), r=observed('node.example','2026-11-20T12:00:00Z',0,'ok');
  r.ports=Array.from({length:10},(_,i)=>({port:31400+i,open:true}));
  const lines=evaluate(b,'cardLines('+JSON.stringify(r)+')');
  assert.ok(lines.includes('Node Health Report')); assert.ok(lines.some(x=>x.includes('100 — Healthy'))); assert.ok(lines.includes('Host: node.example'));
  const unscored={...r,syncGap:null}; assert.equal(evaluate(b,'cardLines('+JSON.stringify(unscored)+')').some(x=>x.startsWith('Health score:')),false);
  const proof=evaluate(b,'proofText('+JSON.stringify(r)+')');
  for(let p=31400;p<=31409;p++) assert.match(proof,new RegExp('Port '+p+': (open|closed)'));
  assert.match(proof,/Generated by Node Health Report from an outside check/);
  assert.match(evaluate(b,'proofText('+JSON.stringify(unscored)+')'),/Health score: not scored/);
});

test('round two static copy, measured stall and Testnet2 line',()=>{
  const r=observed('node.example','2026-11-20T12:20:00Z',20,'warn'); r.networkLedgerClosedAt='2026-11-20T12:00:00Z';
  r.ports=Array.from({length:10},(_,i)=>({port:31400+i,open:i>=1&&i<=3}));
  const b=browser({storage:new Map([['nhr:lastReport',JSON.stringify(r)]])});
  assert.match(b.element('network-stall').textContent,/20 minutes ago/);
  assert.match(b.element('testnet2-ports').textContent,/31401, 31402, 31403/);
  const noNetwork={...r,networkLedgerClosedAt:null}; const c=browser({storage:new Map([['nhr:lastReport',JSON.stringify(noNetwork)]])});
  assert.equal(c.element('network-stall').hidden,true);
  assert.match(html,/One purchase covers your whole fleet/); assert.match(html,/WHAT WE CAN'T SEE/);
});

test('score fix Testnet2 line follows the measured ports and the bigger lever', () => {
  const b = browser();
  const allPorts = Array.from({ length: 10 }, (_, i) => ({ port: 31400 + i, open: i >= 1 && i <= 3 }));
  const behind = observed('a', '2026-11-20T12:00:00Z', 200000, 'bad', 3);
  behind.ports = allPorts;
  behind.fixes = [{ title: 'Let your node catch up', why: '', how: '' }, { title: 'No action needed — software range', why: '', how: '' }];
  assert.equal(evaluate(b, 'scoreFix(' + JSON.stringify(behind) + ', scoreFor(' + JSON.stringify(behind) + '))'), 'The fix that raises it most: Let your node catch up (+50).');
  const legacy = observed('a', '2026-11-20T12:00:00Z', 0, 'warn', 3);
  legacy.ports = allPorts;
  legacy.fixes = [{ title: 'Open the missing ports', why: '', how: '' }];
  assert.equal(evaluate(b, 'scoreFix(' + JSON.stringify(legacy) + ', scoreFor(' + JSON.stringify(legacy) + '))'), 'Nothing you can open — the unpublished ports belong to the software, not your setup.');
});

test('round three breakdown uses measured points and clears rows for unscored legacy reports', () => {
  const b = browser();
  for (const [gap, points] of [[0,50],[3,45],[11,30],[1001,15],[100001,0]]) {
    const r = observed('a', new Date().toISOString(), gap, 'ok', 8);
    evaluate(b, 'renderReportExtras(' + JSON.stringify(r) + ')');
    const rows = b.element('score-breakdown');
    assert.equal(rows.hidden, false);
    assert.equal(rows.children[0].textContent, 'Ports — 8 of 10 open · 40 points');
    assert.equal(rows.children[1].textContent, 'Sync — ' + gap + ' blocks behind the network · ' + points + ' points');
    assert.match(b.element('score-value').textContent, new RegExp('^' + (40 + points) + ' of 100'));
    assert.ok(rows.children.every(row => row.children.some(c => c.className === 'num')));
  }
  evaluate(b, 'renderReportExtras({host:"legacy"})');
  assert.equal(b.element('score-breakdown').hidden, true);
  assert.equal(b.element('score-breakdown').children.length, 0);
  assert.equal(b.element('score-value').textContent, "Not scored yet — enter your node's current ledger so sync can be measured.");
});

test('round three best score requires two scored stored checks and appears on card and report', () => {
  const a = observed('a', '2026-11-14T12:00:00Z', 3, 'ok');
  const z = observed('a', '2026-11-15T12:00:00Z', 11, 'warn', 8);
  const b = browser({ storage: new Map([['nhr:lastReport', JSON.stringify(z)], ['nhr:history', JSON.stringify([a,z])]]) });
  assert.equal(evaluate(b, 'bestFor("a")'), 'Best so far: 95 · 14 Nov');
  assert.equal(b.element('report-best').textContent, 'Best so far: 95 · 14 Nov');
  assert.match(b.element('fleet-list').textContent, /Best so far: 95 · 14 Nov/);
  evaluate(b, 'history = ' + JSON.stringify([a, {...z, syncGap:null}, {...z, host:'other'}]));
  assert.equal(evaluate(b, 'bestFor("a")'), null);
});

test('round three fleet filters share exact counts and worst-first ordering without persistence', () => {
  const reports = [observed('good', new Date().toISOString(), 0, 'ok'), observed('low', new Date().toISOString(), 200000, 'bad', 1), observed('bad-section', new Date().toISOString(), 0, 'ok')];
  reports[2].sections.ports = { ...reports[2].sections.ports, level: 'bad' };
  const storage = new Map([['nhr:fleet', JSON.stringify(['good','new','bad-section','low'].map(host => ({host,label:host})))], ['nhr:history', JSON.stringify(reports)]]);
  const b = browser({storage}), before = Array.from(storage.entries());
  assert.equal(evaluate(b, 'fleetHealth({})'), 'attention');
  assert.equal(b.element('fleet-strip').textContent, '4 watched · 1 healthy · 3 need a look');
  assert.deepEqual(b.element('fleet-filters').children.map(c => c.textContent), ['All 4','Needs attention 3','Healthy 1']);
  assert.deepEqual(b.element('fleet-list').children.map(c => c.children[1].textContent), ['low','bad-section','good','new']);
  b.element('fleet-filters').children[1].onclick();
  assert.deepEqual(b.element('fleet-list').children.map(c => c.children[1].textContent), ['low','bad-section','new']);
  assert.match(b.element('fleet-list').children.at(-1).textContent, /Not checked yet/);
  b.element('fleet-filters').children[2].onclick();
  assert.equal(b.element('fleet-list').children.length, 1);
  assert.equal(b.element('fleet-filters').children[2].ariaPressed, 'true');
  assert.deepEqual(Array.from(storage.entries()), before);
  assert.equal(browser({storage}).element('fleet-list').children.length, 4);
});

test('round three stale threshold strikes only score digits and keeps fresh rendering', () => {
  const now = Date.now(), r = observed('a', new Date(now - 2 * 86400000).toISOString(), 0, 'ok');
  const b = browser({storage:new Map([['nhr:lastReport',JSON.stringify(r)]])});
  assert.equal(evaluate(b, 'staleAge(' + JSON.stringify(r) + ',' + now + ')'), 'checked 2 days ago');
  assert.equal(evaluate(b, 'staleAge({checkedAt:"invalid"})'), null);
  assert.equal(evaluate(b, 'staleAge({checkedAt:new Date(' + now + '-STALE_AFTER_MS).toISOString()},' + now + ')'), null);
  assert.match(b.element('score-value').children[0].className, /stale-score/);
  assert.equal(b.element('score-value').children.at(-1).className, undefined);
  assert.equal(b.element('score-freshness').textContent, 'STALE · checked 2 days ago');
  assert.equal(b.element('fleet-list').children[0].children[2].children[4].children[1].className, 'stale-score');
  evaluate(b, 'renderReportExtras(' + JSON.stringify({...r,checkedAt:new Date(now).toISOString()}) + ')');
  assert.equal(b.element('score-value').children[0].className, 'num ok');
  assert.equal(b.element('score-freshness').hidden, true);
});

test('round three check-all timestamp is stored only after real successful completion and restored', async () => {
  const r = observed('a', new Date().toISOString(), null), storage = new Map([['nhr:fleet',JSON.stringify([{host:'a',label:'A'}])]]);
  const b = browser({storage,checkResponse:r});
  assert.doesNotMatch(b.element('fleet-strip').textContent, /last check-all/);
  await b.element('check-all').click();
  assert.ok(Number.isFinite(Date.parse(JSON.parse(storage.get('nhr:lastCheckAll')))));
  assert.match(browser({storage}).element('fleet-strip').textContent, /last check-all \d{2}:\d{2}$/);
  const failedStorage = new Map([['nhr:fleet',JSON.stringify([{host:'a',label:'A'}])]]);
  const failed = browser({storage:failedStorage,checkError:'no_completed_check'});
  await failed.element('check-all').click();
  assert.equal(failedStorage.has('nhr:lastCheckAll'), false);
});

test('round three queued check-all waits for the retry before recording completion', async () => {
  const storage = new Map([['nhr:fleet', JSON.stringify([{host:'a',label:'A'}])], ['nhr:lastCheckAll', JSON.stringify('invalid')]]);
  const b = browser({storage,checkError:'check_too_frequent'}), clock = fakeClock(b);
  await b.element('check-all').click();
  assert.doesNotMatch(b.element('fleet-strip').textContent, /last check-all/);
  assert.equal(JSON.parse(storage.get('nhr:lastCheckAll')), 'invalid');
  b.context.fetch = async () => ({ok:true,json:async () => observed('a',new Date().toISOString(),null)});
  await clock.tick();
  assert.ok(Number.isFinite(Date.parse(JSON.parse(storage.get('nhr:lastCheckAll')))));
  assert.match(b.element('fleet-strip').textContent, /last check-all \d{2}:\d{2}$/);
});

test('sample report is a labelled example in the real format with no ledger numbers or export buttons', () => {
  const start = html.indexOf('<section id="sample-report"');
  const end = html.indexOf('<section class="card" aria-labelledby="limits-title">');
  assert.ok(start > -1 && end > start, 'sample section is placed before the limits section');
  const sample = html.slice(start, end);
  assert.equal(sample.split('Sample — an example in the real format, address hidden. Yours will name your node and show its own numbers.').length - 1, 2);
  assert.match(sample, /<span class="pill neutral" id="sample-tag">SAMPLE<\/span>/);
  assert.match(sample, />sample-node</);
  assert.match(sample, /31400–31409/);
  assert.match(sample, /<span class="num">10<\/span> of <span class="num">10<\/span>/);
  assert.match(sample, /sync gap <span class="num">3<\/span> blocks/);
  assert.match(sample, /protocol <span class="num">20<\/span>/);
  assert.match(sample, /<span class="num ok">95<\/span> of <span class="num">100<\/span> — Healthy/);
  const points = [...sample.matchAll(/class="num ok">(\d+)<\/span> pts/g)].map(match => Number(match[1]));
  assert.deepEqual(points, [50, 45]);
  assert.equal(points[0] + points[1], 95);
  assert.doesNotMatch(sample, /share-card|proof-download|Share report card|Download proof/);
  assert.doesNotMatch(sample, /networkLedger|nodeLedger|Network ledger|Node ledger/);
  assert.match(html, /<a id="sample-report-link" href="#sample-report" role="button" aria-expanded="false" aria-controls="sample-report">See a sample report<\/a>/);
});

test('sample report opens beside the purchase surface without entering storage, fleet or history', async () => {
  const storage = new Map();
  const b = browser({ storage });
  const snapshot = () => JSON.stringify([...storage]);
  const before = snapshot();
  assert.equal(b.element('sample-report').hidden, true);
  await b.element('sample-report-link').click();
  assert.equal(b.element('sample-report').hidden, false);
  assert.equal(b.element('sample-report-link').ariaExpanded, 'true');
  assert.equal(snapshot(), before);
  assert.equal(evaluate(b, 'fleet.length'), 0);
  assert.equal(evaluate(b, 'history.length'), 0);
  await b.element('sample-close').click();
  assert.equal(b.element('sample-report').hidden, true);
  assert.equal(b.element('sample-report-link').ariaExpanded, 'false');
});

test('a fleet filter with no matches offers only the clear-filter empty state', () => {
  const r = observed('ok.example', '2026-11-20T12:00:00Z', 0, 'ok');
  const b = browser({ storage: new Map([
    ['nhr:fleet', JSON.stringify([{ host: r.host, label: 'OK' }])],
    ['nhr:history', JSON.stringify([r])],
  ]) });
  evaluate(b, "setFleetFilter('attention')");
  const empty = b.element('fleet-list').children[0];
  assert.equal(empty.className, 'empty-state');
  assert.equal(empty.children[0].textContent, 'No nodes match');
  assert.equal(empty.children[1].textContent, 'Clear the filter to see the whole fleet.');
  assert.equal(empty.children[2].textContent, 'Clear filter');
  empty.children[2].onclick();
  assert.equal(b.element('fleet-list').children[0].className, 'fleet-entry');
  assert.match(b.element('fleet-verdict').textContent, /All 1 node is healthy/);
});

test('gate repairs legacy fields, invalid entries and conflicting ports', () => {
  const b = browser();
  const r = {...observed(' EXAMPLE.COM. ', '2026-11-20T12:00:00Z', -1, 'ok', 11), fixes:[null,{}, {title:'Keep'}], ports:[null,{port:31400,open:true},{port:31400,open:false},{port:31401,open:true},{port:31401,open:true},{port:1,open:true},{port:31402,open:1}], sections:{status:checkReport.sections.status}};
  const clean = evaluate(b, 'sanitizeReport('+JSON.stringify(r)+')');
  assert.equal(clean.host,'example.com'); assert.equal(clean.syncGap,null); assert.equal(clean.portsOpen,null);
  assert.equal(clean.fixes.length,1); assert.equal(clean.ports.length,1); assert.equal(clean.ports[0].port,31401);
  assert.equal(clean.sections.sync.line,'Unknown'); assert.equal(clean.sections.ports.line,'Unknown');
  assert.doesNotThrow(()=>evaluate(b,'cardLines('+JSON.stringify(clean)+'); proofText('+JSON.stringify(clean)+')'));
});
test('gate drops uninterpretable reports and enforces the five minute future rule', () => {
  const b=browser(), now=Date.now();
  for(const r of [null,3,[],{}, {...checkReport,host:''},{...checkReport,host:' '},{...checkReport,sections:null},{...checkReport,checkedAt:'bad'},{...checkReport,checkedAt:new Date(now+360000).toISOString()}]) assert.equal(evaluate(b,'sanitizeReport('+JSON.stringify(r)+','+now+')'),null);
  assert.ok(evaluate(b,'sanitizeReport('+JSON.stringify({...checkReport,checkedAt:new Date(now+240000).toISOString()})+','+now+')'));
});
test('gate normalizes fleet and history, keeps last duplicate and boots malformed legacy exports', () => {
  const a=observed(' A. ','2026-11-20T12:00:00Z',3,'ok'), z={...a,host:'a',portsOpen:8,fixes:[null],ports:[null]};
  const storage=new Map([['nhr:history',JSON.stringify([a,a,z])],['nhr:lastReport',JSON.stringify(z)],['nhr:fleet',JSON.stringify([{host:' A. ',label:'First'},{host:'a',label:'Second'},null])],['nhr:lastCheckAll',JSON.stringify(new Date(Date.now()+360000).toISOString())]]);
  const b=browser({storage}); assert.equal(evaluate(b,'history.length'),1); assert.equal(evaluate(b,'history[0].portsOpen'),8);
  assert.equal(evaluate(b,'fleet.length'),1); assert.equal(evaluate(b,'fleet[0].label'),'First'); assert.equal(evaluate(b,'lastCheckAll'),null);
  assert.equal(b.element('storage-repaired').hidden,false); assert.match(b.element('score-value').textContent,/85/);
  assert.doesNotThrow(()=>evaluate(b,'cardLines(lastReport);proofText(lastReport)'));
  const legacy={...a,host:'a'}; delete legacy.fixes;
  const c=browser({storage:new Map([['nhr:lastReport',JSON.stringify(legacy)],['nhr:history',JSON.stringify([{...legacy,checkedAt:'2026-11-19T12:00:00Z'}])]])});
  assert.match(evaluate(c,'bestFor("a")'),/95/);
  assert.equal(browser().element('storage-repaired').hidden,true);
  assert.equal(browser({storage:new Map([['nhr:lastReport',JSON.stringify(checkReport)]])}).element('storage-repaired').hidden,true);
});
test('score validation accepts integer endpoints and zero while rejecting corrupt measurements', () => {
  const b=browser();
  for(const open of [0,1,2,3,4,5,6,7,8,9,10,11,-1,9.5,'10']) {
    const score=evaluate(b,'scoreFor('+JSON.stringify(observed('a','2026-11-20T12:00:00Z',200000,'ok',open))+')');
    if(Number.isInteger(open)&&open>=0&&open<=10) assert.equal(score.value,open*5); else assert.equal(score,null);
  }
  assert.equal(evaluate(b,'scoreFor('+JSON.stringify(observed('a','2026-11-20T12:00:00Z',-1))+')'),null);
  evaluate(b,'history='+JSON.stringify([observed('a','2026-11-19T12:00:00Z',200000,'bad',0),observed('a','2026-11-20T12:00:00Z',200000,'bad',0)]));
  assert.match(evaluate(b,'bestFor("a")'),/^Best so far: 0/);
});
test('newest check governs health and explains a newly unmeasured score', () => {
  const a=observed('a','2026-11-19T12:00:00Z',3,'ok');
  for(const [gap,level,open,expected,hint] of [[null,'bad',10,'attention',true],[null,'ok',10,'attention',true],[11,'ok',8,'healthy',false],[1001,'ok',10,'attention',false]]) {
    const z=observed('a','2026-11-20T12:00:00Z',gap,level,open);
    const b=browser({storage:new Map([['nhr:lastReport',JSON.stringify(z)],['nhr:history',JSON.stringify([a,z])]])});
    assert.equal(evaluate(b,'fleetHealth(latestFor("a"))'),expected);
    assert.equal(b.element('fleet-list').textContent.includes('Sync unmeasured on the latest check'),hint);
    evaluate(b,'setFleetFilter("healthy")'); assert.equal(evaluate(b,'visibleFleet().length'),expected==='healthy'?1:0);
  }
});
test('fleet order uses scored, unscored and never tiers with host ties and real zero', () => {
  const b=browser();
  const rows=[observed('thirty','2026-11-20T12:00:00Z',200000,'bad',6),observed('ninety','2026-11-20T12:00:00Z',0,'ok',8),observed('unscored','2026-11-20T12:00:00Z',null),observed('zero','2026-11-20T12:00:00Z',200000,'bad',0),observed('alpha','2026-11-20T12:00:00Z',0,'ok',8)];
  evaluate(b,'history='+JSON.stringify(rows));
  assert.equal(evaluate(b,'fleetOrder('+JSON.stringify(['never','unscored','ninety','thirty','zero','alpha'].map(host=>({host})))+').map(n=>n.host).join(",")'),'zero,thirty,alpha,ninety,unscored,never');
});
test('run identity excludes manual successes and removal completes the pending run', async () => {
  const b=fleetBrowser(1); fakeClock(b);
  evaluate(b,'activeRun={hosts:new Set([fleet[0].host]),pending:new Set([fleet[0].host]),done:0,failed:0}');
  b.context.fetch=async()=>({ok:true,json:async()=>observed('0.example','2026-11-20T12:00:00Z',0,'ok')});
  await evaluate(b,'performCheck(fleet[0])'); assert.equal(evaluate(b,'activeRun.pending.size'),1); assert.equal(evaluate(b,'lastCheckAll'),null);
  b.element('fleet-list').children[0].children.at(-1).onclick();
  assert.equal(evaluate(b,'activeRun'),null); assert.ok(evaluate(b,'lastCheckAll'));
});
test('run failures render exact partial and zero-done reason without stamping', async () => {
  const b=fleetBrowser(2), clock=fakeClock(b); let attempts=0;
  b.context.fetch=async(url,options)=>({ok:++attempts===1,json:async()=>attempts===1?observed(JSON.parse(options.body).host,'2026-11-20T12:00:00Z',0,'ok'):{error:'invalid_host'}});
  const run=b.element('check-all').click(); await flush(); await clock.tick(); await run;
  assert.equal(b.element('fleet-progress').textContent,'Checked 1 of 2 nodes — the rest could not be measured this time.'); assert.equal(evaluate(b,'lastCheckAll'),null);
  const c=fleetBrowser(1); c.context.fetch=async()=>{throw Error('offline')}; await c.element('check-all').click();
  assert.equal(c.element('fleet-progress').textContent,'The checks could not be completed — '+c.element('check-result').textContent); assert.equal(evaluate(c,'lastCheckAll'),null);
});
test('429 retry carrying a dead run checks but cannot stamp the replacement run', async () => {
  const b=fleetBrowser(1), clock=fakeClock(b);
  b.context.fetch=async()=>({ok:false,json:async()=>({error:'check_too_frequent'})});
  await b.element('check-all').click();
  evaluate(b,'activeRun={hosts:new Set(["other"]),pending:new Set(["other"]),done:0,failed:0}');
  b.context.fetch=async()=>({ok:true,json:async()=>observed('0.example','2026-11-20T12:00:00Z',0,'ok')});
  await clock.tick(); assert.equal(evaluate(b,'lastCheckAll'),null); assert.equal(evaluate(b,'activeRun.done'),0);
});
test('best score ties choose the latest date and qualify a different UTC year', () => {
  const b=browser();
  evaluate(b,'history='+JSON.stringify([observed('a','2026-11-14T12:00:00Z',3,'ok'),observed('a','2026-11-15T12:00:00Z',3,'ok')]));
  assert.equal(evaluate(b,'bestFor("a")'),'Best so far: 95 · 15 Nov');
  evaluate(b,'history='+JSON.stringify([observed('a','2025-12-31T12:00:00Z',3,'ok'),observed('a','2026-11-15T12:00:00Z',11,'ok')]));
  assert.equal(evaluate(b,'bestFor("a")'),'Best so far: 95 · 31 Dec 2025');
});
test('strip inflects counts, qualifies old dates and preserves children for unchanged text', () => {
  const b=fleetBrowser(1);
  assert.equal(b.element('fleet-strip').textContent,'1 watched · 0 healthy · 1 needs a look');
  const children=b.element('fleet-strip').children.slice(); evaluate(b,'progress.set(fleet[0].host,"CHECKING");renderFleet()');
  assert.ok(children.every((child,i)=>b.element('fleet-strip').children[i]===child));
  assert.equal(fleetBrowser(2).element('fleet-strip').textContent,'2 watched · 0 healthy · 2 need a look');
  process.env.TZ='UTC';
  b.context.Date=class extends Date { constructor(...args){super(...(args.length?args:['2026-11-21T13:00:00Z']));} static now(){return Date.parse('2026-11-21T13:00:00Z');} };
  evaluate(b,'lastCheckAll="2026-11-20T12:04:00Z";renderFleet()');
  assert.equal(b.element('fleet-strip').textContent,'1 watched · 0 healthy · 1 needs a look · last check-all 12:04 · 20 Nov');
  evaluate(b,'lastCheckAll="2026-11-21T12:04:00Z";renderFleet()');
  assert.equal(b.element('fleet-strip').textContent,'1 watched · 0 healthy · 1 needs a look · last check-all 12:04');
});
test('stale accessibility names and refresh events follow the exact crossed boundary', () => {
  assert.match(html,/id="score-value" aria-describedby="score-freshness"/);
  const b=browser(); let now=Date.parse('2026-11-21T12:00:00Z'); const events=b.events,timers=new Map(); let id=0;
  b.context.Date=class extends Date {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}};
  b.context.setTimeout=(callback,delay)=>{timers.set(++id,{callback,delay});return id;}; b.context.clearTimeout=id=>timers.delete(id);
  const r=observed('a','2026-11-20T12:00:00Z',0,'ok');
  evaluate(b,'history=['+JSON.stringify(r)+']; fleet=[{host:"a",label:"A"}];lastReport=history[0];document.getElementById("report").hidden=false;renderFleet();renderReportExtras(lastReport)');
  const dd=()=>b.element('fleet-list').children[0].children[2].children[4].children[1];
  assert.equal(dd().ariaLabel,undefined); assert.equal(timers.size,1); assert.equal([...timers.values()][0].delay,50);
  now++; b.context.document.visibilityState='visible'; events.visibilitychange();
  assert.equal(dd().ariaLabel,'100, stale, checked 1 day ago'); assert.match(b.element('score-freshness').textContent,/STALE/); assert.equal(timers.size,0);
  now=Date.parse(r.checkedAt); events.focus(); assert.equal(dd().ariaLabel,undefined); assert.equal(timers.size,1);
  now+=86400051; [...timers.values()][0].callback(); assert.equal(dd().ariaLabel,'100, stale, checked 1 day ago');
});
test('sample blockchain sync number uses the same monospace markup as its breakdown', () => {
  assert.match(html, /Blockchain sync <span class="ok"><span class="num">3<\/span> blocks behind the network<\/span>/);
});
test('throwing storage survives load, rendering and successful check persistence', async () => {
  const b=browser({throwingStorage:true,checkResponse:observed('example.com','2026-11-20T12:00:00Z',0,'ok')});
  await b.element('signin').click(); await runCheck(b);
  assert.equal(evaluate(b,'history.length'),1); assert.equal(b.element('check-result').textContent,'Healthy');
  assert.doesNotThrow(()=>evaluate(b,'renderFleet();renderReportExtras(lastReport);persistFleet()'));
});
test('fleet counts stay consistent across add, check and removal of the last filtered match', async () => {
  const b=browser({checkResponse:observed('example.com','2026-11-20T12:00:00Z',0,'ok')});
  b.element('node-host').value='example.com';b.element('own-node').checked=true;await b.element('add-node').click();
  assert.equal(b.element('fleet-strip').textContent,'1 watched · 0 healthy · 1 needs a look');
  await runCheck(b); assert.equal(b.element('fleet-strip').textContent,'1 watched · 1 healthy · 0 need a look');
  assert.deepEqual(b.element('fleet-filters').children.map(c=>c.textContent),['All 1','Needs attention 0','Healthy 1']);
  evaluate(b,'setFleetFilter("healthy")'); b.element('fleet-list').children[0].children.at(-1).onclick();
  assert.equal(b.element('fleet-list').children[0].children[0].textContent,'No nodes yet');
  evaluate(b,'fleet.push({host:"other",label:"Other"});renderFleet()');
  assert.equal(b.element('fleet-list').children[0].children[0].textContent,'No nodes match');
  assert.equal(b.element('fleet-strip').textContent,'1 watched · 0 healthy · 1 needs a look');
});
test('removing the last healthy filtered match leaves the no-match state', () => {
  const b=browser({storage:new Map([['nhr:fleet',JSON.stringify([{host:'a',label:'A'},{host:'unchecked',label:'Unchecked'}])],['nhr:history',JSON.stringify([observed('a','2026-11-20T12:00:00Z',0,'ok')])]])});
  evaluate(b,'setFleetFilter("healthy")'); b.element('fleet-list').children[0].children.at(-1).onclick();
  assert.equal(b.element('fleet-list').children[0].children[0].textContent,'No nodes match');
  assert.deepEqual(b.element('fleet-filters').children.map(c=>c.textContent),['All 1','Needs attention 1','Healthy 0']);
});
test('L6 legacy report renders and completes share and proof exports', async () => {
  const r={...observed('legacy','2026-11-20T12:00:00Z',3,'ok'),sections:{status:{level:'ok',line:'Healthy'}}};delete r.fixes;
  const b=browser({storage:new Map([['nhr:lastReport',JSON.stringify(r)]])});
  const created=[]; const create=b.context.document.createElement;
  b.context.document.createElement=tag=>{
    const el=create(tag); created.push({tag,el}); el.click=()=>{};
    if(tag==='canvas'){el.getContext=()=>({fillRect(){},fillText(){}});el.toBlob=cb=>cb({});} return el;
  };
  b.context.File=class {};b.context.Blob=class {};b.context.navigator={};b.context.URL={createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}};
  await b.element('share-card').click(); b.element('proof-download').click();
  assert.ok(created.some(x=>x.tag==='canvas')); assert.equal(created.filter(x=>x.tag==='a').length,2);
  assert.match(evaluate(b,'proofText(lastReport)'),/Sync: Unknown\nPorts: Unknown/);
});
test('gate repair matrix preserves valid fields and flags only actual changes', () => {
  const b=browser(), valid=observed('a','2026-11-20T12:00:00Z',0,'ok');
  for(const [field,values] of [['syncGap',[-1,1.5,'1',{}]],['portsOpen',[-1,11,9.5,'10',{}]]]) for(const value of values) {
    evaluate(b,'storageRepaired=false');
    assert.equal(evaluate(b,'sanitizeReport('+JSON.stringify({...valid,[field]:value})+')['+JSON.stringify(field)+']'),null);
    assert.equal(evaluate(b,'storageRepaired'),true);
  }
  for(const fixes of [undefined,null,{},'broken',[null,3,{}, {title:3}]]) {
    const r={...valid,fixes}; const c=browser({storage:new Map([['nhr:lastReport',JSON.stringify(r)]])});
    assert.equal(evaluate(c,'lastReport.fixes.length'),0); assert.equal(c.element('storage-repaired').hidden,false);
    assert.match(c.element('score-value').textContent,/100 of 100/);
  }
  for(const ports of [undefined,null,{},'absent']) {
    const r={...valid,ports}; evaluate(b,'storageRepaired=false');
    assert.equal(evaluate(b,'JSON.stringify(sanitizeReport('+JSON.stringify(r)+').ports)'),undefined);
    assert.equal(evaluate(b,'storageRepaired'),ports !== undefined);
  }
  for(const section of [null,3,{}, {level:'ok'}]) {
    const r={...valid,sections:{...valid.sections,sync:section,ports:section}};
    assert.equal(evaluate(b,'sanitizeReport('+JSON.stringify(r)+').sections.sync.line'),'Unknown');
  }
  const c=browser({storage:new Map([['nhr:lastReport',JSON.stringify({...valid,checkedAt:'invalid'})]])});
  assert.equal(evaluate(c,'lastReport'),null); assert.equal(c.element('check-node').textContent,'');
  const d=browser({storage:new Map([['nhr:history','{}'],['nhr:fleet','{}'],['nhr:lastCheckAll','42']])});
  assert.equal(evaluate(d,'history.length+fleet.length'),0); assert.equal(evaluate(d,'lastCheckAll'),null); assert.equal(d.element('storage-repaired').hidden,false);
});
test('fresh response gate repairs optional fields and retains a live future response', async () => {
  for(const checkedAt of ['2026-11-20T12:00:00Z',new Date(Date.now()+360000).toISOString()]) {
    const r={...observed('example.com',checkedAt,0,'ok'),fixes:{}};
    const b=browser({checkResponse:r});await runCheck(b);
    assert.equal(evaluate(b,'history.length'),1);assert.equal(evaluate(b,'lastReport.checkedAt'),checkedAt);
  }
});

test('E1 malformed status and fixes boot, render, share and prove without undefined', async () => {
  const variants = [
    {status:'broken'}, {status:{}}, {status:{level:'bad'}}, {status:null}, {status:false},
    {fixes:[{title:'Repair'}]}, {fixes:[{title:'Repair',why:42}]},
    {status:{level:'error',line:'Unknown state'}},
  ];
  for (const variant of variants) {
    const r=observed('a','2026-11-20T12:00:00Z',100,'bad');
    if ('status' in variant) r.sections={...r.sections,status:variant.status};
    if (variant.fixes) r.fixes=variant.fixes;
    const b=browser({storage:new Map([['nhr:lastReport',JSON.stringify(r)]])});
    const drawn=[], blobs=[]; const create=b.context.document.createElement;
    b.context.document.createElement=tag=>{const el=create(tag);el.click=()=>{};
      if(tag==='canvas'){el.getContext=()=>({fillRect(){},fillText(text){drawn.push(text);}});el.toBlob=cb=>cb({});}return el;};
    b.context.File=class {};b.context.Blob=class {constructor(parts){blobs.push(parts.join(''));}};
    b.context.navigator={};b.context.URL={createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}};
    await b.element('share-card').click();b.element('proof-download').click();
    const output=['check-node','report-history','fixes','score-value'].map(id=>b.element(id).textContent).join(' ');
    assert.doesNotMatch(output+drawn.join(' ')+blobs.join(' ')+evaluate(b,'proofText(lastReport)'),/undefined/);
    assert.ok(drawn.length); assert.ok(blobs.length);
    if (variant.fixes) assert.equal(b.element('fixes').textContent,'Repair');
    if (variant.status?.level==='error') assert.equal(evaluate(b,'lastReport.sections.status.level'),'');
    if (typeof variant.status==='string' || variant.status && !variant.status.line) assert.equal(b.element('check-node').textContent,'Unknown');
  }
});

test('E3 history syncGap 100 governs divergent lastReport syncGap 0 before rendering', () => {
  const record=observed('a','2026-11-20T12:00:00Z',100,'ok');
  const storage=new Map([['nhr:history',JSON.stringify([record])],['nhr:lastReport',JSON.stringify({...record,syncGap:0})]]);
  const b=browser({storage});
  assert.equal(evaluate(b,'lastReport === history[0]'),true);
  assert.match(b.element('score-value').textContent,/80 of 100/);
  assert.equal(evaluate(b,'scoreFor(latestFor("a")).value'),80);
  assert.match(b.element('fleet-list').textContent,/80/);
  assert.doesNotMatch(evaluate(b,'cardLines(lastReport).join(" ")'),/100 of 100/);
});

function boundaryClock(b, initial) {
  let now=initial, id=0; const timers=new Map();
  b.context.Date=class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  b.context.setTimeout=(callback,delay)=>{timers.set(++id,{callback,delay,at:now+delay});return id;};
  b.context.clearTimeout=id=>timers.delete(id);
  return {timers, async fire(id){const timer=timers.get(id);assert.ok(timer);timers.delete(id);now=timer.at;const result=timer.callback();await flush();return result;}};
}

test('E4 manual 429 then check-all 429 shares the retry and stamps the waiting run', async () => {
  const b=fleetBrowser(1), clock=boundaryClock(b,Date.parse('2026-11-20T12:00:00Z')); let attempts=0;
  b.context.fetch=async()=>{const success=++attempts>2;return {ok:success,json:async()=>success?observed('0.example','2026-11-20T12:02:00Z',0,'ok'):{error:'check_too_frequent'}};};
  await evaluate(b,'performCheck(fleet[0])');
  const retryId=evaluate(b,'queuedTimers.get(fleet[0].host)');
  const run=b.element('check-all').click();await flush();
  await clock.fire([...clock.timers.keys()].find(id=>id!==retryId));await run;
  assert.equal(attempts,2);assert.equal(evaluate(b,'retryWaiters.get(fleet[0].host).size'),1);
  const retry=clock.fire(evaluate(b,'queuedTimers.get(fleet[0].host)'));await flush();
  await clock.fire([...clock.timers.keys()][0]);await retry;
  assert.equal(attempts,3);assert.equal(evaluate(b,'activeRun'),null);assert.ok(evaluate(b,'lastCheckAll'));
});

test('E4 entitlement abort cancels node 1 queued retry and prevents zombie checks', async () => {
  const b=fleetBrowser(2), clock=boundaryClock(b,Date.parse('2026-11-20T12:00:00Z'));let attempts=0;
  b.context.fetch=async()=>({ok:false,json:async()=>({error:++attempts===1?'check_too_frequent':'no_completed_check'})});
  const run=b.element('check-all').click();await flush();
  const retryId=evaluate(b,'queuedTimers.get(fleet[0].host)');
  const paceId=[...clock.timers.keys()].find(id=>id!==retryId);
  await clock.fire(paceId);await run;
  assert.equal(evaluate(b,'activeRun'),null);assert.equal(evaluate(b,'queuedTimers.size'),0);
  assert.equal(clock.timers.has(retryId),false);assert.equal(evaluate(b,'progress.size'),0);
  assert.match(b.element('fleet-progress').textContent,/could not be completed/);
  for(const id of [...clock.timers.keys()]) await clock.fire(id);
  assert.equal(attempts,2);assert.equal(evaluate(b,'lastCheckAll'),null);
});

test('E5 hidden filtered fleet still schedules freshness', () => {
  const b=browser(), now=Date.parse('2026-11-21T12:00:00Z'), clock=boundaryClock(b,now);
  const r=observed('a',new Date(now-86400000+1000).toISOString(),0,'ok');
  evaluate(b,'history=['+JSON.stringify(r)+'];fleet=[{host:"a",label:"A"}];setFleetFilter("attention")');
  assert.equal(b.element('fleet-list').children[0].children[0].textContent,'No nodes match');
  assert.equal([...clock.timers.values()][0].delay,1050);
});

test('E6 live repair and ten-minute server clock skew store sanitized reports without load hint', async () => {
  for(const ahead of [0,600000]) {
    const r={...observed('example.com',new Date(Date.now()+ahead).toISOString(),0,'ok'),fixes:[{title:'Repair',why:3}],ports:{}};
    const storage=new Map(), b=browser({storage,checkResponse:r});await runCheck(b);
    assert.equal(evaluate(b,'lastReport.checkedAt'),r.checkedAt);
    assert.equal(evaluate(b,'lastReport.fixes[0].why'),'');assert.equal(evaluate(b,'"ports" in lastReport'),false);
    assert.equal(b.element('storage-repaired').hidden,true);assert.equal(evaluate(b,'storageRepaired'),false);
    assert.equal(JSON.parse(storage.get('nhr:lastReport')).fixes[0].why,'');
  }
});

test('E6 uninterpretable live response fails the run and stores nothing', async () => {
  const b=fleetBrowser(1);b.context.fetch=async()=>({ok:true,json:async()=>({host:'0.example',checkedAt:'invalid'})});
  await b.element('check-all').click();
  assert.equal(b.element('check-result').textContent,'We could not run your check. Please try again.');
  assert.equal(evaluate(b,'history.length'),0);assert.equal(evaluate(b,'lastReport'),null);
  assert.equal(evaluate(b,'lastCheckAll'),null);assert.equal(evaluate(b,'activeRun'),null);
  assert.equal(evaluate(b,'localStorage.getItem(REPORT_KEY)'),null);assert.equal(evaluate(b,'storageRepaired'),false);
});

test('E7 gate-legal four-minute future report crosses stale at its true boundary', async () => {
  const b=browser(),now=Date.parse('2026-11-21T12:00:00Z'),clock=boundaryClock(b,now);
  const r=observed('a',new Date(now+240000).toISOString(),0,'ok');
  evaluate(b,'history=[sanitizeReport('+JSON.stringify(r)+')];fleet=[{host:"a",label:"A"}];renderFleet()');
  const [id,timer]=[...clock.timers.entries()][0];assert.equal(timer.delay,86400000+240000+50);
  assert.doesNotMatch(b.element('fleet-list').textContent,/STALE/);
  await clock.fire(id);
  assert.match(b.element('fleet-list').textContent,/STALE/);
});
