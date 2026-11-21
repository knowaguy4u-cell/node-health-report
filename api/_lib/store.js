'use strict';

// Without durable-store configuration, state is volatile and local to this instance.
class MemoryStore {
  constructor() {
    this.values = new Map();
    this.locks = new Set();
  }
  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
  // Cross-instance locking is best-effort; payment safety does not depend on it —
  // the chain checks carry that. This lock stays in-process in both store modes.
  async withLock(key, work) {
    const { HttpError } = require('./errors');
    if (this.locks.has(key)) throw new HttpError(409, 'operation_in_flight');
    this.locks.add(key);
    try { return await work(); }
    finally { this.locks.delete(key); }
  }
}

class RestStore extends MemoryStore {
  constructor(url, token, fetchImpl = fetch) {
    super();
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async command(command) {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error('Store REST request failed');
    const body = await response.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Store REST command failed');
    return body.result;
  }
  async get(key) {
    const value = await this.command(['GET', key]);
    return value === null ? undefined : JSON.parse(value);
  }
  async set(key, value) {
    await this.command(['SET', key, JSON.stringify(value)]);
  }
}

const { NHR_STORE_URL, NHR_STORE_TOKEN } = process.env;
const store = NHR_STORE_URL && NHR_STORE_TOKEN
  ? new RestStore(NHR_STORE_URL, NHR_STORE_TOKEN)
  : new MemoryStore();
module.exports = { MemoryStore, store };
