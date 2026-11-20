const { handler } = require('./_lib/http');
const service = require('./_lib/service');
module.exports = handler(body => service.payout(body));
