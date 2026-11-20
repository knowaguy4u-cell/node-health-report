'use strict';

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return value;
}

module.exports = { HttpError, requireString };
