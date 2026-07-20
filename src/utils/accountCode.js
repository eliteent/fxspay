const crypto = require('crypto');

// Excludes visually confusing characters (0/O, 1/I/L) since customers type this
// manually into their M-Pesa Paybill "Account Number" field.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateAccountCode(prefix = 'FXS') {
  let suffix = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${prefix}${suffix}`; // e.g. FXS7K9QRT
}

module.exports = { generateAccountCode };
