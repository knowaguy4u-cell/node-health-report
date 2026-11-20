'use strict';

const { HttpError } = require('./errors');
// Confirmed against pi-apps/pi-nodejs .env.production and src/index.ts.
const HORIZON = 'https://api.testnet.minepi.com';
const NETWORK = 'Pi Testnet';

function createLedger({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
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
    async prepare(payment) {
      if (!env.PI_WALLET_SEED) throw new HttpError(503, 'server_not_configured');
      try {
        const S = require('@stellar/stellar-sdk');
        const signer = S.Keypair.fromSecret(env.PI_WALLET_SEED);
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
