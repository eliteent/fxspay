# FXS Pay — API Integration Guide

This document is written so a developer (or an AI assistant working on their
behalf) can integrate a merchant's app with FXS Pay without needing anything
beyond what's here.

## Base URL

```
https://fxspay.onrender.com
```

All endpoints below are relative to this base URL.

## Authentication

FXS Pay uses two different auth methods depending on who's calling:

| Type | Used for | Header |
|---|---|---|
| **API key** | Server-to-server integration (your backend calling FXS Pay) | `Authorization: Bearer fxs_live_xxxxx` or `fxs_test_xxxxx` |
| **JWT** | A logged-in merchant's own dashboard session | `Authorization: Bearer <jwt-from-login>` |

For almost every endpoint below, **either** works interchangeably — the API
accepts whichever one you send. If you're building a backend integration
(the common case), use an **API key**.

### Getting an API key

1. Register a merchant account: `POST /api/merchant/register`
2. Get the account approved (an FXS Pay admin does this — new accounts start
   as `pending` and can't get a **live** key until approved; a **test** key
   can be issued immediately regardless of approval status)
3. Generate a key: `POST /api/merchant/api-key`
4. **The full key is shown exactly once in the response.** Store it
   immediately — FXS Pay never stores or displays the full value again,
   only a one-way hash. If lost, generate a new one.

---

## Merchant Account

### Register
```
POST /api/merchant/register
Content-Type: application/json

{
  "businessName": "Acme Ltd",
  "email": "you@acme.com",
  "phone": "254712345678",   // optional
  "password": "at-least-8-chars"
}
```
**Response `201`:**
```json
{
  "merchant": { "id": "...", "business_name": "...", "contact_email": "...", "status": "pending", "kyc_status": "pending", "account_code": "FXS7K9QRT", "created_at": "..." },
  "token": "eyJ..."
}
```

### Login
```
POST /api/merchant/login
{ "email": "...", "password": "..." }
```
Returns the same `{ merchant, token }` shape.

### Get profile
```
GET /api/merchant/profile
Authorization: Bearer <jwt or api key>
```

### Update profile
```
PUT /api/merchant/profile
{ "businessName": "...", "phone": "...", "preferredCurrency": "KES" }
```

### Create an API key
```
POST /api/merchant/api-key
{ "env": "live", "label": "My server" }   // env: "live" | "test"
```
**Response `201`:**
```json
{ "apiKey": "fxs_live_...", "record": { "id": "...", "key_prefix": "fxs_live_", "label": "My server", "created_at": "..." } }
```
`apiKey` is the only time the full value is returned — save it now.

### List your API keys (metadata only, no secrets)
```
GET /api/merchant/api-keys
```

---

## Wallet

Every merchant has a wallet per currency (created automatically on first use).

### List wallets
```
GET /api/wallet
```
```json
{ "wallets": [{ "id": "...", "currency": "KES", "balance": "1250.00", "status": "active" }] }
```

### Get balance for a specific currency
```
GET /api/wallet/KES/balance
```

### Internal transfer between your own currency wallets
```
POST /api/wallet/transfer
{ "fromCurrency": "KES", "toCurrency": "USD", "amount": 500 }
```
Note: this is a 1:1 transfer placeholder, not a real FX conversion — don't
use it across currencies expecting a real exchange rate applied yet.

---

## Payments — M-Pesa STK Push

Triggers a real M-Pesa payment prompt on the customer's phone. No card/PIN
data ever touches your server or FXS Pay's — this is server-initiated, the
customer just enters their M-Pesa PIN on their own phone.

```
POST /api/mpesa/stk-push
{
  "phone": "254712345678",       // any common format is normalized automatically
  "amount": 100,                  // KES, whole number or decimal
  "description": "Order #123",    // optional
  "email": "customer@x.com"       // optional — defaults to your own merchant email if omitted
}
```
**Response `202`:**
```json
{ "message": "STK push sent...", "transactionId": "uuid-here", "paystackStatus": "pay_offline" }
```

Save `transactionId` — you'll need it to check status or match it against
the webhook event later.

### Check status
```
GET /api/mpesa/status/:transactionId
```
```json
{ "transaction": { "id": "...", "status": "pending" | "success" | "failed", "amount": "100.00", "currency": "KES", ... } }
```
This also actively polls Paystack if still `pending`, so it's safe to poll
this endpoint as a fallback even if you're also listening for the webhook.

### List recent transactions
```
GET /api/mpesa/transactions?limit=20
```

### Human-facing receipt page (public, no auth — safe to link/redirect a customer to)
```
GET /api/mpesa/receipt/:transactionId
```
Returns an HTML page, not JSON.

---

## Payments — Card & Bank Transfer (Pesalink)

**This works differently from STK push.** Card numbers and bank details must
never be sent to your server or FXS Pay's — that would put you in PCI DSS
scope. Instead, this returns a checkout link that the **customer's own
browser** must visit; they enter payment details directly on Paystack's
hosted, PCI-compliant page.

```
POST /api/mpesa/checkout
{
  "method": "card",              // "card" | "bank"
  "amount": 1000,
  "email": "customer@x.com",     // required — the checkout page needs this
  "description": "Order #123"    // optional
}
```
**Response `202`:**
```json
{ "transactionId": "uuid-here", "authorizationUrl": "https://checkout.paystack.com/xxxxx" }
```

