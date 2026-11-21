'use strict';
const { createPayments } = require('./payments');
const { createPiClient } = require('./pi');
const { createLedger } = require('./stellar');
const { store } = require('./store');
const { networkConfig } = require('./config');
module.exports = createPayments({ pi: createPiClient(), ledger: createLedger(), store, network: networkConfig().name });
