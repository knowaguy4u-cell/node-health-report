'use strict';

// TESTNET TEST-GRADE ONLY: each warm Vercel instance has its own volatile store.
// Production needs a durable shared store with atomic transactions / distributed
// locks. Process crashes, cold starts and separate instances lose this state and
// therefore cannot guarantee once-per-user payouts or exactly-once fulfillment.
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
  async withLock(key, work) {
    const { HttpError } = require('./errors');
    if (this.locks.has(key)) throw new HttpError(409, 'operation_in_flight');
    this.locks.add(key);
    try { return await work(); }
    finally { this.locks.delete(key); }
  }
}

module.exports = { MemoryStore, store: new MemoryStore() };
