-- FXS Pay core schema
-- Run this in the Supabase SQL editor (or via `supabase db push`).
--
-- MIGRATION NOTE: if you already ran an earlier version of this schema
-- (before merchants.account_code existed), run this first instead of the
-- whole file:
--   alter table merchants add column if not exists account_code text unique;
--   -- then backfill existing rows with a generated code before adding NOT NULL,
--   -- e.g. update merchants set account_code = 'FXS' || substr(id::text, 1, 6) where account_code is null;
--   -- alter table merchants alter column account_code set not null;

create extension if not exists "uuid-ossp";

-- =========================================================
-- MERCHANTS
-- =========================================================
create table if not exists merchants (
  id uuid primary key default uuid_generate_v4(),
  business_name text not null,
  contact_email text not null unique,
  contact_phone text,
  password_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  kyc_status text not null default 'pending' check (kyc_status in ('pending', 'under_review', 'approved', 'rejected')),
  preferred_currency text not null default 'KES',
  -- Customers paying via the shared FXS Pay Paybill type this code as the
  -- M-Pesa "Account Number" so incoming C2B payments route to this merchant.
  account_code text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_merchants_account_code on merchants(account_code);

create table if not exists merchant_api_keys (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  key_prefix text not null,        -- e.g. fxs_live_ / fxs_test_
  key_hash text not null,          -- bcrypt hash of the full secret key, never store plaintext
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists merchant_kyc_documents (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  document_type text not null, -- national_id, business_registration, kra_pin, tax_certificate, bank_statement, etc.
  storage_path text not null,  -- path in Supabase Storage
  status text not null default 'pending' check (status in ('pending', 'under_review', 'approved', 'rejected')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================
-- WALLETS + DOUBLE-ENTRY LEDGER
-- =========================================================
create table if not exists wallets (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  currency text not null,          -- KES, USD, EUR, GBP, NGN, TZS, UGX...
  balance numeric(18,2) not null default 0,   -- cached balance, always derived from ledger_entries
  status text not null default 'active' check (status in ('active', 'frozen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, currency)
);

-- Every money movement writes at least two balanced ledger_entries (sum = 0 per transaction).
-- This is the source of truth; wallets.balance is a cache kept in sync via the function below.
create table if not exists ledger_entries (
  id uuid primary key default uuid_generate_v4(),
  wallet_id uuid not null references wallets(id),
  transaction_id uuid not null,        -- references transactions(id), see below
  direction text not null check (direction in ('debit', 'credit')),
  amount numeric(18,2) not null check (amount > 0),
  balance_after numeric(18,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_wallet on ledger_entries(wallet_id);
create index if not exists idx_ledger_transaction on ledger_entries(transaction_id);

-- =========================================================
-- TRANSACTIONS (unified table for STK push, cards, withdrawals, transfers)
-- =========================================================
create table if not exists transactions (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id),
  wallet_id uuid references wallets(id),
  type text not null check (type in ('deposit', 'withdrawal', 'transfer', 'refund')),
  method text not null check (method in ('mpesa_stk', 'mpesa_paybill', 'mpesa_till', 'card', 'bank', 'wallet')),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null default 'KES',
  fee numeric(18,2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'processing', 'success', 'failed', 'cancelled', 'reversed')),
  reference text,                       -- merchant-supplied account reference
  provider_reference text,              -- e.g. Daraja CheckoutRequestID
  customer_phone text,
  description text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_merchant on transactions(merchant_id);
create index if not exists idx_transactions_provider_ref on transactions(provider_reference);

-- =========================================================
-- WEBHOOKS
-- =========================================================
create table if not exists webhook_endpoints (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  url text not null,
  secret text not null,     -- used to HMAC-sign payloads
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id uuid primary key default uuid_generate_v4(),
  webhook_endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  attempt_count int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  response_status int,
  created_at timestamptz not null default now()
);

-- =========================================================
-- FUNCTION: apply a balanced ledger movement and update wallet.balance atomically
-- =========================================================
create or replace function apply_ledger_entry(
  p_wallet_id uuid,
  p_transaction_id uuid,
  p_direction text,
  p_amount numeric
) returns numeric as $$
declare
  v_new_balance numeric(18,2);
begin
  if p_direction = 'credit' then
    update wallets set balance = balance + p_amount, updated_at = now()
      where id = p_wallet_id
      returning balance into v_new_balance;
  elsif p_direction = 'debit' then
    update wallets set balance = balance - p_amount, updated_at = now()
      where id = p_wallet_id and balance >= p_amount
      returning balance into v_new_balance;

    if v_new_balance is null then
      raise exception 'Insufficient wallet balance for debit of % on wallet %', p_amount, p_wallet_id;
    end if;
  else
    raise exception 'Invalid ledger direction: %', p_direction;
  end if;

  insert into ledger_entries (wallet_id, transaction_id, direction, amount, balance_after)
    values (p_wallet_id, p_transaction_id, p_direction, p_amount, v_new_balance);

  return v_new_balance;
end;
$$ language plpgsql;
