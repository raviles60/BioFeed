/**
 * StockTwits Sentiment Fetcher
 * - Only runs for companies with catalyst_date within 14 days
 * - Public API, no auth required: api.stocktwits.com/api/2/streams/symbol/{TICKER}.json
 * - Returns last ~30 messages with built-in Bullish/Bearish sentiment labels
 * - Stores a snapshot each run (not deduped — we want time-series history)
 * - Rate limit: ~200 req/hour unauthenticated — at max 10 tickers × 2/hour = 20/hour, well within limits
 */

const axios = require('axios');
const { pool } = require('../db');

const ST_BASE = 'https://api.stocktwits.com/api/2/streams/symbol';

async function run(company) {
  const start = Date.now();

  try {
    const res = await axios.get(`${ST_BASE}/${company.ticker}.json`, {
      timeout: 10000,
      headers: { 'User-Agent': 'BioFeed/1.0' },
    });

    const messages = res.data.messages || [];
    let bull = 0, bear = 0, neutral = 0;

    for (const msg of messages) {
      const s = msg.entities?.sentiment?.basic;
      if (s === 'Bullish') bull++;
      else if (s === 'Bearish') bear++;
      else neutral++;
    }

    const total = messages.length;
    // Bull percent only counts labeled messages (some users don't label)
    const labeled = bull + bear;
    const bullPercent = labeled > 0
      ? parseFloat(((bull / labeled) * 100).toFixed(2))
      : null;

    await pool.query(
      `INSERT INTO sentiment_snapshots
         (ticker, bull_count, bear_count, total_count, bull_percent)
       VALUES ($1,$2,$3,$4,$5)`,
      [company.ticker, bull, bear, total, bullPercent]
    );

    await pool.query(
      `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      ['stocktwits', company.ticker, total, 1, Date.now() - start]
    );

    const label = bullPercent !== null ? `${bullPercent}% bull` : 'no labeled sentiment';
    console.log(`[StockTwits] ${company.ticker}: ${bull}↑ ${bear}↓ / ${total} msgs — ${label}`);
  } catch (err) {
    // 404 = no StockTwits stream for this ticker (thin/OTC stocks) — not a real error
    if (err.response?.status !== 404) {
      await pool.query(
        `INSERT INTO fetch_log (source, ticker, error_message, duration_ms)
         VALUES ($1,$2,$3,$4)`,
        ['stocktwits', company.ticker, err.message, Date.now() - start]
      );
      console.error(`[StockTwits] ${company.ticker} error:`, err.message);
    } else {
      console.log(`[StockTwits] ${company.ticker}: no stream found (404)`);
    }
  }
}

module.exports = { run };
