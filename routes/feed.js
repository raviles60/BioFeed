const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/feed/dashboard — all companies + their feed items + latest sentiment
// Single API call for the frontend to load everything at once
router.get('/dashboard', async (req, res) => {
  try {
    const companies = await pool.query(
      `SELECT c.*,
        (SELECT bull_percent FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bull_percent,
        (SELECT bear_count  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bear_count,
        (SELECT bull_count  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bull_count,
        (SELECT total_count FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_sentiment_total,
        (SELECT fetched_at  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS last_sentiment_at
       FROM companies c
       WHERE c.active = true
       ORDER BY c.catalyst_date ASC NULLS LAST`
    );

    const result = [];
    for (const company of companies.rows) {
      const items = await pool.query(
        `SELECT * FROM feed_items WHERE ticker = $1 ORDER BY published_at DESC NULLS LAST LIMIT 20`,
        [company.ticker]
      );
      result.push({ ...company, feed_items: items.rows });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/feed/timeline — all items across all companies, newest first
router.get('/timeline', async (req, res) => {
  try {
    const { source, limit = 100, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE c.active = true';

    if (source) {
      params.push(source);
      where += ` AND f.source = $${params.length}`;
    }

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const result = await pool.query(
      `SELECT f.*, c.company_name, c.catalyst_date, c.catalyst_type
       FROM feed_items f
       JOIN companies c ON c.ticker = f.ticker
       ${where}
       ORDER BY f.published_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/feed/:ticker — items for one ticker
router.get('/:ticker', async (req, res) => {
  try {
    const { limit = 50, source } = req.query;
    const params = [req.params.ticker.toUpperCase()];
    let where = 'WHERE ticker = $1';

    if (source) {
      params.push(source);
      where += ` AND source = $${params.length}`;
    }

    params.push(parseInt(limit));
    const result = await pool.query(
      `SELECT * FROM feed_items ${where} ORDER BY published_at DESC NULLS LAST LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/feed/sentiment/:ticker — sentiment history (last 48 snapshots)
router.get('/sentiment/:ticker', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM sentiment_snapshots WHERE ticker = $1 ORDER BY fetched_at DESC LIMIT 48`,
      [req.params.ticker.toUpperCase()]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/feed/log/recent — last 50 fetch log entries (for status modal)
router.get('/log/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM fetch_log ORDER BY ran_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
