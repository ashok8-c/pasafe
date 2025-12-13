const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev_secret_change';

function signDevice(deviceId) {
  return jwt.sign({ deviceId }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (e) {
    return null;
  }
}

function deviceAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'missing token' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'bad auth' });
  const payload = verifyToken(parts[1]);
  if (!payload) return res.status(401).json({ error: 'invalid token' });
  req.deviceId = payload.deviceId;
  next();
}

module.exports = { signDevice, verifyToken, deviceAuthMiddleware };
