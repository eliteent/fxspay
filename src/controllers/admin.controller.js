const supabase = require('../config/supabase');

/**
 * POST /api/admin/merchants/:merchantId/approve
 * Minimal admin action until a real admin dashboard exists. Protected by
 * ADMIN_SECRET (a shared secret, not per-user auth) — fine for a solo/small
 * team operating FXS Pay, not meant to scale to multiple admin staff as-is.
 */
async function approveMerchant(req, res) {
  const { data: merchant, error } = await supabase
    .from('merchants')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', req.params.merchantId)
    .select('id, business_name, contact_email, status, account_code')
    .single();

  if (error || !merchant) {
    return res.status(404).json({ error: 'Merchant not found' });
  }

  return res.json({ message: 'Merchant approved', merchant });
}

/**
 * POST /api/admin/merchants/:merchantId/suspend
 */
async function suspendMerchant(req, res) {
  const { data: merchant, error } = await supabase
    .from('merchants')
    .update({ status: 'suspended', updated_at: new Date().toISOString() })
    .eq('id', req.params.merchantId)
    .select('id, business_name, contact_email, status')
    .single();

  if (error || !merchant) {
    return res.status(404).json({ error: 'Merchant not found' });
  }

  return res.json({ message: 'Merchant suspended', merchant });
}

/**
 * GET /api/admin/merchants?status=pending
 */
async function listMerchants(req, res) {
  let query = supabase
    .from('merchants')
    .select('id, business_name, contact_email, status, kyc_status, account_code, created_at')
    .order('created_at', { ascending: false });

  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }

  const { data: merchants, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ merchants });
}

module.exports = { approveMerchant, suspendMerchant, listMerchants };
