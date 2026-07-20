const { verifyToken } = require('../utils/jwt');
const { verifyApiKey } = require('../utils/apikey');
const supabase = require('../config/supabase');

/**
 * requireJwt — for the merchant dashboard (login session).
 */
function requireJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = verifyToken(token);
    req.merchantId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireApiKey — for developer/API integrations (server-to-server calls).
 * Expects header: Authorization: Bearer fxs_live_xxx or fxs_test_xxx
 */
async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const fullKey = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!fullKey || !(fullKey.startsWith('fxs_live_') || fullKey.startsWith('fxs_test_'))) {
    return res.status(401).json({ error: 'Missing or malformed API key' });
  }

  const prefix = fullKey.startsWith('fxs_live_') ? 'fxs_live_' : 'fxs_test_';

  const { data: candidates, error } = await supabase
    .from('merchant_api_keys')
    .select('id, merchant_id, key_hash, is_active')
    .eq('key_prefix', prefix)
    .eq('is_active', true);

  if (error) {
    return res.status(500).json({ error: 'Auth lookup failed' });
  }

  for (const candidate of candidates || []) {
    const isMatch = await verifyApiKey(fullKey, candidate.key_hash);
    if (isMatch) {
      req.merchantId = candidate.merchant_id;
      supabase
        .from('merchant_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', candidate.id)
        .then(() => {});
      return next();
    }
  }

  return res.status(401).json({ error: 'Invalid API key' });
}

/**
 * requireAdminSecret — minimal protection for admin-only endpoints until a
 * real admin dashboard with its own accounts/roles exists. Expects header:
 * X-Admin-Secret: <value matching ADMIN_SECRET env var>
 */
function requireAdminSecret(req, res, next) {
  const provided = req.headers['x-admin-secret'];

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SECRET is not configured on the server' });
  }
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Invalid admin secret' });
  }
  next();
}

/**
 * requireMerchantAuth — accepts EITHER a JWT (dashboard session) OR an API
 * key. Lets the merchant dashboard use its own login session for wallet/
 * payment actions without needing a separate API key, while external
 * integrations still authenticate with fxs_live_/fxs_test_ keys.
 */
async function requireMerchantAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  if (token.startsWith('fxs_live_') || token.startsWith('fxs_test_')) {
    return requireApiKey(req, res, next);
  }

  try {
    const payload = verifyToken(token);
    req.merchantId = payload.sub;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireJwt, requireApiKey, requireAdminSecret, requireMerchantAuth };
