'use strict';

const { HttpError, requireString } = require('./errors');
const PI_API_BASE = 'https://api.minepi.com/v2';

function createPiClient({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
  async function request(path, { token, method = 'GET', body } = {}) {
    const key = token || env.PI_NETWORK_API_KEY;
    if (!key) throw new HttpError(503, 'server_not_configured');
    let response;
    try {
      response = await fetchImpl(`${PI_API_BASE}${path}`, {
        method,
        headers: { Authorization: `${token ? 'Bearer' : 'Key'} ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new HttpError(502, 'pi_unavailable'); }
    // Never propagate upstream text: it can contain credentials or request data.
    if (!response.ok) {
      const error = new HttpError(token && response.status === 401 ? 401 : 502,
        token && response.status === 401 ? 'invalid_access_token' : 'pi_request_failed');
      error.upstreamStatus = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new HttpError(502, 'invalid_pi_response'); }
  }
  const paymentPath = id => `/payments/${encodeURIComponent(requireString(id, 'paymentId'))}`;
  return {
    getMe: token => request('/me', { token: requireString(token, 'accessToken') }),
    getPayment: id => request(paymentPath(id)),
    approvePayment: id => request(`${paymentPath(id)}/approve`, { method: 'POST' }),
    completePayment: (id, txid) => request(`${paymentPath(id)}/complete`, {
      method: 'POST', body: { txid: requireString(txid, 'txid') },
    }),
    createA2UPayment: payment => request('/payments', { method: 'POST', body: { payment } }),
    getIncompleteServerPayments: async () => {
      const result = await request('/payments/incomplete_server_payments');
      if (!Array.isArray(result.incomplete_server_payments)) throw new HttpError(502, 'invalid_pi_response');
      return result.incomplete_server_payments;
    },
  };
}

module.exports = { createPiClient, PI_API_BASE };
