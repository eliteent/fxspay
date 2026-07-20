const crypto = require('crypto');
const supabase = require('../config/supabase');

async function registerEndpoint(req, res) {
  const { url } = req.body;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'A valid https:// url is required' });
  }

  const secret = crypto.randomBytes(20).toString('hex');

  const { data: endpoint, error } = await supabase
    .from('webhook_endpoints')
    .insert({ merchant_id: req.merchantId, url, secret })
    .select('id, url, is_active, created_at, secret')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Secret is shown once here so the merchant can store it and verify signatures.
  return res.status(201).json({ endpoint });
}

async function listEndpoints(req, res) {
  const { data: endpoints, error } = await supabase
    .from('webhook_endpoints')
    .select('id, url, is_active, created_at')
    .eq('merchant_id', req.merchantId);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ endpoints });
}

async function listDeliveries(req, res) {
  const { data: endpoints } = await supabase
    .from('webhook_endpoints')
    .select('id')
    .eq('merchant_id', req.merchantId);

  const endpointIds = (endpoints || []).map((e) => e.id);
  if (endpointIds.length === 0) return res.json({ deliveries: [] });

  const { data: deliveries, error } = await supabase
    .from('webhook_deliveries')
    .select('*')
    .in('webhook_endpoint_id', endpointIds)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ deliveries });
}

module.exports = { registerEndpoint, listEndpoints, listDeliveries };
