-- BioFeed Database Schema
-- Run via GET /api/setup after first deploy

CREATE TABLE IF NOT EXISTS companies (
  id              SERIAL PRIMARY KEY,
  ticker          VARCHAR(10) UNIQUE NOT NULL,
  company_name    TEXT NOT NULL,
  short_name      TEXT,
  cik             VARCHAR(20),           -- EDGAR CIK (10-digit, leading zeros ok)
  catalyst_date   DATE,
  catalyst_type   TEXT,
  nda_application TEXT,                  -- e.g. "NDA213062" for openFDA lookup
  nct_numbers     TEXT[] DEFAULT '{}',   -- e.g. {"NCT04390165"} for CT.gov
  search_terms    TEXT[] DEFAULT '{}',   -- extra terms: drug names, aliases
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feed_items (
  id           SERIAL PRIMARY KEY,
  ticker       VARCHAR(10) NOT NULL,
  source       VARCHAR(50) NOT NULL,    -- 'edgar','clinicaltrials','openfda','rss_*','stocktwits'
  external_id  TEXT NOT NULL,           -- unique ID from source for dedup
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  published_at TIMESTAMPTZ,
  item_type    TEXT,                    -- '8-K','trial_status','fda_submission','news'
  raw_data     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id           SERIAL PRIMARY KEY,
  ticker       VARCHAR(10) NOT NULL,
  bull_count   INT DEFAULT 0,
  bear_count   INT DEFAULT 0,
  total_count  INT DEFAULT 0,
  bull_percent NUMERIC(5,2),
  fetched_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id            SERIAL PRIMARY KEY,
  source        VARCHAR(50) NOT NULL,
  ticker        VARCHAR(10),
  items_found   INT DEFAULT 0,
  items_new     INT DEFAULT 0,
  error_message TEXT,
  duration_ms   INT,
  ran_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_feed_ticker     ON feed_items(ticker);
CREATE INDEX IF NOT EXISTS idx_feed_published  ON feed_items(published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_feed_source     ON feed_items(source);
CREATE INDEX IF NOT EXISTS idx_sent_ticker     ON sentiment_snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_sent_fetched    ON sentiment_snapshots(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_ran         ON fetch_log(ran_at DESC);
