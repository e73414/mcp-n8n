-- Run this once against the Postgres instance to create the tables
-- that replace Pocketbase collections.

CREATE TABLE IF NOT EXISTS n8n_data.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email    TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  template_id   TEXT,
  user_timezone TEXT,
  profile       TEXT,
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
  detail_level     TEXT,
  report_detail    TEXT,
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

-- ── Datasets ──────────────────────────────────────────────────────────────────
-- Mirrors the production dataset_record_manager table structure.
CREATE TABLE IF NOT EXISTS n8n_data.dataset_record_manager (
  dataset_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_name         TEXT NOT NULL,
  dataset_summary      TEXT,
  row_count            INTEGER,
  dataset_headers      JSONB,
  dataset_header_types JSONB,
  column_mapping       JSONB,
  column_dictionary    JSONB,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  owner_email          TEXT NOT NULL,
  auth                 INTEGER,
  dataset_desc         TEXT,
  sample_questions     JSONB        -- { questions: [{ id: uuid, question: string }] }
);
-- On existing databases run:
-- ALTER TABLE n8n_data.dataset_record_manager ADD COLUMN IF NOT EXISTS sample_questions JSONB;

-- ── Profile hierarchy ─────────────────────────────────────────────────────────
-- Codes are 3-char mixed-case alphabetic. Reserved: 'adm' (admin), '000' (blank).
-- Full user profile = company_code(3) + bu_code(3) + team_code(3) = 9 chars.
-- Top-level admin profile: 'admadmadm'.

CREATE TABLE IF NOT EXISTS n8n_data.profile_companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  code       CHAR(3) NOT NULL UNIQUE,  -- globally unique; 'adm' and '000' reserved
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS n8n_data.profile_business_units (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  code         CHAR(3) NOT NULL,       -- unique within company
  company_code CHAR(3) NOT NULL REFERENCES n8n_data.profile_companies(code) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_code, code)
);

CREATE TABLE IF NOT EXISTS n8n_data.profile_teams (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  code         CHAR(3) NOT NULL,       -- unique within company+BU
  company_code CHAR(3) NOT NULL,
  bu_code      CHAR(3) NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (company_code, bu_code)
    REFERENCES n8n_data.profile_business_units(company_code, code) ON DELETE CASCADE,
  UNIQUE (company_code, bu_code, code)
);

-- One profile assignment per template (NULL = accessible to all)
CREATE TABLE IF NOT EXISTS n8n_data.template_profiles (
  template_id  TEXT PRIMARY KEY,
  profile_code CHAR(9),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- ── App-wide admin settings ───────────────────────────────────────────────────
-- Key-value store; one row per setting. NULL value = user-controlled (no admin override).
-- Adding new settings never requires a schema change — just insert a new row.
CREATE TABLE IF NOT EXISTS n8n_data.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO n8n_data.app_settings (key, value) VALUES
  ('analyze_model',   NULL),
  ('plan_model',      NULL),
  ('execute_model',   NULL),
  ('chunk_threshold', NULL),
  ('detail_level',    NULL),
  ('report_detail',   NULL)
ON CONFLICT (key) DO NOTHING;

-- ── Saved Questions ───────────────────────────────────────────────────────────
-- Bookmarked prompts shareable via link. audience=NULL/empty means public link.
CREATE TABLE IF NOT EXISTS n8n_data.saved_questions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt       TEXT NOT NULL,
  dataset_id   TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  ai_model     TEXT NOT NULL,
  editable     BOOLEAN NOT NULL DEFAULT true,
  audience     TEXT[],          -- NULL/empty = anyone with link; set = restricted to those emails
  owner_email  TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_questions_owner ON n8n_data.saved_questions (owner_email);

-- ── Admin navigation links ────────────────────────────────────────────────────
-- Run once to add admin pages to the nav menu.
-- Only admin users (profile = 'admadmadm') can access these routes.
INSERT INTO n8n_data.nav_links (name, path, "order", separator_before)
VALUES
  ('Admin: Profiles',  '/admin/profiles',  100, true),
  ('Admin: Users',     '/admin/users',     101, false),
  ('Admin: Templates', '/admin/templates', 102, false),
  ('App Settings',     '/admin/settings',   95, true)
ON CONFLICT DO NOTHING;
