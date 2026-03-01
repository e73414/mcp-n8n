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
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_name TEXT NOT NULL,
  description  TEXT,
  owner_email  TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

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

-- ── Admin navigation links ────────────────────────────────────────────────────
-- Run once to add admin pages to the nav menu.
-- Only admin users (profile = 'admadmadm') can access these routes.
INSERT INTO n8n_data.nav_links (name, path, "order", separator_before)
VALUES
  ('Admin: Profiles',  '/admin/profiles',  100, true),
  ('Admin: Users',     '/admin/users',     101, false),
  ('Admin: Templates', '/admin/templates', 102, false)
ON CONFLICT DO NOTHING;
