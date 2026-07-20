const supabase = require('../config/supabase');
const paystack = require('../services/paystack.service');
const ledgerService = require('../services/ledger.service');
const webhookService = require('../services/webhook.service');

/**
 * POST /api/mpesa/stk-push
 * Merchant-initiated deposit request, routed through Paystack's Charge API.
 */
async function initiateStkPush(req, res) {
  const { phone, amount, accountReference, description, email } = req.body;

  if (!phone || !amount || amount <= 0) {
    return res.status(400).json({ error: 'phone and a positive amount are required' });
  }

  try {
    const wallet = await ledgerService.getOrCreateWallet(req.merchantId, 'KES');

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        merchant_id: req.merchantId,
        wallet_id: wallet.id,
        type: 'deposit',
        method: 'mpesa_stk',
        amount,
        currency: 'KES',
        status: 'pending',
        reference: accountReference || null,
        customer_phone: phone,
        description: description || 'FXS Pay deposit',
      })
      .select()
      .single();

    if (error) throw error;

    // Our own transaction id IS the Paystack reference — one field to match on,
    // no separate invoice id to reconcile like with IntaSend.
    const result = await paystack.initiateMpesaCharge({
      phone,
      amount,
      reference: transaction.id,
      narration: description,
      email,
    });

    await supabase
      .from('transactions')
      .update({ provider_reference: result.data.reference })
      .eq('id', transaction.id);

    return res.status(202).json({
      message: 'STK push sent via Paystack. Await customer confirmation.',
      transactionId: transaction.id,
      paystackStatus: result.data.status,
    });
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    return res.status(502).json({ error: `Paystack request failed: ${message}` });
  }
}

/**
 * POST /api/mpesa/webhook
 * Public — Paystack calls this directly. Configure this URL in your
 * Paystack dashboard under Settings -> API Keys & Webhooks.
 * NOTE: this route must receive the RAW body (express.raw in payment.routes.js),
 * not JSON-parsed, because the signature is computed over the raw bytes.
 */
async function handleWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];

  if (!signature || !req.rawBody || !paystack.verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = paystack.parseWebhookEvent(req.body);

  const { data: transaction } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', event.reference)
    .maybeSingle();

  if (!transaction) {
    console.error('Paystack webhook for unrecognized transaction:', event);
    return res.status(200).json({ received: true });
  }

  // Idempotency — Paystack can resend the same webhook.
  if (transaction.status === 'success' || transaction.status === 'failed') {
    return res.status(200).json({ received: true });
  }

  if (event.event === 'charge.success' && event.status === 'success') {
    await supabase
      .from('transactions')
      .update({
        status: 'success',
        provider_reference: event.reference,
        metadata: { channel: event.channel, gatewayResponse: event.gatewayResponse },
      })
      .eq('id', transaction.id);

    await ledgerService.creditWallet(transaction.wallet_id, transaction.id, transaction.amount);

    await webhookService.dispatchEvent(transaction.merchant_id, 'payment.success', {
      transactionId: transaction.id,
      amount: transaction.amount,
      currency: transaction.currency,
      paystackReference: event.reference,
      receiptUrl: `${process.env.BASE_URL}/api/mpesa/receipt/${transaction.id}`,
    });
  } else if (event.event === 'charge.failed' || event.status === 'failed') {
    await supabase
      .from('transactions')
      .update({ status: 'failed', metadata: { gatewayResponse: event.gatewayResponse } })
      .eq('id', transaction.id);

    await webhookService.dispatchEvent(transaction.merchant_id, 'payment.failed', {
      transactionId: transaction.id,
      reason: event.gatewayResponse,
    });
  }
  // Other events (e.g. still pending) just acknowledge without changing state.

  return res.status(200).json({ received: true });
}

/**
 * GET /api/mpesa/status/:transactionId
 * Checks our own DB first; if still pending, polls Paystack directly as a
 * fallback in case the webhook hasn't arrived yet.
 */
async function getStatus(req, res) {
  const { data: transaction, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .eq('merchant_id', req.merchantId)
    .maybeSingle();

  if (error || !transaction) return res.status(404).json({ error: 'Transaction not found' });

  if (transaction.status === 'pending' && transaction.provider_reference) {
    try {
      const live = await paystack.verifyTransaction(transaction.provider_reference);
      if (live.data.status === 'success' && transaction.status !== 'success') {
        await ledgerService.creditWallet(transaction.wallet_id, transaction.id, transaction.amount);
        await supabase.from('transactions').update({ status: 'success' }).eq('id', transaction.id);
        transaction.status = 'success';
      } else if (live.data.status === 'failed' || live.data.status === 'abandoned') {
        await supabase.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);
        transaction.status = 'failed';
      }
    } catch (err) {
      console.error('Paystack status poll failed:', err.message);
    }
  }

  return res.json({ transaction });
}

/**
 * GET /api/mpesa/transactions
 */
async function listTransactions(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('id, type, method, amount, currency, status, reference, customer_phone, description, created_at')
    .eq('merchant_id', req.merchantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ transactions });
}

/**
 * GET /api/mpesa/receipt/:transactionId
 * Public, human-facing receipt link.
 */
async function getReceipt(req, res) {
  const { data: transaction } = await supabase
    .from('transactions')
    .select('id, amount, currency, status, method, provider_reference, created_at, merchants(business_name)')
    .eq('id', req.params.transactionId)
    .maybeSingle();

  if (!transaction) {
    return res.status(404).send('<h1>Receipt not found</h1>');
  }

  res.set('Content-Type', 'text/html');
  return res.send(`
    <html>
      <head><title>FXS Pay Receipt</title></head>
      <body style="font-family: sans-serif; max-width: 400px; margin: 40px auto; text-align: center;">
        <h2>${transaction.status === 'success' ? '✅ Payment Received' : 'Payment ' + transaction.status}</h2>
        <p style="font-size: 24px;">${transaction.currency} ${transaction.amount}</p>
        <p>Paid to: ${transaction.merchants?.business_name || 'Merchant'}</p>
        <p>Reference: ${transaction.provider_reference || '—'}</p>
        <p style="color: #666; font-size: 12px;">${new Date(transaction.created_at).toLocaleString()}</p>
      </body>
    </html>
  `);
}

module.exports = { initiateStkPush, handleWebhook, getStatus, getReceipt, listTransactions };
