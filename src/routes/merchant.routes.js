const express = require('express');
const router = express.Router();
const merchantController = require('../controllers/merchant.controller');
const { requireJwt } = require('../middleware/auth');

router.post('/register', merchantController.register);
router.post('/login', merchantController.login);
router.get('/profile', requireJwt, merchantController.getProfile);
router.put('/profile', requireJwt, merchantController.updateProfile);
router.post('/api-key', requireJwt, merchantController.createApiKey);
router.get('/api-keys', requireJwt, merchantController.listApiKeys);
router.delete('/account', requireJwt, merchantController.deleteAccount);

module.exports = router;
