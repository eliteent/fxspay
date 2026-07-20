const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Generates a new API key. Only the prefix + hash are stored server-side;
 * the full secret is shown to the merchant exactly once at creation time.
 */
function generateApiKey(env = 'test') {
  const prefix = env === 'live' ? 'fxs_live_' : 'fxs_test_';
  const secret = crypto.randomBytes(24).toString('hex');
  const fullKey = `${prefix}${secret}`;
  return { fullKey, prefix };
}

async function hashApiKey(fullKey) {
  return bcrypt.hash(fullKey, 10);
}

async function verifyApiKey(fullKey, storedHash) {
  return bcrypt.compare(fullKey, storedHash);
}

module.exports = { generateApiKey, hashApiKey, verifyApiKey };
