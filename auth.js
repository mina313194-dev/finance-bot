const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_GOOGLE_EMAIL = (process.env.ALLOWED_GOOGLE_EMAIL || '').toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const COOKIE_NAME = 'session';

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function isConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && ALLOWED_GOOGLE_EMAIL);
}

async function verifyGoogleIdToken(idToken) {
  if (!oauthClient) throw new Error('GOOGLE_CLIENT_ID 尚未設定');
  const ticket = await oauthClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  return { email: payload.email, name: payload.name, sub: payload.sub };
}

function issueSessionCookie(res, user) {
  const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '30d',
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function readSession(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  req.user = session;
  next();
}

module.exports = {
  GOOGLE_CLIENT_ID,
  ALLOWED_GOOGLE_EMAIL,
  isConfigured,
  verifyGoogleIdToken,
  issueSessionCookie,
  clearSessionCookie,
  readSession,
  requireAuth,
};
