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
    if (!elements.has(id)) {
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
      elements.set(id, el);
    }
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
  const context = vm.createContext({ Pi, localStorage, document: { getElementById: element, createElement: () => ({ children: [], appendChild(child) { this.children.push(child); } }) },
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
  return { context, element, calls, get callbacks() { return callbacks; }, get paymentData() { return paymentData; }, get init() { return init; } };
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
  assert.equal(b.element('fleet-verdict').textContent, 'All 1 nodes are healthy.');
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
  assert.doesNotMatch(html, /under a minute/);
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
    assert.equal(b.element('fleet-progress').textContent, b.element('check-result').textContent);
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
  assert.deepEqual(entry.children[2].children.map(cell => cell.children[1].textContent), ['—', '—', '—', '—']);
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
  assert.doesNotMatch(html, /\b(peers|docker)\b/i);
});

test('removing the final node stays removed after reload without erasing history', () => {
  const report = observed('example.com', '2026-11-20T12:00:00Z', 0, 'ok');
  const storage = new Map([['nhr:lastReport', JSON.stringify(report)]]);
  const b = browser({ storage });
  b.element('fleet-list').children.at(-1).children.at(-1).onclick();
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

test('empty fleet offers an honest starting point and clears it when a node is added', async () => {
  const b = browser();
  const empty = b.element('fleet-list').children[0];
  assert.equal(empty.className, 'empty-state');
  assert.equal(empty.children[0].textContent, 'Your fleet starts here');
  assert.match(empty.children[1].textContent, /on this device/);
  assert.equal(b.element('check-all').disabled, true);
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

  const warn = observed('warn.example', '2026-11-20T12:00:00Z', 25, 'warn');
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
