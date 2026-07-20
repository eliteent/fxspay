const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co'; // Paystack uses one base URL; test/live is determined by which secret key you use

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Triggers an M-Pesa STK push via Paystack's Charge API.
 * Paystack requires an email on every charge even for mobile money — if the
 * merchant/customer doesn't have one on file, a placeholder tied to the
 * merchant's account_code keeps charges distinguishable in Paystack's own
 * dashboard without needing a real customer email.
 */
async function initiateMpesaCharge({ phone, amount, reference, email, narration }) {
  const payload = {
    email: email || `customer+${reference}@fxspay.invalid`,
    amount: Math.round(amount * 100), // Paystack expects the amount in the smallest currency subunit (cents for KES)
    currency: 'KES',
    reference, // our own transaction id — Paystack echoes this back and includes it in webhooks
    mobile_money: {
      phone,
      provider: 'mpesa',
    },
    metadata: { narration: narration || 'FXS Pay payment' },
  };

  const { data } = await axios.post(`${BASE_URL}/charge`, payload, { headers: authHeaders() });
  return data; // { status: true, data: { reference, status: 'pay_offline'|'success'|..., ... } }
}

/**
 * Polls Paystack for the current state of a transaction. Useful as a
 * fallback if a webhook is delayed or missed.
 */
async function verifyTransaction(reference) {
  const { data } = await axios.get(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: authHeaders(),
  });
  return data; // { status: true, data: { status: 'success'|'failed'|'abandoned', ... } }
}

/**
 * Paystack signs every webhook with HMAC-SHA512 of the RAW request body,
 * using your secret key. This must be computed over the exact raw bytes
 * Paystack sent — NOT a re-serialized JSON.stringify of a parsed object,
 * since key ordering/whitespace differences would break the signature.
 * The route calling this must use express.raw(), not express.json().
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return expected === signatureHeader;
}

/**
 * Normalizes a Paystack webhook event into a shape the rest of the app can use.
 * Paystack's main events here: charge.success (and charge.failed doesn't
 * always fire — a stalled/abandoned charge may need a status poll instead).
 */
function parseWebhookEvent(body) {
  const data = body.data || {};
  return {
    event: body.event, // e.g. 'charge.success'
    reference: data.reference,
    amount: (data.amount || 0) / 100, // convert back from subunit to whole currency
    currency: data.currency,
    status: data.status, // 'success', 'failed', 'abandoned'
    channel: data.channel, // 'mobile_money', 'card', etc.
    gatewayResponse: data.gateway_response,
  };
}

module.exports = { initiateMpesaCharge, verifyTransaction, verifyWebhookSignature, parseWebhookEvent };
