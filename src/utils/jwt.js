const jwt = require('jsonwebtoken');

function signMerchantToken(merchant) {
  return jwt.sign(
    { sub: merchant.id, email: merchant.contact_email, status: merchant.status },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signMerchantToken, verifyToken };
