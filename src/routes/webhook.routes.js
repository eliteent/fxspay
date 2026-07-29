const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const { requireMerchantAuth } = require('../middleware/auth');

router.post('/endpoints', requireMerchantAuth, webhookController.registerEndpoint);
router.get('/endpoints', requireMerchantAuth, webhookController.listEndpoints);
router.get('/deliveries', requireMerchantAuth, webhookController.listDeliveries);

module.exports = router;
