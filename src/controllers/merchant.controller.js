const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { signMerchantToken } = require('../utils/jwt');
const { generateApiKey, hashApiKey } = require('../utils/apikey');
const { generateAccountCode } = require('../utils/accountCode');

/**
 * Generates an account_code and retries on the rare unique-constraint collision.
 */
async function assignAccountCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateAccountCode();
    const { data: existing } = await supabase
      .from('merchants')
      .select('id')
      .eq('account_code', code)
      .maybeSingle();
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique account code, please retry');
}

async function register(req, res) {
  const { businessName, email, phone, password } = req.body;

  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'businessName, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const { data: existing } = await supabase
    .from('merchants')
    .select('id')
    .eq('contact_email', email)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const accountCode = await assignAccountCode();

  const { data: merchant, error } = await supabase
    .from('merchants')
    .insert({
      business_name: businessName,
      contact_email: email,
      contact_phone: phone || null,
      password_hash: passwordHash,
      account_code: accountCode,
    })
    .select('id, business_name, contact_email, status, kyc_status, account_code, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const token = signMerchantToken(merchant);
  return res.status(201).json({ merchant, token });
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { data: merchant, error } = await supabase
    .from('merchants')
    .select('*')
    .eq('contact_email', email)
    .maybeSingle();

  if (error || !merchant) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const isMatch = await bcrypt.compare(password, merchant.password_hash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signMerchantToken(merchant);
  const { password_hash, ...safeMerchant } = merchant;
  return res.json({ merchant: safeMerchant, token });
}

async function getProfile(req, res) {
  const { data: merchant, error } = await supabase
    .from('merchants')
    .select('id, business_name, contact_email, contact_phone, status, kyc_status, preferred_currency, account_code, created_at')
    .eq('id', req.merchantId)
    .maybeSingle();

  if (error || !merchant) return res.status(404).json({ error: 'Merchant not found' });
  return res.json({ merchant });
}

async function updateProfile(req, res) {
  const { businessName, phone, preferredCurrency } = req.body;
  const updates = {};
  if (businessName) updates.business_name = businessName;
  if (phone) updates.contact_phone = phone;
  if (preferredCurrency) updates.preferred_currency = preferredCurrency;
  updates.updated_at = new Date().toISOString();

  const { data: merchant, error } = await supabase
    .from('merchants')
    .update(updates)
    .eq('id', req.merchantId)
    .select('id, business_name, contact_email, contact_phone, status, kyc_status, preferred_currency')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ merchant });
}

/**
 * Issues a new API key for the merchant. The full key is returned ONCE —
 * only its bcrypt hash and prefix are persisted, matching how Stripe/most
 * payment APIs handle key issuance.
 */
async function createApiKey(req, res) {
  const env = req.body.env === 'live' ? 'live' : 'test';

  const { data: merchant } = await supabase
    .from('merchants')
    .select('status')
    .eq('id', req.merchantId)
    .maybeSingle();

  if (env === 'live' && merchant?.status !== 'approved') {
    return res.status(403).json({ error: 'Merchant must be approved before issuing live API keys' });
  }

  const { fullKey, prefix } = generateApiKey(env);
  const keyHash = await hashApiKey(fullKey);

  const { data: record, error } = await supabase
    .from('merchant_api_keys')
    .insert({
      merchant_id: req.merchantId,
      key_prefix: prefix,
      key_hash: keyHash,
      label: req.body.label || null,
    })
    .select('id, key_prefix, label, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json({
    apiKey: fullKey, // shown once, not retrievable again
    record,
  });
}

async function deleteAccount(req, res) {
  const { error } = await supabase.from('merchants').delete().eq('id', req.merchantId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(204).send();
}

/**
 * GET /api/merchant/api-keys — lists metadata only, never the actual secret
 * (which is only ever shown once, at creation time).
 */
async function listApiKeys(req, res) {
  const { data: keys, error } = await supabase
    .from('merchant_api_keys')
    .select('id, key_prefix, label, is_active, created_at, last_used_at')
    .eq('merchant_id', req.merchantId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ keys });
}

module.exports = { register, login, getProfile, updateProfile, createApiKey, listApiKeys, deleteAccount };
