const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { requireMerchantAuth } = require('../middleware/auth');

// Merchant-authenticated (JWT dashboard session or API key)
router.post('/stk-push', requireMerchantAuth, paymentController.initiateStkPush);
router.get('/status/:transactionId', requireMerchantAuth, paymentController.getStatus);
router.get('/transactions', requireMerchantAuth, paymentController.listTransactions);

// Public — human-facing receipt link
router.get('/receipt/:transactionId', paymentController.getReceipt);

// Public — Paystack calls this directly. Signature verification uses
// req.rawBody, captured globally in server.js's express.json() verify
// callback — see the note there for why express.raw() alone isn't used.
router.post('/webhook', paymentController.handleWebhook);

module.exports = router;
