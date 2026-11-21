'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;
const { HttpError } = require('./errors');
const { createPayments } = require('./payments');
const PORTS = Array.from({ length: 10 }, (_, i) => 31400 + i);

function isBlockedIP(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const clean = ip.replace(/^\[|\]$/g, '');
  if (net.isIP(clean) === 4) {
    if (clean === '0.0.0.0') return true;
    if (clean.startsWith('127.')) return true;
    if (clean.startsWith('169.254.')) return true;
    return false;
  }
  if (net.isIP(clean) === 6) {
    if (clean === '::' || clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
    const lower = clean.toLowerCase();
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
    const v4match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4match) return isBlockedIP(v4match[1]);
    if (/^::ffff:(7f[0-9a-f]{2}:|a9fe:|0:0)/.test(lower)) return true;
    return false;
  }
  return false;
}

function validHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253) return false;
  if (/[\s@/:?#]/.test(host)) {
    if (net.isIP(host) !== 6) return false;
  }
  let parsed;
  try {
    const isV6 = net.isIP(host) === 6;
    const urlHost = isV6 ? `[${host}]` : host;
    parsed = new URL(`http://${urlHost}`);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.port) return false;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return false;

  const h = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (isBlockedIP(h)) return false;

  const clean = h.replace(/^\[|\]$/g, '');
  if (net.isIP(clean)) return true;
  if (/^[\d.]+$/.test(clean)) return false;
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(host);
}

async function assertUnblockedHost(host, lookupImpl) {
  const clean = host.replace(/\.$/, '');
  if (net.isIP(clean)) return;
  try {
    const records = await lookupImpl(host, { all: true });
    if (Array.isArray(records)) {
      for (const rec of records) {
        if (isBlockedIP(rec.address)) {
          throw new HttpError(400, 'invalid_host');
        }
      }
    } else if (records && isBlockedIP(records.address)) {
      throw new HttpError(400, 'invalid_host');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
}

function probePorts(host, ports, timeoutMs) {
  return Promise.all(ports.map(port => new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const finish = open => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ port, open });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.on('error', () => finish(false));
    try { socket.connect({ host, port }); } catch { finish(false); }
  })));
}

function verdicts(ports, networkLedger, nodeLedger = null) {
  const portsOpen = ports.filter(p => p.open).length;
  const syncGap = nodeLedger == null ? null : Math.max(0, networkLedger - nodeLedger);
  const sections = {
    ports: { level: portsOpen === 10 ? 'ok' : portsOpen ? 'warn' : 'bad',
      line: portsOpen === 10 ? 'All 10 node ports are open' : portsOpen ? `${portsOpen} of 10 node ports are open` : 'None of your node ports answered' },
    sync: { level: syncGap === null ? 'warn' : syncGap > 1000 ? 'bad' : syncGap > 10 ? 'warn' : 'ok',
      line: syncGap === null ? "Enter your node's current ledger to measure sync" : `Your node is ${syncGap} ledgers behind the network` },
  };
  const level = Object.values(sections).some(s => s.level === 'bad') ? 'bad'
    : Object.values(sections).some(s => s.level === 'warn') ? 'warn' : 'ok';
  sections.status = { level, line: level === 'ok' ? 'Your node looks healthy' : level === 'warn' ? 'Your node needs attention' : 'Your node is at risk' };
  const fixes = [];
  const add = (section, title, why, how) => fixes.push({ level: sections[section].level, title, why, how });
  if (!portsOpen) add('ports', 'Open your node ports', 'Your node cannot be reached by the network. A node must be publicly reachable.', 'Forward ports 31400–31409 to the node in your router and allow them in your firewall.');
  else if (portsOpen < 10) add('ports', 'Open the missing ports', `These ports did not answer: ${ports.filter(p => !p.open).map(p => p.port).join(', ')}.`, 'Forward these ports to the node in your router and allow them in your firewall. Your node must be publicly reachable.');
  if (syncGap === null) add('sync', 'Add your node ledger next time', 'We need your node ledger to measure sync.', "Find the current ledger in your node software's status display.");
  else if (syncGap > 1000) add('sync', 'Let your node catch up', `Your node is ${syncGap} ledgers behind.`, 'Leave your node running and check its disk and connection.');
  else if (syncGap > 10) add('sync', 'Almost synced — give it time', `Your node is ${syncGap} ledgers behind.`, 'Leave your node running so it can catch up.');
  fixes.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
  if (!fixes.length) fixes.push({ title: 'Nothing to fix — run this check weekly', why: 'Your ports and sync look healthy.', how: 'Run this check again next week.' });
  return { portsOpen, syncGap, sections, fixes: fixes.map(({ level, ...fix }) => fix) };
}

