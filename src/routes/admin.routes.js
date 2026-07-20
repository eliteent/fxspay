const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAdminSecret } = require('../middleware/auth');

router.use(requireAdminSecret);

router.get('/merchants', adminController.listMerchants);
router.post('/merchants/:merchantId/approve', adminController.approveMerchant);
router.post('/merchants/:merchantId/suspend', adminController.suspendMerchant);

module.exports = router;
