'use strict';

const { HttpError } = require('./errors');
const ORIGINS = new Set(['https://knowaguy4u-cell.github.io', 'https://testjra7998.pinet.com', 'https://node-health-report.vercel.app', 'https://node-health-report-testnet.vercel.app', 'https://nodehealthreport3739.pinet.com']);

function handler(action) {
  return async (req, res) => {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers?.origin;
    if (origin && !ORIGINS.has(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw new HttpError(415, 'json_required');
      let body = req.body;
      if (Buffer.isBuffer(body)) body = body.toString('utf8');
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { throw new HttpError(400, 'invalid_json'); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json');
      const authorization = req.headers?.authorization;
      let token = body.accessToken;
      if (authorization !== undefined) {
        const match = /^Bearer (\S+)$/i.exec(authorization);
        if (!match) throw new HttpError(401, 'invalid_authorization');
        token = match[1];
      }
      return res.status(200).json(await action({ ...body, accessToken: token }));
    } catch (error) {
      return res.status(error instanceof HttpError ? error.status : 500)
        .json({ error: error instanceof HttpError ? error.code : 'internal_error' });
    }
  };
}

module.exports = { handler, ORIGINS };
