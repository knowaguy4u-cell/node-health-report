'use strict';
const { createPayments } = require('./payments');
const { createPiClient } = require('./pi');
const { createLedger } = require('./stellar');
const { store } = require('./store');
module.exports = createPayments({ pi: createPiClient(), ledger: createLedger(), store });
