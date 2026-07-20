const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../config/supabase');

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

/**
 * Queues a webhook delivery for every active endpoint a merchant has registered,
 * then attempts immediate delivery once. Failures are left as 'pending' with a
 * next_retry_at so a background job (see retryFailedWebhooks) can pick them up.
 */
async function dispatchEvent(merchantId, eventType, payload) {
  const { data: endpoints, error } = await supabase
    .from('webhook_endpoints')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('is_active', true);

  if (error) throw error;
  if (!endpoints || endpoints.length === 0) return;

  for (const endpoint of endpoints) {
    const { data: delivery } = await supabase
      .from('webhook_deliveries')
      .insert({
        webhook_endpoint_id: endpoint.id,
        event_type: eventType,
        payload,
      })
      .select()
      .single();

    await attemptDelivery(endpoint, delivery, payload);
  }
}

async function attemptDelivery(endpoint, delivery, payload) {
  const signature = signPayload(payload, endpoint.secret);
  const attemptCount = (delivery.attempt_count || 0) + 1;

  try {
    const response = await axios.post(endpoint.url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-FXSPay-Signature': signature,
        'X-FXSPay-Event': delivery.event_type,
      },
      timeout: 10000,
    });

    await supabase
      .from('webhook_deliveries')
      .update({
        status: 'delivered',
        attempt_count: attemptCount,
        last_attempt_at: new Date().toISOString(),
        response_status: response.status,
      })
      .eq('id', delivery.id);
  } catch (err) {
    const maxRetries = parseInt(process.env.WEBHOOK_MAX_RETRIES || '5', 10);
    const backoffMinutes = Math.min(60, Math.pow(2, attemptCount)); // exponential backoff, capped at 60 min
    const nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

    await supabase
      .from('webhook_deliveries')
      .update({
        status: attemptCount >= maxRetries ? 'failed' : 'pending',
        attempt_count: attemptCount,
        last_attempt_at: new Date().toISOString(),
        next_retry_at: attemptCount >= maxRetries ? null : nextRetryAt,
        response_status: err.response ? err.response.status : null,
      })
      .eq('id', delivery.id);
  }
}

/**
 * Call this from a scheduled job (e.g. every minute via Render cron or node-cron)
 * to retry any deliveries whose next_retry_at has passed.
 */
async function retryFailedWebhooks() {
  const { data: due, error } = await supabase
    .from('webhook_deliveries')
    .select('*, webhook_endpoints(*)')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString());

  if (error) throw error;

  for (const delivery of due || []) {
    await attemptDelivery(delivery.webhook_endpoints, delivery, delivery.payload);
  }
}

module.exports = { dispatchEvent, retryFailedWebhooks, signPayload };