function createCheck({ pi, ledger, store, network, probe = probePorts, lookup = dns.lookup }) {
  const payments = createPayments({ pi, ledger, store, network });
  async function hasCompletedPurchase(paymentId, user) {
    if (typeof paymentId !== 'string' || !paymentId) return false;
    let purchase;
    try {
      purchase = await pi.getPayment(paymentId);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'pi_request_failed' && error.upstreamStatus === 404) return false;
      if (error instanceof HttpError && error.status >= 500) throw error;
      return false;
    }
    try {
      payments.validate(purchase, paymentId, user, 'user_to_app', 1, 'full_health_check');
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      return false;
    }
    return Boolean(purchase.status?.developer_completed && purchase.status?.transaction_verified &&
      purchase.transaction?.verified);
  }
  return async ({ accessToken, host, nodeLedger = null, paymentId = null }) => {
    const user = await payments.identify(accessToken);
    let entitled = false;
    if (typeof user.wallet_address === 'string' && user.wallet_address) {
      const candidates = await ledger.findPaymentsFrom(user.wallet_address, '1');
      for (const candidate of candidates) {
        if (typeof candidate.memo !== 'string' || !candidate.memo) continue;
        try {
          const purchase = await pi.getPayment(candidate.memo);
          payments.validate(purchase, candidate.memo, user, 'user_to_app', 1, 'full_health_check');
          if (purchase.status?.developer_completed && purchase.status?.transaction_verified &&
              purchase.transaction?.verified && candidate.txid && purchase.transaction.txid === candidate.txid) {
            entitled = true;
            break;
          }
        } catch { continue; }
      }
    }
    if (!entitled) {
      const indexedPaymentId = await store.get(`user-payment:${user.uid}`);
      entitled = await hasCompletedPurchase(indexedPaymentId, user);
    }
    if (!entitled) entitled = await hasCompletedPurchase(paymentId, user);
    if (!entitled) throw new HttpError(403, 'no_completed_check');
    const key = `check-at:${user.uid}`;
    try { await store.withLock(key, async () => {
      const previous = await store.get(key);
      if (previous != null && Date.now() - previous < 60000) throw new HttpError(429, 'check_too_frequent');
      if (!validHost(host)) throw new HttpError(400, 'invalid_host');
      await assertUnblockedHost(host, lookup);
      if (nodeLedger !== null && (!Number.isSafeInteger(nodeLedger) || nodeLedger < 0)) throw new HttpError(400, 'invalid_nodeLedger');
      await store.set(key, Date.now());
    }); } catch (error) {
      if (error instanceof HttpError && error.code === 'operation_in_flight') throw new HttpError(429, 'check_too_frequent');
      throw error;
    }
    const ports = await probe(host, PORTS, 1200);
    const latest = await ledger.latestLedger();
    return { host, checkedAt: new Date(Date.now()).toISOString(), ports, networkLedger: latest.sequence,
      nodeLedger, ...verdicts(ports, latest.sequence, nodeLedger) };
  };
}

module.exports = { createCheck, isBlockedIP, probePorts, validHost, verdicts };
