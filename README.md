# BioFeed — Biotech & Pharma Intelligence Feed

Live news and data aggregator for tracked biotech/pharma companies. Fetches from EDGAR, ClinicalTrials.gov, openFDA, 4 RSS news feeds, and StockTwits sentiment — every 30 minutes.

---

## Deploy to Railway

1. Create a new Railway project
2. Add a **PostgreSQL** plugin to the project
3. Push this repo as a new Railway service
4. In the service **Variables** tab, set:
   ```
   DATABASE_URL = (copy from the Postgres service Variables tab)
   ```
5. Deploy. Once running, open your Railway URL and visit:
   ```
   https://your-app.up.railway.app/api/setup
   ```
   This creates all 4 database tables. Do this once only.

---

## Adding Companies

### Via the UI
Click **+ COMPANY** in the top-right corner of the dashboard.

### Via API (curl)
```bash
curl -X POST https://your-app.up.railway.app/api/companies \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "ALDX",
    "company_name": "Aldeyra Therapeutics, Inc.",
    "short_name": "Aldeyra",
    "cik": "1341235",
    "catalyst_date": "2026-03-16",
    "catalyst_type": "PDUFA Date",
    "nda_application": "NDA213062",
    "nct_numbers": [],
    "search_terms": ["reproxalap", "ADX-2191", "dry eye disease"]
  }'
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `ticker` | ✅ | Stock ticker (uppercase) |
| `company_name` | ✅ | Full legal name |
| `short_name` | — | Common short name (improves RSS matching) |
| `cik` | recommended | EDGAR CIK — enables precise 8-K fetching. Find at [sec.gov/cgi-bin/browse-edgar](https://www.sec.gov/cgi-bin/browse-edgar) |
| `catalyst_date` | recommended | Upcoming event date (YYYY-MM-DD) |
| `catalyst_type` | — | PDUFA Date, Conference, Clinical Trial Result, etc. |
| `nda_application` | — | NDA/BLA number (e.g. "NDA213062") for openFDA precision |
| `nct_numbers` | — | Array of NCT IDs for direct ClinicalTrials.gov lookup |
| `search_terms` | recommended | Extra terms: drug INN names, aliases, disease area |

### Finding the EDGAR CIK
Search at: `https://www.sec.gov/cgi-bin/browse-edgar?company=COMPANY+NAME&CIK=&action=getcompany`  
The CIK is the 7-10 digit number in the URL. Drop leading zeros when entering (the app pads automatically).

---

## Data Sources

| Source | What it provides | Frequency |
|--------|-----------------|-----------|
| **EDGAR** | 8-K filings (material events, trial results, deals, guidance), S-3 shelf offerings (dilution signal) | Every 30 min |
| **ClinicalTrials.gov** | Trial status (recruiting/completed/terminated), phase, sponsor, last update | Every 30 min |
| **openFDA** | NDA/BLA submission history, approval actions, REMS | Every 30 min |
| **BioPharma Dive** | Industry news, FDA coverage, pipeline stories | Every 30 min |
| **Fierce Biotech** | Breaking biotech news | Every 30 min |
| **Endpoints News** | Drug development & regulatory news | Every 30 min |
| **BioSpace** | Biotech/pharma news wire | Every 30 min |
| **StockTwits** | Retail bull/bear sentiment (labeled messages) | Every 30 min, **only within 14 days of catalyst_date** |

### RSS Matching Accuracy
RSS feeds are fetched once per cycle and matched against each tracked company using its `ticker`, `company_name`, `short_name`, and `search_terms`. Estimated accuracy:
- **~90% recall** on major stories (misses only when an article uses an alias you haven't stored)
- **~95% precision** (biotech tickers are unusual strings; drug INNs like "reproxalap" are unique)
- Improve recall by adding drug names and company aliases to `search_terms`

---

## API Endpoints

```
GET  /api/feed/dashboard        All companies + their feed items + latest sentiment
GET  /api/feed/timeline         All items across all companies, newest first
GET  /api/feed/:ticker          Feed items for one ticker
GET  /api/feed/sentiment/:ticker Sentiment history (last 48 snapshots)
GET  /api/feed/log/recent       Last 50 fetch log entries

GET  /api/companies             All active companies with stats
POST /api/companies             Add or update a company
PUT  /api/companies/:ticker     Partial update
DEL  /api/companies/:ticker     Soft-delete (deactivates)

GET  /api/setup                 Initialize DB schema (run once)
POST /api/fetch/run             Manually trigger a fetch cycle
GET  /api/health                Health check
```

---

## Notes

- **EDGAR User-Agent:** The EDGAR API requires a descriptive User-Agent. Currently set to `BioFeed biofeed-app/1.0 research@biofeed.app`. If you hit 403s, update `fetchers/edgar.js`.
- **StockTwits rate limit:** ~200 req/hour unauthenticated. At 10 tickers × 2 fetches/hour = 20 req/hour — well within limits.
- **openFDA 404s:** A 404 from openFDA means no matching NDA/BLA found — not an error. Check the fetch log if data isn't appearing.
- **ClinicalTrials.gov v2 API:** The v2 API launched in 2023. The old v1 is deprecated. This app uses v2.
