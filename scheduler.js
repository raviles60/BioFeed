/**
 * Fetch Scheduler
 * - Called by cron every 30 minutes and once on startup
 * - RSS runs once per cycle (single pass across all 4 feeds, matched per company)
 * - Per-company fetchers: EDGAR, ClinicalTrials, openFDA
 * - StockTwits: all active companies
 * - 500ms delay between per-company API calls to be a polite client
 */

const { pool } = require('./db');
const edgar = require('./fetchers/edgar');
const clinicalTrials = require('./fetchers/clinicaltrials');
const openFda = require('./fetchers/openfda');
const rss = require('./fetchers/rss');
const webSearch = require('./fetchers/websearch');
const stocktwits = require('./fetchers/stocktwits');

let isRunning = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDaysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

/**
 * Auto-deactivate companies whose catalyst_date has passed.
 * Runs once at the start of every scheduler cycle.
 * Companies are deactivated the day AFTER their catalyst_date so that
 * same-day coverage is preserved (e.g. the morning of a PDUFA decision).
 */
async function autoDeactivateExpired() {
  const result = await pool.query(
    `UPDATE companies
     SET active = false, updated_at = NOW()
     WHERE active = true
       AND catalyst_date IS NOT NULL
       AND catalyst_date < CURRENT_DATE
     RETURNING ticker, catalyst_date`
  );
  if (result.rows.length > 0) {
    const deactivated = result.rows.map(r => `${r.ticker} (${r.catalyst_date})`).join(', ');
    console.log(`[SCHEDULER] Auto-deactivated expired tickers: ${deactivated}`);
  }
}

async function getActiveCompanies() {
  const result = await pool.query(
    'SELECT * FROM companies WHERE active = true ORDER BY catalyst_date ASC NULLS LAST'
  );
  return result.rows;
}

async function runAllFetchers() {
  if (isRunning) {
    console.log('[SCHEDULER] Already running — skipping this cycle');
    return;
  }
  isRunning = true;

  const cycleStart = Date.now();
  console.log(`[SCHEDULER] -- Cycle start ${new Date().toISOString()} --`);

  // -- Auto-deactivate expired tickers before loading active companies -----
  try {
    await autoDeactivateExpired();
  } catch (err) {
    console.error('[SCHEDULER] autoDeactivateExpired error:', err.message);
  }

  let companies;
  try {
    companies = await getActiveCompanies();
  } catch (err) {
    console.error('[SCHEDULER] Failed to load companies:', err.message);
    isRunning = false;
    return;
  }

  if (companies.length === 0) {
    console.log('[SCHEDULER] No active companies -- nothing to fetch');
    isRunning = false;
    return;
  }

  console.log(`[SCHEDULER] ${companies.length} active companies: ${companies.map(c => c.ticker).join(', ')}`);

  // -- 1. RSS -- single pass across all 4 feeds, matched per company ---------
  try {
    await rss.run(companies);
  } catch (err) {
    console.error('[SCHEDULER] RSS fatal error:', err.message);
  }

  // -- 2. Web Search -- Google News RSS per company -------------------------
  try {
    await webSearch.run(companies);
  } catch (err) {
    console.error('[SCHEDULER] WebSearch fatal error:', err.message);
  }

  // -- 3. Per-company fetchers -----------------------------------------------
  for (const company of companies) {
    // EDGAR
    try { await edgar.run(company); } catch (e) { console.error('[EDGAR] fatal:', e.message); }
    await delay(500);

    // ClinicalTrials.gov
    try { await clinicalTrials.run(company); } catch (e) { console.error('[CT] fatal:', e.message); }
    await delay(500);

    // openFDA
    try { await openFda.run(company); } catch (e) { console.error('[FDA] fatal:', e.message); }
    await delay(500);

    // StockTwits -- all active companies
    try { await stocktwits.run(company); } catch (e) { console.error('[ST] fatal:', e.message); }
    await delay(500);
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[SCHEDULER] -- Cycle complete in ${elapsed}s --`);
  isRunning = false;
}

module.exports = { runAllFetchers };
