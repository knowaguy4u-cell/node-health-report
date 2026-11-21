'use strict';

const { HttpError, requireString } = require('./errors');
const PRICE = 1;
const PAYOUT = 0.5;
const PRODUCT = 'full_health_check';
const PAYOUT_PRODUCT = 'test_payout';

function createPayments({ pi, store, ledger }) {
  async function identify(token) {
    if (!token) throw new HttpError(401, 'missing_access_token');
    const user = await pi.getMe(token);
    if (!user || typeof user.uid !== 'string' || !user.uid) throw new HttpError(401, 'invalid_access_token');
    return user;
  }
  function validate(payment, id, user, direction, amount, product) {
    if (!payment || payment.identifier !== id) throw new HttpError(502, 'invalid_pi_response');
    if (payment.direction !== direction) throw new HttpError(400, 'wrong_direction');
    if (payment.network !== 'Pi Testnet') throw new HttpError(400, 'wrong_network');
    if (payment.amount !== amount) throw new HttpError(400, 'wrong_amount');
    if (payment.metadata?.product !== product) throw new HttpError(400, 'wrong_product');
    if (payment.user_uid !== user.uid) throw new HttpError(403, 'payment_owner_mismatch');
    if (payment.status?.cancelled || payment.status?.user_cancelled) throw new HttpError(409, 'payment_cancelled');
  }
  async function recipientFromCompletedPurchase(user) {
    const paymentId = await store.get(`user-payment:${user.uid}`);
    if (typeof paymentId !== 'string' || !paymentId) return null;
    const purchase = await pi.getPayment(paymentId);
    validate(purchase, paymentId, user, 'user_to_app', PRICE, PRODUCT);
    if (!purchase.status?.developer_completed || !purchase.status?.transaction_verified ||
        !purchase.transaction?.verified) return null;
    return typeof purchase.from_address === 'string' && purchase.from_address
      ? purchase.from_address : null;
  }
  async function recipientFromPurchaseRecord(user, paymentId) {
    if (typeof paymentId !== 'string' || !paymentId) return { recipient: null, stage: 'no_id' };
    let purchase;
    try { purchase = await pi.getPayment(paymentId); }
    catch { return { recipient: null, stage: 'fetch_failed' }; }
    try { validate(purchase, paymentId, user, 'user_to_app', PRICE, PRODUCT); }
    catch (error) { return { recipient: null, stage: error instanceof HttpError ? error.code : 'invalid_pi_response' }; }
    if (!purchase.status?.developer_completed || !purchase.status?.transaction_verified ||
        !purchase.transaction?.verified) return { recipient: null, stage: 'not_completed' };
    if (typeof purchase.from_address !== 'string' || !purchase.from_address) {
      return { recipient: null, stage: 'no_from_address' };
    }
    return { recipient: purchase.from_address, stage: null };
  }
  async function fetchU2A(id, user) {
    const payment = await pi.getPayment(id);
    validate(payment, id, user, 'user_to_app', PRICE, PRODUCT);
    return payment;
  }
  async function savePayment(id, changes) {
    const key = `payment:${id}`;
    const previous = await store.get(key) || {};
    const state = { ...previous, ...changes };
    await store.set(key, state);
    return state;
  }
  async function fulfill(payment) {
    if (!payment.status?.developer_completed || !payment.status?.transaction_verified ||
        !payment.transaction?.verified || !payment.transaction?.txid) {
      throw new HttpError(502, 'payment_not_verified');
    }
    const state = await store.get(`payment:${payment.identifier}`);
    if (!state?.fulfilled) {
      // This entitlement is the fulfillment; no checks read node data yet.
      // Keep entitlement and payment completion in one durable transaction when
      // replacing MemoryStore. Never dispatch a non-idempotent external side effect here.
      await savePayment(payment.identifier, {
        uid: payment.user_uid, status: 'completed', txid: payment.transaction.txid,
        fulfilled: true, fulfillmentCount: 1,
      });
      await store.set(`user-payment:${payment.user_uid}`, payment.identifier);
    }
    return { ok: true, status: 'completed', healthCheck: 'fulfilled' };
  }
  async function approveU2A(id, user) {
    let payment = await fetchU2A(id, user);
    if (payment.status?.developer_completed) return fulfill(payment);
    if (!payment.status?.developer_approved) {
      await savePayment(id, { uid: user.uid, status: 'approving' });
      payment = await pi.approvePayment(id);
      validate(payment, id, user, 'user_to_app', PRICE, PRODUCT);
      if (!payment.status?.developer_approved) throw new HttpError(502, 'payment_not_approved');
    }
    await savePayment(id, { uid: user.uid, status: 'approved' });
    return { ok: true, status: 'approved' };
  }
  async function completeU2A(id, txid, user) {
    let payment = await fetchU2A(id, user);
    if (payment.transaction?.txid && payment.transaction.txid !== txid) throw new HttpError(409, 'txid_mismatch');
    if (payment.status?.developer_completed) return fulfill(payment);
    if (!payment.status?.developer_approved) throw new HttpError(409, 'payment_not_approved');
    await savePayment(id, { uid: user.uid, status: 'completing', txid });
    payment = await pi.completePayment(id, txid);
    validate(payment, id, user, 'user_to_app', PRICE, PRODUCT);
    if (payment.transaction?.txid !== txid) throw new HttpError(502, 'txid_mismatch');
    return fulfill(payment);
  }
  return {
    async approve({ paymentId, accessToken }) {
      const id = requireString(paymentId, 'paymentId');
      const user = await identify(accessToken);
      return store.withLock(`payment:${id}`, () => approveU2A(id, user));
    },
    async complete({ paymentId, txid, accessToken }) {
      const id = requireString(paymentId, 'paymentId');
      requireString(txid, 'txid');
      const user = await identify(accessToken);
      return store.withLock(`payment:${id}`, () => completeU2A(id, txid, user));
    },
    async resume({ payment, accessToken }) {
      const id = requireString(payment?.identifier, 'paymentId');
      const user = await identify(accessToken);
      return store.withLock(`payment:${id}`, async () => {
        // The SDK object supplies only the identifier; flags, amount and txid
        // are always reloaded from Pi, never trusted from the browser.
        const current = await fetchU2A(id, user);
        if (current.status?.developer_completed) return fulfill(current);
        await approveU2A(id, user);
        const latest = await fetchU2A(id, user);
        if (latest.transaction?.txid) return completeU2A(id, latest.transaction.txid, user);
        return { ok: true, status: 'awaiting_user_transaction' };
      });
    },
    async payout({ accessToken, purchasePaymentId }) {
      const user = await identify(accessToken);
      let recipient = null;
      let source = 'none';
      let purchaseStage = null;
      if (user.credentials?.scopes?.includes('wallet_address') &&
          typeof user.wallet_address === 'string' && user.wallet_address) {
        recipient = user.wallet_address;
        source = 'me';
      } else {
        if (typeof purchasePaymentId === 'string' && purchasePaymentId) {
          const purchase = await recipientFromPurchaseRecord(user, purchasePaymentId);
          recipient = purchase.recipient;
          purchaseStage = purchase.stage;
          if (recipient) source = 'purchase';
        }
        if (!recipient) {
          recipient = await recipientFromCompletedPurchase(user);
          if (recipient) source = 'index';
        }
      }
      console.log(JSON.stringify({ event: 'payout_recipient', source, purchaseStage }));
      if (!recipient) throw new HttpError(403, 'missing_scope');
      // Serialize the shared app wallet too: concurrent transactions for
      // different uids would otherwise consume the same account sequence.
      return store.withLock('payout:wallet', () => store.withLock(`payout:${user.uid}`, async () => {
        const key = `payout:${user.uid}`;
        let state = await store.get(key);
        const save = async changes => {
          state = { ...state, ...changes };
          await store.set(key, state);
        };
        const stage = async (name, fn) => {
          try {
            const value = await fn();
            console.log(JSON.stringify({ event: 'payout_stage', stage: name, ok: true }));
            return value;
          } catch (error) {
            console.log(JSON.stringify({ event: 'payout_stage', stage: name, ok: false,
              code: error instanceof HttpError ? error.code : 'internal_error' }));
            throw error;
          }
        };
        const result = () => ({ ok: true, status: 'completed', paymentId: state.paymentId });
        if (state?.status === 'completed') return result();
        // The volatile store is not the record; the chain is. Adopt a prior
        // completed payout for this user, never repay it.
        const candidates = await ledger.findPaymentsTo(recipient, '0.5');
        for (const candidate of candidates) {
          if (typeof candidate.memo !== 'string' || !candidate.memo) continue;
          let payment;
          try {
            payment = await pi.getPayment(candidate.memo);
            validate(payment, candidate.memo, user, 'app_to_user', PAYOUT, PAYOUT_PRODUCT);
          } catch { continue; }
          if (payment.transaction?.txid !== candidate.txid || !payment.status?.developer_completed ||
              !payment.status?.transaction_verified || !payment.transaction?.verified) continue;
          await save({ status: 'completed', paymentId: candidate.memo, txid: candidate.txid,
            recoveredFromChain: true });
          return result();
        }
        try {
          if (!state?.paymentId) {
            await stage('create', async () => {
              const ongoing = await pi.getIncompleteServerPayments();
              const matching = ongoing.find(p => p.user_uid === user.uid && p.metadata?.product === PAYOUT_PRODUCT);
              if (matching) {
                validate(matching, matching.identifier, user, 'app_to_user', PAYOUT, PAYOUT_PRODUCT);
                await save({ status: 'created', paymentId: matching.identifier });
              } else {
                if (ongoing.length) throw new HttpError(409, 'payout_in_flight');
                // A previous create request could have succeeded before the
                // response was saved. Never blindly create again in that window.
                if (state) throw new HttpError(409, 'payout_reconciliation_required');
                await save({ status: 'creating' });
                const created = await pi.createA2UPayment({
                  uid: user.uid, amount: PAYOUT, memo: 'Node Health Report — test payout',
                  metadata: { product: PAYOUT_PRODUCT },
                });
                requireString(created?.identifier, 'paymentId');
                await save({ status: 'created', paymentId: created.identifier });
              }
            });
          }
          const payment = await stage('fetch', async () => {
            const payment = await pi.getPayment(state.paymentId);
            validate(payment, state.paymentId, user, 'app_to_user', PAYOUT, PAYOUT_PRODUCT);
            // Pi's current payment destination is authoritative (wallets may
            // change). No browser-supplied address ever enters the transaction.
            if (!payment.to_address || !payment.from_address) throw new HttpError(502, 'invalid_pi_response');
            if (payment.to_address !== recipient) throw new HttpError(403, 'payout_recipient_mismatch');
            return payment;
          });
          if (payment.status?.developer_completed) {
            return await stage('complete', async () => {
              if (!payment.status.transaction_verified || !payment.transaction?.verified) throw new HttpError(502, 'payment_not_verified');
              await save({ status: 'completed', txid: payment.transaction.txid, xdr: null });
              return result();
            });
          }
          if (payment.transaction?.txid) {
            if (state.txid && payment.transaction.txid !== state.txid) throw new HttpError(409, 'txid_mismatch');
            await save({ status: 'submitted', txid: payment.transaction.txid });
          } else {
            if (!state.txid) {
              const prepared = await stage('prepare', () => ledger.prepare(payment));
              // Write-ahead: save hash AND signed envelope BEFORE any submission.
              await save({ status: 'prepared', ...prepared });
            }
            await stage('submit', async () => {
              const existing = await ledger.lookup(state.txid);
              if (!existing) {
                if (!state.xdr) throw new HttpError(409, 'payout_reconciliation_required');
                await ledger.submit(state);
              }
              await save({ status: 'submitted' });
            });
          }
          return await stage('complete', async () => {
            const completed = await pi.completePayment(state.paymentId, state.txid);
            validate(completed, state.paymentId, user, 'app_to_user', PAYOUT, PAYOUT_PRODUCT);
            if (!completed.status?.developer_completed || !completed.status?.transaction_verified ||
                !completed.transaction?.verified || completed.transaction.txid !== state.txid) {
              throw new HttpError(502, 'payment_not_verified');
            }
            await save({ status: 'completed', xdr: null });
            return result();
          });
        } catch (error) {
          if (state && state.status !== 'completed') {
            // Preserve paymentId, hash and envelope even when the result of an
            // upstream call is unknown; a retry must reconcile, never repay.
            await save({ status: 'failed', error: error instanceof HttpError ? error.code : 'internal_error' });
          }
          throw error;
        }
      }));
    },
  };
}

module.exports = { createPayments, PRICE, PAYOUT };
