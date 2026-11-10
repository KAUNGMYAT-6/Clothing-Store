const crypto = require('crypto');

// A reset token is high-entropy random, so a fast hash is correct here.
// bcrypt's slowness exists to protect low-entropy human passwords from
// brute force; there's nothing to brute-force in 256 bits of randomness.
function createResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = hashToken(token);
  return { token, hash };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { createResetToken, hashToken };