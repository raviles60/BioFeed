/**
 * openFDA Drug Applications Fetcher
 * - Tracks NDA/BLA application submissions, status changes, and actions
 * - Primary: by application number (nda_application field, e.g. "NDA213062")
 * - Fallback: by sponsor name (first word of company name to avoid truncation issues)
 * Note: openFDA is not real-time — reflects official FDA action data, updated periodically
 */

const axios = require('axios');
const { pool } = require('../db');

const FDA_BASE = 'https://api.fda.gov/drug/drugsfda.json';

// Submission types worth surfacing
const NOTABLE_TYPES = new Set([
  'ORIG', 'SUPPL', 'REMS', 'BLA EFFICACY SUPPLEMENT',
  'EFFICACY SUPPLEMENT', 'LABELING',
]);

async function run(company) {
  const start = Date.now();
  let itemsFound = 0, itemsNew = 0;

  try {
    let searchParam;
    if (company.nda_application) {
      searchParam = `application_number:"${company.nda_application}"`;
    } else {
      // Use first meaningful word of company name as sponsor search
      const word = company.company_name
        .replace(/,?\s*(Inc|LLC|Corp|Ltd|Therapeutics|Pharmaceuticals|Sciences|Biosciences|Biotechnology)\.?$/i, '')
        .trim()
        .split(' ')[0];
      searchParam = `sponsor_name:"${word}"`;
    }

    const res = await axios.get(FDA_BASE, {
      params: { search: searchParam, limit: 10 },
      timeout: 12000,
    });

    const results = res.data.results || [];
    const items = [];

    for (const app of results) {
      const appNum = app.application_number || '';
      const sponsor = app.sponsor_name || '';
      const products = (app.products || []).map(p => p.brand_name || p.generic_name).filter(Boolean).join(', ');

      // Surface recent submissions (last 10 per application)
      const submissions = (app.submissions || []).slice(0, 10);

      for (const sub of submissions) {
        const actionDate = sub.submission_status_date || sub.submission_date;
        const externalId = `${appNum}-${sub.submission_type}-${sub.submission_number}`;
        const statusLabel = sub.submission_status || 'Unknown';
        const reviewPriority = sub.review_priority || '';

        const title = `FDA ${appNum}: ${sub.submission_type} ${sub.submission_number} — ${statusLabel}`;
        const summary = [
          `Sponsor: ${sponsor}`,
          products ? `Product(s): ${products}` : null,
          reviewPriority ? `Review priority: ${reviewPriority}` : null,
          actionDate ? `Action date: ${actionDate}` : null,
        ].filter(Boolean).join(' | ');

        const appNumClean = appNum.replace(/[^0-9]/g, '');
        const url = `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appNumClean}`;

        items.push({
          ticker: company.ticker,
          source: 'openfda',
          external_id: externalId,
          title,
          summary,
          url,
          published_at: actionDate ? new Date(actionDate) : new Date(),
          item_type: 'fda_submission',
          raw_data: { appNum, sponsor, products, submission: sub },
        });

        itemsFound++;
      }
    }

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
      } catch (_) {}
    }

    await pool.query(
      `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      ['openfda', company.ticker, itemsFound, itemsNew, Date.now() - start]
    );
    console.log(`[openFDA] ${company.ticker}: ${itemsFound} submissions found, ${itemsNew} new`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[openFDA] ${company.ticker}: no FDA application data found`);
      await pool.query(
        `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
         VALUES ($1,$2,$3,$4,$5)`,
        ['openfda', company.ticker, 0, 0, Date.now() - start]
      );
    } else {
      await pool.query(
        `INSERT INTO fetch_log (source, ticker, error_message, duration_ms)
         VALUES ($1,$2,$3,$4)`,
        ['openfda', company.ticker, err.message, Date.now() - start]
      );
      console.error(`[openFDA] ${company.ticker} error:`, err.message);
    }
  }
}

module.exports = { run };
