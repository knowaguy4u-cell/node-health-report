'use strict';

const { HttpError } = require('./errors');
const { networkConfig } = require('./config');
const { horizon: HORIZON, name: NETWORK } = networkConfig();

function createLedger({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
  const { horizon: HORIZON, name: NETWORK } = networkConfig(env);
  async function request(path, options = {}) {
    try {
      return await fetchImpl(`${HORIZON}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
    } catch { throw new HttpError(502, 'horizon_unavailable'); }
  }
  async function json(path) {
    const response = await request(path);
    if (!response.ok) throw new HttpError(502, 'horizon_request_failed');
    try { return await response.json(); }
    catch { throw new HttpError(502, 'invalid_horizon_response'); }
  }
  return {
    async findPaymentsTo(recipient, amount) {
      const seed = typeof env.PI_WALLET_SEED === 'string' ? env.PI_WALLET_SEED.trim() : env.PI_WALLET_SEED;
      if (!seed) throw new HttpError(503, 'server_not_configured');
      let app;
      try { app = require('@stellar/stellar-sdk').Keypair.fromSecret(seed).publicKey(); }
      catch { throw new HttpError(503, 'transaction_build_failed'); }
      const payments = [];
      let path = `/accounts/${encodeURIComponent(app)}/operations?order=desc&limit=200`;
      for (let page = 0; page < 3 && path; page++) {
        const operations = await json(path);
        for (const op of operations._embedded?.records || []) {
          if (op.type !== 'payment' || op.from !== app || op.to !== recipient ||
              op.asset_type !== 'native' || Number(op.amount) !== Number(amount)) continue;
          const tx = await json(`/transactions/${encodeURIComponent(op.transaction_hash)}`);
          if (tx.successful === true) payments.push({ txid: tx.hash, memo: tx.memo });
        }
        const next = operations._links?.next?.href;
        const url = next ? new URL(next) : null;
        path = url ? url.pathname + url.search : null;
      }
      return payments;
    },
    async findPaymentsFrom(sender, amount) {
      const seed = typeof env.PI_WALLET_SEED === 'string' ? env.PI_WALLET_SEED.trim() : env.PI_WALLET_SEED;
      if (!seed) throw new HttpError(503, 'server_not_configured');
      let app;
      try { app = require('@stellar/stellar-sdk').Keypair.fromSecret(seed).publicKey(); }
      catch { throw new HttpError(503, 'transaction_build_failed'); }
      const payments = [];
      let path = `/accounts/${encodeURIComponent(app)}/operations?order=desc&limit=200`;
      for (let page = 0; page < 3 && path; page++) {
        const operations = await json(path);
        for (const op of operations._embedded?.records || []) {
          if (op.type !== 'payment' || op.from !== sender || op.to !== app ||
              op.asset_type !== 'native' || Number(op.amount) !== Number(amount)) continue;
          const tx = await json(`/transactions/${encodeURIComponent(op.transaction_hash)}`);
          if (tx.successful === true) payments.push({ txid: tx.hash, memo: tx.memo });
        }
        const next = operations._links?.next?.href;
        const url = next ? new URL(next) : null;
        path = url ? url.pathname + url.search : null;
      }
      return payments;
    },
    async currentProtocolVersion() {
      const data = await json('/');
      if (!Number.isSafeInteger(data.current_protocol_version) || data.current_protocol_version < 0) {
        throw new HttpError(502, 'invalid_horizon_response');
      }
      return data.current_protocol_version;
    },
    async latestLedger() {
      const data = await json('/ledgers?order=desc&limit=1');
      const record = data._embedded?.records?.[0];
      if (!Number.isSafeInteger(record?.sequence) || !Number.isSafeInteger(record?.protocol_version)) {
        throw new HttpError(502, 'invalid_horizon_response');
      }
      const closedAt = typeof record.closed_at === 'string' && Number.isFinite(Date.parse(record.closed_at)) ? record.closed_at : null;
      return { sequence: record.sequence, protocolVersion: record.protocol_version, closedAt };
    },
    async prepare(payment) {
      const seed = typeof env.PI_WALLET_SEED === 'string' ? env.PI_WALLET_SEED.trim() : env.PI_WALLET_SEED;
      const logKeypair = (seedValid, seedMatchesWallet) => console.log(JSON.stringify({
        event: 'payout_stage', stage: 'keypair', seedValid, seedMatchesWallet,
        seedLength: seed ? seed.length : 0,
        seedFirstChar: seed ? seed[0] : '',
        seedBase32Only: /^[A-Z2-7]*$/.test(seed || ''),
      }));
      if (!seed) {
        logKeypair(false, false);
        throw new HttpError(503, 'server_not_configured');
      }
      try {
        let S, signer;
        try {
          S = require('@stellar/stellar-sdk');
          signer = S.Keypair.fromSecret(seed);
        } catch (error) {
          logKeypair(false, false);
          throw error;
        }
        logKeypair(true, signer.publicKey() === payment.from_address);
        if (payment.from_address !== signer.publicKey()) throw new HttpError(409, 'app_wallet_mismatch');
        const [account, fees] = await Promise.all([
          json(`/accounts/${encodeURIComponent(signer.publicKey())}`), json('/fee_stats'),
        ]);
        const tx = new S.TransactionBuilder(new S.Account(signer.publicKey(), account.sequence), {
          fee: String(fees.last_ledger_base_fee), networkPassphrase: NETWORK,
        }).addOperation(S.Operation.payment({
          destination: payment.to_address, asset: S.Asset.native(), amount: '0.5',
        })).addMemo(S.Memo.text(payment.identifier)).setTimeout(180).build();
        tx.sign(signer);
        return { xdr: tx.toXDR(), txid: tx.hash().toString('hex') };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'transaction_build_failed');
      }
    },
    async lookup(txid) {
      const response = await request(`/transactions/${encodeURIComponent(txid)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new HttpError(502, 'horizon_request_failed');
      const tx = await response.json();
      if (tx.hash !== txid || tx.successful !== true) throw new HttpError(409, 'transaction_failed');
      return tx;
    },
    async submit({ xdr, txid }) {
      const response = await request('/transactions', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: xdr }).toString(),
      });
      // A timeout / rejection is ambiguous. Keep the exact envelope and hash;
      // next retry queries Horizon and can only resubmit this same transaction.
      if (!response.ok) throw new HttpError(502, 'transaction_submission_uncertain');
      const tx = await response.json();
      if (tx.hash !== txid || tx.successful !== true) throw new HttpError(502, 'transaction_submission_uncertain');
      return txid;
    },
  };
}

module.exports = { createLedger, HORIZON, NETWORK };
