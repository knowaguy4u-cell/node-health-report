'use strict';

const { HttpError } = require('./errors');

function networkConfig(env = process.env) {
  const name = env.PI_NETWORK_NAME || 'Pi Testnet';
  if (name !== 'Pi Testnet' && name !== 'Pi Mainnet') throw new HttpError(503, 'server_not_configured');
  const horizon = env.PI_HORIZON_URL || (name === 'Pi Mainnet'
    ? 'https://api.minepi.com' : 'https://api.testnet.minepi.com');
  return Object.freeze({ name, horizon });
}

module.exports = { networkConfig };
