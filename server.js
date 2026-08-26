require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const db = require('./db');
const logic = require('./logic');
const auth = require('./auth');
const bot = require('./bot');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth ----------

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: auth.GOOGLE_CLIENT_ID, configured: auth.isConfigured() });
});

app.get('/api/auth/me', (req, res) => {
  const session = auth.readSession(req);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  res.json({ email: session.email, name: session.name });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'credential is required' });
  if (!auth.isConfigured()) {
    return res.status(500).json({ error: 'Google 登入尚未設定完成（缺少 GOOGLE_CLIENT_ID 或 ALLOWED_GOOGLE_EMAIL）' });
  }
  try {
    const user = await auth.verifyGoogleIdToken(credential);
    if (user.email.toLowerCase() !== auth.ALLOWED_GOOGLE_EMAIL) {
      return res.status(403).json({ error: '此帳號未被授權使用這個儀表板' });
    }
    auth.issueSessionCookie(res, user);
    res.json({ ok: true, email: user.email, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: '登入驗證失敗' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- data api (requires login) ----------

app.post('/api/chat', auth.requireAuth, async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    const result = await logic.handleMessage(message);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/summary', auth.requireAuth, async (req, res) => {
  const month = req.query.month || logic.currentMonthKey();
  res.json(await logic.getMonthSummary(month));
});

app.get('/api/trend', auth.requireAuth, async (req, res) => {
  const months = parseInt(req.query.months, 10) || 6;
  res.json(await logic.getTrend(months));
});

app.get('/api/budgets', auth.requireAuth, async (req, res) => {
  const month = req.query.month || logic.currentMonthKey();
  res.json(await logic.getBudgetStatus(month));
});

app.get('/api/goals', auth.requireAuth, async (req, res) => {
  res.json(await logic.getGoals());
});

const PORT = process.env.PORT || 3000;

(async () => {
  await db.init();
  bot.init(app);
  app.listen(PORT, () => {
    console.log(`財務規劃機器人已啟動： http://localhost:${PORT}`);
  });
})();
