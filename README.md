# FXS Pay — Backend Core (Merchant + Wallet + M-Pesa via Paystack)

This is the first slice of FXS Pay: merchant accounts, multi-currency wallets
with a double-entry ledger, M-Pesa deposits via **Paystack**, and signed
outbound webhooks to merchants. Card processing (Paystack also supports this
in Kenya), full KYC review, fraud scoring, and a fuller admin dashboard are
still open next steps.

**Why Paystack:** Safaricom still sits underneath every M-Pesa transaction —
that part can't be removed — but Paystack holds the Safaricom/Daraja
relationship on their side, alongside cards, Apple Pay, and Pesalink bank
transfers, all through one API.

## 1. Set up Supabase

1. Create a project at supabase.com.
2. Open the SQL editor and run `supabase/schema.sql` in full.
3. Grab your Project URL (`https://xxxx.supabase.co`) and a secret/service_role
   key (Settings → API Keys) — this bypasses RLS, which is correct here since
   all access control happens in this backend, not in Supabase directly.
4. Recommended: enable RLS on every table with no policies defined (deny-all
   for anon/authenticated, service_role still bypasses it regardless):
   ```sql
   alter table merchants enable row level security;
   alter table merchant_api_keys enable row level security;
   alter table merchant_kyc_documents enable row level security;
   alter table wallets enable row level security;
   alter table ledger_entries enable row level security;
   alter table transactions enable row level security;
   alter table webhook_endpoints enable row level security;
   alter table webhook_deliveries enable row level security;
   ```

## 2. Set up Paystack

1. Create an account at paystack.com, select Kenya as your business country.
2. Get your **Secret Key** and **Public Key** from Settings → API Keys &
   Webhooks. Use test keys first (`sk_test_...` / `pk_test_...`).
3. Under the same page, set your **Webhook URL** to:
   ```
   https://your-render-app.onrender.com/api/mpesa/webhook
   ```
   Unlike IntaSend's shared "challenge" string, Paystack signs every webhook
   with an HMAC-SHA512 signature (header `X-Paystack-Signature`) computed
   from your Secret Key — nothing extra to configure on the dashboard side,
   the same Secret Key you use for API calls is what verifies webhooks too.

## 3. Configure environment

```bash
cp .env.example .env
```

Fill in:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`
- `ADMIN_SECRET` — same method as JWT_SECRET, protects `/api/admin/*`
- `BASE_URL` — your real public Render URL once deployed (needed for
  receipt links and correct webhook URLs)

## 4. Install & run locally

```bash
npm install
npm run dev
```

Health check: `GET http://localhost:4000/health`

Note: Paystack's webhook still needs a public HTTPS URL to call back to, so
local STK push testing needs ngrok (or similar) pointed at your dev server.

## 5. Deploy to Render

- New Web Service → connect this repo (or use `render.yaml` as a Blueprint)
- Build command: `npm install`
- Start command: `npm start`
- Add all `.env` values as Render environment variables
- Once deployed, set the real webhook URL in your Paystack dashboard

## API surface

```
POST   /api/merchant/register
POST   /api/merchant/login
GET    /api/merchant/profile         (JWT)
PUT    /api/merchant/profile         (JWT)
POST   /api/merchant/api-key         (JWT)
GET    /api/merchant/api-keys        (JWT)
DELETE /api/merchant/account         (JWT)

GET    /api/wallet                   (JWT or API key)
GET    /api/wallet/:currency/balance (JWT or API key)
POST   /api/wallet/transfer          (JWT or API key)

POST   /api/mpesa/stk-push           (JWT or API key)  — triggers charge via Paystack
GET    /api/mpesa/status/:id         (JWT or API key)  — checks DB, polls Paystack if pending
GET    /api/mpesa/transactions       (JWT or API key)  — recent transaction history
GET    /api/mpesa/receipt/:id        (public)           — human-facing receipt link
POST   /api/mpesa/webhook            (public)           — Paystack calls this directly

POST   /api/webhook/endpoints        (JWT or API key)  — merchants register THEIR OWN webhook URLs
GET    /api/webhook/endpoints        (JWT or API key)
GET    /api/webhook/deliveries       (JWT or API key)

GET    /api/admin/merchants          (X-Admin-Secret header)
POST   /api/admin/merchants/:id/approve  (X-Admin-Secret header)
POST   /api/admin/merchants/:id/suspend  (X-Admin-Secret header)
```

Two merchant-facing auth types work interchangeably on most routes now
(`requireMerchantAuth`): a **JWT** from logging in via the dashboard, or an
**API key** (`fxs_live_...` / `fxs_test_...`) for external integrations.
`/api/merchant/*` account-management endpoints remain JWT-only, and
`/api/admin/*` uses a separate shared secret until a real admin system with
its own accounts exists.

There are two separate webhook layers, easy to conflate: `/api/mpesa/webhook`
is Paystack calling **your** FXS Pay backend; `webhook_endpoints` (registered
via `/api/webhook/endpoints`) is FXS Pay calling **merchants'** backends once
a payment is confirmed. FXS Pay sits in the middle of both.

## How a deposit flows end to end

1. Merchant (or the dashboard) calls `POST /api/mpesa/stk-push` with a
   customer phone number and amount.
2. FXS Pay creates a `pending` transaction, then calls Paystack's Charge API
   with `mobile_money: { phone, provider: 'mpesa' }` — passing our own
   `transaction.id` as the `reference`, so Paystack's webhook can be matched
   straight back to this row with no separate invoice id to reconcile.
3. Customer gets the M-Pesa PIN prompt on their phone (Paystack triggered it
   through their own Safaricom relationship — this code never talks to
   Safaricom or Daraja directly).
4. Paystack calls `POST /api/mpesa/webhook` once the charge resolves. The
   handler verifies the HMAC signature using the raw request body (captured
   via Express's `verify` hook in `server.js`), matches the transaction by
   `reference`, credits the merchant's wallet through the ledger, and fires
   FXS Pay's own webhook to the merchant.

## Why cards, full KYC verification, and AML aren't fully built yet

- **Cards**: Paystack already supports Visa/Mastercard/Apple Pay in Kenya —
  extending `initiateStkPush`'s pattern to a card charge is a smaller lift
  now than building a separate card integration from scratch.
- **KYC verification / AML**: this repo has the *data collection* plumbing
  (`merchant_kyc_documents` table, status workflow) but actual identity
  verification and AML compliance require either a licensed KYC provider or
  manual human review — not something to fake with code.
- **Holding customer wallet balances at scale**: operating this as a real
  money-transmission business in Kenya requires a Central Bank of Kenya PSP
  license (or a partnership with an already-licensed entity, which is
  effectively what routing through Paystack gives you for the M-Pesa piece).
  The ledger code here is correct and safe to build on, but launching it
  live with real customer funds beyond what your Paystack relationship
  covers is a legal/licensing step, not a coding one.

## Ledger design note

`wallets.balance` is a cache — the real source of truth is `ledger_entries`,
and every balance change goes through the `apply_ledger_entry` Postgres
function so debits/credits and balance updates happen atomically (no race
condition between two withdrawals hitting the same wallet at once). If you
ever need to reconcile, sum `ledger_entries` per wallet and it must always
match `wallets.balance`.
