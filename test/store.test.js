'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const storeRequire = require('node:module').createRequire(require.resolve('../api/_lib/store'));
const source = readFileSync(require.resolve('../api/_lib/store'), 'utf8');
const configured = { NHR_STORE_URL: 'https://store.example', NHR_STORE_TOKEN: 'fixture-token' };
function loadStore(env, fetchImpl) {
  const context = vm.createContext({ module: { exports: {} }, process: { env }, fetch: fetchImpl, structuredClone, require: storeRequire });
  vm.runInContext(source, context);
  return context.module.exports;
}

for (const value of ['fixture-string', 42, { status: 'completed', count: 1 }]) {
  test(`REST store round-trips ${typeof value}`, async () => {
    const values = new Map();
    const { store } = loadStore(configured, async (url, options) => {
      assert.equal(url, configured.NHR_STORE_URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const command = JSON.parse(options.body);
      assert.equal(command[1], 'fixture-key');
      if (command[0] === 'SET') {
        assert.equal(command[2], JSON.stringify(value));
        values.set(command[1], command[2]);
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      assert.equal(command[0], 'GET');
      return { ok: true, json: async () => ({ result: values.get(command[1]) ?? null }) };
    });
    assert.equal(await store.get('fixture-key'), undefined);
    await store.set('fixture-key', value);
    assert.equal(JSON.stringify(await store.get('fixture-key')), JSON.stringify(value));
  });
}

test('missing either store environment variable selects unchanged memory storage', async () => {
  for (const env of [{}, { NHR_STORE_URL: configured.NHR_STORE_URL }, { NHR_STORE_TOKEN: configured.NHR_STORE_TOKEN }]) {
    const { MemoryStore, store } = loadStore(env, () => { throw new Error('must not fetch'); });
    assert.ok(store instanceof MemoryStore);
    const value = { count: 1 };
    await store.set('key', value);
    value.count = 2;
    assert.deepEqual(await store.get('key'), { count: 1 });
    assert.equal(await store.get('missing'), undefined);
  }
});

test('REST failures propagate without memory fallback', async () => {
  const failure = new Error('fixture network failure');
  for (const fetchImpl of [
    async () => { throw failure; },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ error: 'ERR' }) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }),
  ]) {
    const { store } = loadStore(configured, fetchImpl);
    await assert.rejects(store.set('key', 'value'));
    await assert.rejects(store.get('key'));
  }
});

test('REST store retains the in-process lock and releases it after failure', async () => {
  const { store } = loadStore(configured, () => { throw new Error('must not fetch'); });
  await assert.rejects(store.withLock('key', async () => {
    await assert.rejects(store.withLock('key', async () => {}), { code: 'operation_in_flight' });
    throw new Error('work failed');
  }), /work failed/);
  assert.equal(await store.withLock('key', async () => 'released'), 'released');
});
