-- Run this once against the Postgres instance to create the tables
-- that replace Pocketbase collections.

CREATE TABLE IF NOT EXISTS n8n_data.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email    TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  template_id   TEXT,
  user_timezone TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS n8n_data.conversation_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email       TEXT NOT NULL,
  prompt           TEXT,
  response         TEXT,
  ai_model         TEXT,
  dataset_id       TEXT,
  dataset_name     TEXT,
  duration_seconds NUMERIC,
  report_plan      TEXT,
  report_id        TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_user_email ON n8n_data.conversation_history (user_email);
CREATE INDEX IF NOT EXISTS idx_conv_created_at  ON n8n_data.conversation_history (created_at DESC);

CREATE TABLE IF NOT EXISTS n8n_data.nav_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  path             TEXT NOT NULL,
  "order"          INTEGER NOT NULL DEFAULT 0,
  color            TEXT,
  separator_before BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS n8n_data.ai_models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  provider    TEXT,
  description TEXT
);
