/**
 * RSS News Feed Fetcher
 * Sources: GlobeNewswire Biotechnology, GlobeNewswire Pharmaceuticals
 *
 * Matching strategy:
 *   For each article, check full text (title + snippet) against each company's
 *   search_terms array. Terms include: ticker, full name, short name, drug names.
 *   Match is case-insensitive substring. No regex -- simple and reliable.
 */

const Parser = require('rss-parser');
const { pool } = require('../db');

const RSS_PARSER = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'BioFeed/1.0 (research aggregator)' },
  customFields: { item: ['media:content', 'dc:creator', 'author'] },
});

const FEEDS = [
  {
    source: 'rss_globenewswire_biotech',
    label: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/industry/biotechnology',
  },
  {
    source: 'rss_globenewswire_pharma',
    label: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/industry/pharmaceuticals',
  },
];

function stripHtml(str) {
  if (typeof str !== 'string') {
    try { str = JSON.stringify(str); } catch (_) { return ''; }
  }
  return str.replace(/<[^>]*>/g, '').trim();
}

function getTerms(company) {
  const terms = new Set();
  terms.add(company.ticker.toLowerCase());
  terms.add(company.company_name.toLowerCase());
  if (company.short_name) terms.add(company.short_name.toLowerCase());
  (company.search_terms || []).forEach(t => terms.add(t.toLowerCase()));
  return [...terms].filter(t => t.length >= 4);
}

function matches(text, terms) {
  const lower = text.toLowerCase();
  return terms.some(term => lower.includes(term));
}

async function run(companies) {
  for (const feed of FEEDS) {
    const start = Date.now();
    let itemsFound = 0, itemsNew = 0;

    try {
      const feedData = await RSS_PARSER.parseURL(feed.url);
      const feedItems = feedData.items || [];

      for (const item of feedItems) {
        const cleanTitle = stripHtml(item.title || '');

        const searchText = [
          cleanTitle,
          item.contentSnippet || '',
          item.content || '',
          item.summary || '',
        ].join(' ');

        for (const company of companies) {
          const terms = getTerms(company);
          if (!matches(searchText, terms)) continue;

          const rawId = item.guid || item.id || item.link || item.title || String(Date.now());
          const externalId = `${company.ticker}::${rawId}`;

          const pubDate = item.pubDate || item.isoDate
            ? new Date(item.pubDate || item.isoDate)
            : new Date();

          const author = item['dc:creator'] || item.author || item.creator || '';
          const summary = (item.contentSnippet || item.summary || '').slice(0, 600);

          itemsFound++;

          try {
            const r = await pool.query(
              `INSERT INTO feed_items
                 (ticker, source, external_id, title, summary, url, published_at, item_type, raw_data)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (source, external_id) DO NOTHING
               RETURNING id`,
              [
                company.ticker,
                feed.source,
                externalId,
                cleanTitle || '(no title)',
                summary,
                item.link || item.url || null,
                pubDate,
                'news',
                JSON.stringify({ publication: feed.label, author }),
              ]
            );
            if (r.rows.length > 0) itemsNew++;
          } catch (_) {}
        }
      }

      await pool.query(
        `INSERT INTO fetch_log (source, items_found, items_new, duration_ms)
         VALUES ($1,$2,$3,$4)`,
        [feed.source, itemsFound, itemsNew, Date.now() - start]
      );
      console.log(`[RSS:${feed.label}]: ${itemsFound} matches, ${itemsNew} new`);
    } catch (err) {
      await pool.query(
        `INSERT INTO fetch_log (source, error_message, duration_ms)
         VALUES ($1,$2,$3)`,
        [feed.source, err.message, Date.now() - start]
      );
      console.error(`[RSS:${feed.label}] error:`, err.message);
    }
  }
}

module.exports = { run };
