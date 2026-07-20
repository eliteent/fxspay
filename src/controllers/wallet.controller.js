const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const ledger = require('../services/ledger.service');

async function listWallets(req, res) {
  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('merchant_id', req.merchantId);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ wallets });
}

async function getBalance(req, res) {
  const { currency } = req.params;
  const wallet = await ledger.getOrCreateWallet(req.merchantId, currency.toUpperCase());
  return res.json({ wallet });
}

/**
 * Internal transfer between two currency wallets belonging to the SAME merchant.
 * For merchant-to-merchant transfers, extend this to accept a destination merchantId
 * and add an authorization check for that case.
 */
async function transfer(req, res) {
  const { fromCurrency, toCurrency, amount } = req.body;

  if (!fromCurrency || !toCurrency || !amount || amount <= 0) {
    return res.status(400).json({ error: 'fromCurrency, toCurrency, and a positive amount are required' });
  }
  if (fromCurrency === toCurrency) {
    return res.status(400).json({ error: 'fromCurrency and toCurrency must differ' });
  }

  try {
    const fromWallet = await ledger.getOrCreateWallet(req.merchantId, fromCurrency.toUpperCase());
    const toWallet = await ledger.getOrCreateWallet(req.merchantId, toCurrency.toUpperCase());

    const transactionId = uuidv4();

    // NOTE: this treats the transfer as 1:1 for now. Plug in a real FX rate lookup
    // before using this for anything beyond same-value internal moves.
    await supabase.from('transactions').insert({
      id: transactionId,
      merchant_id: req.merchantId,
      wallet_id: fromWallet.id,
      type: 'transfer',
      method: 'wallet',
      amount,
      currency: fromCurrency.toUpperCase(),
      status: 'success',
      description: `Internal transfer ${fromCurrency} -> ${toCurrency}`,
    });

    await ledger.debitWallet(fromWallet.id, transactionId, amount);
    await ledger.creditWallet(toWallet.id, transactionId, amount);

    return res.json({ message: 'Transfer complete', transactionId });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

module.exports = { listWallets, getBalance, transfer };
