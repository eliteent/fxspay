const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { requireMerchantAuth } = require('../middleware/auth');

router.get('/', requireMerchantAuth, walletController.listWallets);
router.get('/:currency/balance', requireMerchantAuth, walletController.getBalance);
router.post('/transfer', requireMerchantAuth, walletController.transfer);

module.exports = router;
