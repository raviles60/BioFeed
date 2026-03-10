/**
 * Web Search News Fetcher — Google News RSS per company
 *
 * Strategy: For each company, build a targeted search query and hit Google News RSS.
 * This gives recent, company-specific news articles rather than filtering a general
 * biotech feed — much better recall for small/micro-cap tickers.
 *
 * No API key required. Uses rss-parser (already a dependency).
 *
 * Query construction:
 *   Primary:  TICKER "Company Short Name"
 *   Fallback: TICKER company_name first word
 *   Plus any drug names from search_terms
 *
 * Rate limiting: 1.5s delay between companies (polite to Google)
 */

const Parser = require('rss-parser');
const { pool } = require('../db');

const RSS_PARSER = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BioFeed/1.0; research aggregator)' },
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildQuery(company) {
  // Start with ticker — most precise anchor
  const parts = [company.ticker];

  // Add short name or first meaningful word of company name
  const nameBase = company.short_name
    || company.company_name
        .replace(/,?\s*(Inc|LLC|Corp|Ltd|Therapeutics|Pharmaceuticals|Sciences|Biosciences|Biotechnology)\.?$/i, '')
        .trim();

  // Quote multi-word names; single words added bare
  if (nameBase.includes(' ')) {
    parts.push(`"${nameBase}"`);
  } else {
    parts.push(nameBase);
  }

  // Add up to 2 drug names from search_terms (skip generic/short terms)
  const drugTerms = (company.search_terms || [])
    .filter(t => t.length >= 5)
    .slice(0, 2);

  for (const term of drugTerms) {
    parts.push(`"${term}"`);
  }

  return parts.join(' ');
}

function buildFeedUrl(query) {
  const encoded = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

async function run(companies) {
  for (const company of companies) {
    const start = Date.now();
    let itemsFound = 0, itemsNew = 0;

    try {
      const query = buildQuery(company);
      const url = buildFeedUrl(query);

      console.log(`[WEBSEARCH] ${company.ticker} → query: ${query}`);

      const feedData = await RSS_PARSER.parseURL(url);
      const items = feedData.items || [];

      for (const item of items) {
        const rawId = item.guid || item.id || item.link || item.title || String(Date.now());
        const externalId = `${company.ticker}::${rawId}`;

        const pubDate = item.pubDate || item.isoDate
          ? new Date(item.pubDate || item.isoDate)
          : new Date();

        // Google News titles are formatted as "Headline - Publication"
        // Split to get clean title + source publication
        const fullTitle = item.title || '(no title)';
        const titleParts = fullTitle.split(' - ');
        const cleanTitle = titleParts.slice(0, -1).join(' - ') || fullTitle;
        const publication = titleParts[titleParts.length - 1] || '';

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
              'websearch',
              externalId,
              cleanTitle,
              summary,
              item.link || null,
              pubDate,
              'news',
              JSON.stringify({ publication, query, full_title: fullTitle }),
            ]
          );
          if (r.rows.length > 0) itemsNew++;
        } catch (_) {}
      }

      await pool.query(
        `INSERT INTO fetch_log (source, ticker, items_found, items_new, duration_ms)
         VALUES ($1,$2,$3,$4,$5)`,
        ['websearch', company.ticker, itemsFound, itemsNew, Date.now() - start]
      );
      console.log(`[WEBSEARCH] ${company.ticker}: ${itemsFound} articles, ${itemsNew} new`);

    } catch (err) {
      await pool.query(
        `INSERT INTO fetch_log (source, ticker, error_message, duration_ms)
         VALUES ($1,$2,$3,$4)`,
        ['websearch', company.ticker, err.message, Date.now() - start]
      );
      console.error(`[WEBSEARCH] ${company.ticker} error:`, err.message);
    }

    // Polite delay between companies
    await delay(1500);
  }
}

module.exports = { run };
