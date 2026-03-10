/**
 * EDGAR Fetcher
 * - Primary: submissions API by CIK (precise, company-specific filings)
 * - Fallback: EFTS full-text search by ticker/name (when CIK not stored)
 * Targets: 8-K, 8-K/A (material events), S-3/S-3ASR (shelf offerings = dilution risk)
 */

const axios = require('axios');
const { pool } = require('../db');

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index';
const HEADERS = { 'User-Agent': 'BioFeed biofeed-app/1.0 research@biofeed.app' };
const TARGET_FORMS = new Set(['8-K', '8-K/A', 'S-3', 'S-3ASR', 'SC 13G/A', 'SC 13D/A']);

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ── CIK-based: precise, uses EDGAR submissions endpoint ──────────────────────

async function fetchByCik(company) {
  const padded = String(company.cik).padStart(10, '0');
  const res = await axios.get(`${SUBMISSIONS_BASE}/CIK${padded}.json`, {
    headers: HEADERS,
    timeout: 12000,
  });

  const data = res.data;
  const filings = data.filings.recent;
  const cutoff = daysAgo(90);
  const items = [];

  for (let i = 0; i < filings.form.length; i++) {
    if (!TARGET_FORMS.has(filings.form[i])) continue;
    if (filings.filingDate[i] < cutoff) break;

    const accession = filings.accessionNumber[i];
    const accessionFlat = accession.replace(/-/g, '');
    const cikNum = parseInt(company.cik, 10);
    const doc = filings.primaryDocument[i] || '';
    const fileUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionFlat}/${doc}`;

    items.push({
      ticker: company.ticker,
      source: 'edgar',
      external_id: accession,
      title: `${filings.form[i]}: ${data.name} — ${filings.primaryDocDescription[i] || filings.form[i]}`,
      summary: `Filed ${filings.filingDate[i]}. Form: ${filings.form[i]}.`,
      url: fileUrl,
      published_at: new Date(filings.filingDate[i]),
      item_type: filings.form[i],
      raw_data: {
        form: filings.form[i],
        date: filings.filingDate[i],
        description: filings.primaryDocDescription[i],
        accession,
      },
    });
  }

  return items;
}

// ── Fallback: EFTS full-text search ─────────────────────────────────────────

async function fetchBySearch(company) {
  // Build a targeted query using ticker + up to 2 search terms
  const terms = [company.ticker, ...(company.search_terms || [])].slice(0, 3);
  const q = terms.map(t => `"${t}"`).join(' OR ');

  const res = await axios.get(EFTS_BASE, {
    params: { q, forms: '8-K,8-K/A,S-3', dateRange: 'custom', startdt: daysAgo(90) },
    headers: HEADERS,
    timeout: 12000,
  });

  const hits = res.data?.hits?.hits || [];

  return hits.map(hit => {
    const s = hit._source || {};
    const accession = hit._id;
    // CIK is the first 10 digits of the accession number (filer's CIK)
    const cikGuess = accession.replace(/-/g, '').slice(0, 10);
    const accessionFlat = accession.replace(/-/g, '');
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cikGuess, 10)}/${accessionFlat}/`;

    return {
      ticker: company.ticker,
      source: 'edgar',
      external_id: accession,
      title: `${s.form_type || '8-K'}: ${s.display_names?.[0] || company.company_name} — ${s.file_date}`,
      summary: s.period_of_report ? `Period of report: ${s.period_of_report}` : `Filed: ${s.file_date}`,
      url: filingUrl,
      published_at: s.file_date ? new Date(s.file_date) : new Date(),
      item_type: s.form_type || '8-K',
      raw_data: s,
    };
  });
}

// ── Shared DB upsert ─────────────────────────────────────────────────────────

async function saveItems(items) {
  let itemsNew = 0;
  for (const item of items) {
    try {
      const r = await pool.query(
        `INSERT INTO feed_items
           (ticker, source, external_id, title, summary, url, published_at, item_type, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (source, external_id) DO NOTHING
         RETURNING id`,
        [item.ticker, item.source, item.external_id, item.title, item.summary,
         item.url, item.published_at, item.item_type, JSON.stringify(item.raw_data)]
      );
      if (r.rows.length > 0) itemsNew++;
    } catch (_) { /* skip individual failures */ }
  }
  return itemsNew;
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function run(company) {
  const start = Date.now();
  let itemsFound = 0, itemsNew = 0;

  try {
    const items = company.cik
      ? await fetchByCik(company)
      : await fetchBySearch(company);

    itemsFound = items.length;
    itemsNew = await saveItems(items);

    await pool.query(
      `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      ['edgar', company.ticker, itemsFound, itemsNew, Date.now() - start]
    );
    console.log(`[EDGAR] ${company.ticker}: ${itemsFound} found, ${itemsNew} new`);
  } catch (err) {
    await pool.query(
      `INSERT INTO fetch_log (source, ticker, error_message, duration_ms)
       VALUES ($1,$2,$3,$4)`,
      ['edgar', company.ticker, err.message, Date.now() - start]
    );
    console.error(`[EDGAR] ${company.ticker} error:`, err.message);
  }
}

module.exports = { run };
