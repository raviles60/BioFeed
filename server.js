require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const { initDb } = require('./db');
const feedRoutes = require('./routes/feed');
const companiesRoutes = require('./routes/companies');
const { runAllFetchers } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/feed', feedRoutes);
app.use('/api/companies', companiesRoutes);

// One-time schema setup — hit this URL once after first deploy
app.get('/api/setup', async (req, res) => {
  try {
    await initDb();
    res.json({ success: true, message: 'Database schema initialized. You can now add companies via POST /api/companies.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger a full fetch cycle (useful for testing)
app.post('/api/fetch/run', async (req, res) => {
  res.json({ success: true, message: 'Fetch cycle started in background' });
  setImmediate(runAllFetchers);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Cron Scheduler — every 30 minutes ───────────────────────────────────────
cron.schedule('*/30 * * * *', () => {
  console.log('[CRON] 30-minute cycle triggered');
  runAllFetchers();
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] BioFeed running on port ${PORT}`);
  // Initial fetch 8 seconds after startup (gives DB time to connect)
  setTimeout(runAllFetchers, 8000);
});
