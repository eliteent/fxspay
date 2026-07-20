const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAdminAccess, requireAdminSecret } = require('../middleware/auth');

// Day-to-day admin actions: either a real admin's login (is_admin=true) or the root secret
router.get('/merchants', requireAdminAccess, adminController.listMerchants);
router.post('/merchants/:merchantId/approve', requireAdminAccess, adminController.approveMerchant);
router.post('/merchants/:merchantId/suspend', requireAdminAccess, adminController.suspendMerchant);

// Promoting/revoking admin status is root-secret-only — deliberately not
// reachable with a regular admin's own login, so an admin can't silently
// grant themselves or others broader access without the root secret.
router.post('/merchants/:merchantId/make-admin', requireAdminSecret, adminController.makeAdmin);
router.post('/merchants/:merchantId/revoke-admin', requireAdminSecret, adminController.revokeAdmin);

module.exports = router;
