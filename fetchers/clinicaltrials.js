/**
 * ClinicalTrials.gov Fetcher (API v2)
 * - If nct_numbers stored: fetch those specific trials directly
 * - Fallback: search by sponsor name
 * Tracks: trial status, phase, last update date
 * Note: CT.gov is updated by sponsors, not in real-time — useful for status changes
 */

const axios = require('axios');
const { pool } = require('../db');

const CT_BASE = 'https://clinicaltrials.gov/api/v2';

function studyToItem(ticker, study) {
  try {
    const proto = study.protocolSection || {};
    const ident = proto.identificationModule || {};
    const status = proto.statusModule || {};
    const design = proto.designModule || {};
    const sponsor = proto.sponsorCollaboratorsModule || {};

    const nctId = ident.nctId;
    if (!nctId) return null;

    const title = ident.briefTitle || ident.officialTitle || nctId;
    const overallStatus = status.overallStatus || 'Unknown';
    const phase = (design.phases || []).join(', ') || 'N/A';
    const leadSponsor = sponsor.leadSponsor?.name || 'Unknown';
    const lastUpdated = status.lastUpdatePostDateStruct?.date || status.statusVerifiedDate;
    const startDate = status.startDateStruct?.date;
    const completionDate = status.completionDateStruct?.date;

    const summary = [
      `Status: ${overallStatus}`,
      `Phase: ${phase}`,
      `Sponsor: ${leadSponsor}`,
      completionDate ? `Est. completion: ${completionDate}` : null,
      `Updated: ${lastUpdated || 'N/A'}`,
    ].filter(Boolean).join(' | ');

    return {
      ticker,
      source: 'clinicaltrials',
      external_id: nctId,
      title: `${nctId}: ${title}`,
      summary,
      url: `https://clinicaltrials.gov/study/${nctId}`,
      published_at: lastUpdated ? new Date(lastUpdated) : (startDate ? new Date(startDate) : new Date()),
      item_type: 'trial_status',
      raw_data: { nctId, overallStatus, phase, leadSponsor, lastUpdated, completionDate },
    };
  } catch (e) {
    return null;
  }
}

async function run(company) {
  const start = Date.now();
  let itemsFound = 0, itemsNew = 0;

  try {
    const studies = [];

    if (company.nct_numbers && company.nct_numbers.length > 0) {
      // Fetch specific trials by NCT number
      for (const nct of company.nct_numbers) {
        try {
          const res = await axios.get(`${CT_BASE}/studies/${nct}`, {
            params: { format: 'json' },
            timeout: 10000,
          });
          studies.push(res.data);
        } catch (e) {
          console.warn(`[CT.GOV] Could not fetch ${nct}:`, e.message);
        }
      }
    } else {
      // Fallback: search by sponsor + ticker
      const res = await axios.get(`${CT_BASE}/studies`, {
        params: {
          'query.spons': company.company_name,
          pageSize: 20,
          format: 'json',
          fields: 'NCTId,BriefTitle,OverallStatus,Phase,LeadSponsorName,LastUpdatePostDate,CompletionDate',
        },
        timeout: 12000,
      });
      (res.data.studies || []).forEach(s => studies.push(s));
    }

    const items = studies.map(s => studyToItem(company.ticker, s)).filter(Boolean);
    itemsFound = items.length;

    for (const item of items) {
      try {
        const r = await pool.query(
          `INSERT INTO feed_items
             (ticker, source, external_id, title, summary, url, published_at, item_type, raw_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (source, external_id) DO UPDATE
             SET title = EXCLUDED.title,
                 summary = EXCLUDED.summary,
                 published_at = EXCLUDED.published_at,
                 raw_data = EXCLUDED.raw_data
           RETURNING id`,
          [item.ticker, item.source, item.external_id, item.title, item.summary,
           item.url, item.published_at, item.item_type, JSON.stringify(item.raw_data)]
        );
        // Count as "new" on status update too
        if (r.rows.length > 0) itemsNew++;
      } catch (_) {}
    }

    await pool.query(
      `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      ['clinicaltrials', company.ticker, itemsFound, itemsNew, Date.now() - start]
    );
    console.log(`[CT.GOV] ${company.ticker}: ${itemsFound} trials tracked`);
  } catch (err) {
    await pool.query(
      `INSERT INTO fetch_log (source, ticker, error_message, duration_ms)
       VALUES ($1,$2,$3,$4)`,
      ['clinicaltrials', company.ticker, err.message, Date.now() - start]
    );
    console.error(`[CT.GOV] ${company.ticker} error:`, err.message);
  }
}

module.exports = { run };
