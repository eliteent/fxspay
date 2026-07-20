require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const merchantRoutes = require('./routes/merchant.routes');
const walletRoutes = require('./routes/wallet.routes');
const paymentRoutes = require('./routes/payment.routes');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const { retryFailedWebhooks } = require('./services/webhook.service');

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
// Captures the raw request body bytes alongside normal JSON parsing.
// Needed because Paystack's webhook signature (X-Paystack-Signature) is an
// HMAC over the exact raw bytes sent — re-serializing req.body with
// JSON.stringify would not byte-for-byte match what Paystack signed.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Basic rate limiting — tune per-route limits (e.g. tighter on /login) as you grow.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use('/api', apiLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fxspay-backend' }));

app.use('/api/merchant', merchantRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/mpesa', paymentRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Centralized error handler — anything thrown/rejected in a route without its
// own try/catch lands here instead of crashing the process.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`FXS Pay backend listening on port ${PORT}`);
});

// Simple in-process retry loop for pending webhook deliveries.
// On Render, a scheduled job or separate worker is a cleaner long-term home for this.
setInterval(() => {
  retryFailedWebhooks().catch((err) => console.error('Webhook retry error:', err));
}, 60 * 1000);
