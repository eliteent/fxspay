const supabase = require('../config/supabase');

/**
 * Ensures a merchant has a wallet for the given currency, creating one if missing.
 */
async function getOrCreateWallet(merchantId, currency) {
  const { data: existing, error: findErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('currency', currency)
    .maybeSingle();

  if (findErr) throw findErr;
  if (existing) return existing;

  const { data: created, error: createErr } = await supabase
    .from('wallets')
    .insert({ merchant_id: merchantId, currency })
    .select()
    .single();

  if (createErr) throw createErr;
  return created;
}

/**
 * Credits a wallet (e.g. successful deposit) via the atomic Postgres function.
 * Always call this rather than updating wallets.balance directly.
 */
async function creditWallet(walletId, transactionId, amount) {
  const { data, error } = await supabase.rpc('apply_ledger_entry', {
    p_wallet_id: walletId,
    p_transaction_id: transactionId,
    p_direction: 'credit',
    p_amount: amount,
  });
  if (error) throw error;
  return data; // new balance
}

/**
 * Debits a wallet (e.g. withdrawal). Throws if balance is insufficient —
 * the Postgres function enforces this atomically to avoid race conditions.
 */
async function debitWallet(walletId, transactionId, amount) {
  const { data, error } = await supabase.rpc('apply_ledger_entry', {
    p_wallet_id: walletId,
    p_transaction_id: transactionId,
    p_direction: 'debit',
    p_amount: amount,
  });
  if (error) throw error;
  return data;
}

module.exports = { getOrCreateWallet, creditWallet, debitWallet };
