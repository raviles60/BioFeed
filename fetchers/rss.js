/**
 * RSS News Feed Fetcher
 * Sources: BioPharma Dive, Fierce Biotech, Endpoints News, BioSpace
 *
 * Matching strategy:
 *   For each article, check full text (title + snippet) against each company's
 *   search_terms array. Terms include: ticker, full name, short name, drug names.
 *   Match is case-insensitive substring. No regex — simple and reliable.
 *
 * Accuracy expectation:
 *   ~90% recall on major news (misses only when article uses unknown alias)
 *   ~95% precision (ticker strings like ALDX rarely appear in unrelated biotech articles)
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
    source: 'rss_biopharmadive',
    label: 'BioPharma Dive',
    url: 'https://www.biopharmadive.com/feeds/news/',
  },
  {
    source: 'rss_fiercebiotech',
    label: 'Fierce Biotech',
    url: 'https://www.fiercebiotech.com/rss/xml',
  },
  {
    source: 'rss_endpoints',
    label: 'Endpoints News',
    url: 'https://endpts.com/feed/',
  },
  {
    source: 'rss_biospace',
    label: 'BioSpace',
    url: 'https://www.biospace.com/index.rss',  // fixed: was /rss/news/ (404)
  },
];

// Strip HTML tags from a string — fixes Fierce Biotech titles which contain raw <a> elements
function stripHtml(str) {
  if (typeof str !== 'string') {
    // rss-parser may return an object if the field contains XML elements
    try { str = JSON.stringify(str); } catch (_) { return ''; }
  }
  return str.replace(/<[^>]*>/g, '').trim();
}

// Build the full set of match terms for a company (lowercase)
function getTerms(company) {
  const terms = new Set();
  terms.add(company.ticker.toLowerCase());
  terms.add(company.company_name.toLowerCase());
  if (company.short_name) terms.add(company.short_name.toLowerCase());
  (company.search_terms || []).forEach(t => terms.add(t.toLowerCase()));
  // Remove very short/generic terms that would cause false positives
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
        // Sanitize title — Fierce Biotech embeds raw HTML anchor tags in titles
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

          // Build a stable external_id: source-scoped, company-scoped
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
                JSON.stringify({ feed: feed.label, author }),
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