**What to do with `authorizationUrl`:** redirect the customer's browser to
it (full page redirect, new tab, or an iframe — your choice). After they
complete or cancel, Paystack redirects them back to a receipt page
automatically. The same webhook (below) fires regardless of card, bank, or
M-Pesa — your backend doesn't need separate logic per payment method beyond
how you initiated it.

---

## Webhooks — FXS Pay → your backend

This is how you find out a payment succeeded or failed, in real time,
without polling.

### 1. Register your webhook URL (once)
```
POST /api/webhook/endpoints
{ "url": "https://your-backend.com/webhooks/fxspay" }
```
**Response:**
```json
{ "endpoint": { "id": "...", "url": "...", "secret": "abc123...", "is_active": true } }
```
**Save `secret` — you need it to verify incoming webhooks.** It's shown
once here, same rule as API keys.

### 2. Receiving events

FXS Pay POSTs JSON to your registered URL with these headers:
```
X-FXSPay-Signature: <hex HMAC-SHA256 of the raw JSON body, using your secret>
X-FXSPay-Event: payment.success | payment.failed
```

**Verifying the signature (Node.js example):**
```javascript
const crypto = require('crypto');

function verifyFxsPaySignature(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected === signatureHeader;
}
```
**Important:** compute the HMAC over the **raw request body bytes**, not a
re-serialized `JSON.stringify(req.body)` — those can differ in whitespace/key
order and will fail verification. In Express, capture the raw body via a
`verify` callback on your JSON body parser:
```javascript
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
```

### 3. Event payloads

**`payment.success`:**
```json
{
  "transactionId": "uuid-here",
  "amount": 100,
  "currency": "KES",
  "paystackReference": "...",
  "receiptUrl": "https://fxspay.onrender.com/api/mpesa/receipt/uuid-here"
}
```

**`payment.failed`:**
```json
{ "transactionId": "uuid-here", "reason": "Insufficient funds" }
```

Match `transactionId` against the id you got back from `stk-push` or
`checkout` to know which of your own orders/deposits this refers to.

### 4. Delivery behavior
- FXS Pay retries failed deliveries with exponential backoff, up to 5 attempts.
- Always return a `200` response quickly once you've verified the signature
  — do your actual processing after responding if it's slow, since FXS Pay
  will treat a timeout as a failure and retry.
- Deliveries are idempotent-safe on FXS Pay's side, but your handler should
  still be safe to receive the same event twice (e.g. check your own
  transaction's status before crediting a balance twice).

### List your registered endpoints / delivery history
```
GET /api/webhook/endpoints
GET /api/webhook/deliveries
```

---

## Airtime & Bundle Reselling

For merchants who resell airtime/data bundles. FXS Pay handles payment and
queues the order — **you** (or your own automation, e.g. a GSM modem/USSD
script) handle actually delivering the airtime/bundle.

### Manage your product catalog
```
GET  /api/bundles/products
POST /api/bundles/products
{ "name": "1GB Daily Bundle", "category": "bundle", "price": 99, "fulfillmentCode": "*544*2*1#" }

PUT  /api/bundles/products/:productId
{ "isActive": false }   // or update name/price/fulfillmentCode
```
`fulfillmentCode` is opaque to FXS Pay — put whatever your own fulfillment
system needs to identify what to deliver (a USSD string, a SKU, anything).

### Sell a product (triggers payment)
```
POST /api/bundles/purchase
{ "productId": "...", "customerPhone": "254712345678", "payerPhone": "254712345678" }
```
`customerPhone` = who receives the airtime/bundle. `payerPhone` = who gets
asked for the M-Pesa PIN (can differ — e.g. buying for someone else).
Triggers an STK push automatically under the hood.

### Fulfillment queue (poll this from your own fulfillment worker)
```
GET /api/bundles/queue?status=queued
```
Returns orders where payment has succeeded and fulfillment is pending.

```
POST /api/bundles/queue/:orderId/claim     # optional, prevents double-processing across multiple workers
POST /api/bundles/queue/:orderId/complete
{ "success": true, "notes": "Delivered via USSD" }
```

---

## Error format

Every error response follows the same shape:
```json
{ "error": "Human-readable message" }
```
Common HTTP status codes: `400` (bad input), `401` (missing/invalid auth),
`403` (valid auth, but not allowed to do this — e.g. live key requested
before approval), `404` (not found), `409` (conflict, e.g. duplicate email),
`502` (upstream payment provider failed).

## Rate limits

100 requests per minute per IP address, applied across all `/api/*` routes.

## Currency

All amounts are in **KES** (Kenyan Shillings) currently. Send amounts as
plain numbers (`100`, `99.50`), not subunits — FXS Pay handles the
conversion to whatever the underlying payment provider expects internally.

## What NOT to build against

- **Don't** try to charge cards directly via a raw API — there's no such
  endpoint, by design. Use `/api/mpesa/checkout` and redirect the customer.
- **Don't** treat `/api/mpesa/webhook` as something you call — that's
  Paystack calling FXS Pay internally, not part of your integration surface.
- **Don't** assume synchronous payment confirmation from `stk-push` or
  `checkout` — both return `202 Accepted` immediately, meaning "started,"
  not "completed." Always confirm via webhook or `/status/:transactionId`.
