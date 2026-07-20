const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const { requireApiKey } = require('../middleware/auth');

router.post('/endpoints', requireApiKey, webhookController.registerEndpoint);
router.get('/endpoints', requireApiKey, webhookController.listEndpoints);
router.get('/deliveries', requireApiKey, webhookController.listDeliveries);

module.exports = router;
