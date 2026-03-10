const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/companies — all active companies with stats
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        (SELECT COUNT(*) FROM feed_items f WHERE f.ticker = c.ticker)::int AS item_count,
        (SELECT bull_percent FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bull_percent,
        (SELECT bear_count  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bear_count,
        (SELECT bull_count  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_bull_count,
        (SELECT total_count FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS latest_sentiment_total,
        (SELECT fetched_at  FROM sentiment_snapshots s WHERE s.ticker = c.ticker ORDER BY fetched_at DESC LIMIT 1) AS last_sentiment_at,
        (SELECT ran_at      FROM fetch_log l WHERE l.ticker = c.ticker ORDER BY ran_at DESC LIMIT 1) AS last_fetched_at
      FROM companies c
      WHERE c.active = true
      ORDER BY c.catalyst_date ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies — add or update a company
router.post('/', async (req, res) => {
  try {
    const {
      ticker, company_name, short_name, cik,
      catalyst_date, catalyst_type,
      nda_application, nct_numbers, search_terms,
    } = req.body;

    if (!ticker || !company_name) {
      return res.status(400).json({ error: 'ticker and company_name are required' });
    }

    const result = await pool.query(`
      INSERT INTO companies
        (ticker, company_name, short_name, cik, catalyst_date, catalyst_type,
         nda_application, nct_numbers, search_terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (ticker) DO UPDATE SET
        company_name    = EXCLUDED.company_name,
        short_name      = EXCLUDED.short_name,
        cik             = EXCLUDED.cik,
        catalyst_date   = EXCLUDED.catalyst_date,
        catalyst_type   = EXCLUDED.catalyst_type,
        nda_application = EXCLUDED.nda_application,
        nct_numbers     = EXCLUDED.nct_numbers,
        search_terms    = EXCLUDED.search_terms,
        active          = true,
        updated_at      = NOW()
      RETURNING *`,
      [
        ticker.toUpperCase(), company_name, short_name || null, cik || null,
        catalyst_date || null, catalyst_type || null,
        nda_application || null,
        nct_numbers || [],
        search_terms || [],
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/companies/:ticker — partial update
router.put('/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const allowed = [
      'company_name', 'short_name', 'cik', 'catalyst_date', 'catalyst_type',
      'nda_application', 'nct_numbers', 'search_terms', 'active',
    ];

    const updates = [];
    const values = [];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        values.push(req.body[field]);
        updates.push(`${field} = $${values.length}`);
      }
    });

    if (updates.length === 0) return res.json({ message: 'Nothing to update' });

    values.push(ticker.toUpperCase());
    const result = await pool.query(
      `UPDATE companies SET ${updates.join(', ')}, updated_at = NOW()
       WHERE ticker = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticker not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/companies/:ticker — soft delete (sets active = false)
router.delete('/:ticker', async (req, res) => {
  try {
    await pool.query(
      `UPDATE companies SET active = false, updated_at = NOW() WHERE ticker = $1`,
      [req.params.ticker.toUpperCase()]
    );
    res.json({ success: true, message: `${req.params.ticker} deactivated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
