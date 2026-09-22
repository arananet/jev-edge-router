-- Decision log. Prompt content is not stored unless LOG_CONTENT=true.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  features TEXT NOT NULL,
  judgments TEXT,
  judge_provider TEXT,
  judge_error TEXT,
  judge_latency_ms INTEGER,
  chosen_tier TEXT NOT NULL,
  served_tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  upstream_latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost_usd REAL,
  estimated_cost_top_usd REAL,
  status INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_created_at ON decisions (created_at);
CREATE INDEX IF NOT EXISTS decisions_served_tier ON decisions (served_tier);
