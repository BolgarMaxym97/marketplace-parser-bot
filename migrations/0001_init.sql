-- Search feeds being watched. One row per OLX search URL.
CREATE TABLE sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page_url    TEXT    NOT NULL,           -- URL as entered by the owner
  api_url     TEXT    NOT NULL,           -- resolved /api/v1/offers endpoint
  label       TEXT,                       -- search query, shown in /list and reports
  enabled     INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0, -- 0 = first sweep not done, do not broadcast yet
  last_run_at INTEGER,
  last_error  TEXT,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_sources_api ON sources (api_url);
CREATE INDEX idx_sources_due ON sources (enabled, last_run_at);

-- Ads already broadcast. ad_id is OLX's own unique integer id, so no hashing needed.
CREATE TABLE seen_ads (
  source_id INTEGER NOT NULL,
  ad_id     INTEGER NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (source_id, ad_id)
) WITHOUT ROWID;

CREATE INDEX idx_seen_src_sent ON seen_ads (source_id, sent_at);

-- Broadcast targets. Telegram has no "list my chats" API, so we track them ourselves.
CREATE TABLE chats (
  chat_id    INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL,            -- private | group | supergroup | channel
  title      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  added_at   INTEGER NOT NULL
);

CREATE INDEX idx_chats_enabled ON chats (enabled);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
