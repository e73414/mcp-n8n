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
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  provider      TEXT,
  description   TEXT,
  display_order INTEGER NOT NULL DEFAULT 0
);
-- Migration for existing installs:
ALTER TABLE n8n_data.ai_models ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

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
  ('upload_model',    NULL),
  ('report_model',    NULL),
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

-- ── Automated Ingestion Pipeline ─────────────────────────────────────────────

-- Stores the CsvOptimizerPlus transformation config for a dataset
CREATE TABLE IF NOT EXISTS n8n_data.dataset_ingestion_config (
  dataset_id   TEXT PRIMARY KEY,
  config       JSONB NOT NULL,
  source_type  TEXT DEFAULT 'excel',   -- 'excel' | 'csv'
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Per-dataset ingestion schedule and Google Drive source folder
CREATE TABLE IF NOT EXISTS n8n_data.dataset_ingestion_schedule (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id       TEXT NOT NULL UNIQUE,
  owner_email      TEXT NOT NULL,
  folder_id        TEXT NOT NULL,       -- Google Drive folder ID
  location_type    TEXT DEFAULT 'google_drive',
  schedule         TEXT,                -- cron expression, NULL = manual only
  enabled          BOOLEAN DEFAULT true,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,                -- 'success' | 'fail' | 'no_new_file'
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Audit log of every file ingested (or attempted)
CREATE TABLE IF NOT EXISTS n8n_data.dataset_ingestion_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id       TEXT NOT NULL,
  file_name        TEXT,
  file_id          TEXT,                -- Google Drive file ID
  file_location    TEXT,                -- folder ID
  location_type    TEXT DEFAULT 'google_drive',
  ingested_at      TIMESTAMPTZ,
  ingestion_result TEXT,               -- 'success' | 'fail' | 'no_new_file'
  error_message    TEXT,
  rows_inserted    INTEGER,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingestion_files_dataset ON n8n_data.dataset_ingestion_files (dataset_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_files_file_id  ON n8n_data.dataset_ingestion_files (file_id);

-- Per-user Google OAuth tokens (access + refresh)
CREATE TABLE IF NOT EXISTS n8n_data.google_oauth_tokens (
  user_email    TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Per-user Microsoft OAuth tokens for OneDrive access
CREATE TABLE IF NOT EXISTS n8n_data.microsoft_oauth_tokens (
  user_email    TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Email-driven dataset ingestion requests (pending choice + audit log)
CREATE TABLE IF NOT EXISTS n8n_data.email_ingestion_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_email         TEXT NOT NULL,
  message_id           TEXT NOT NULL,           -- original email Message-ID header
  subject              TEXT,
  file_name            TEXT,
  csv_data             TEXT,                    -- base64 clean CSV after excel-to-sql conversion
  candidate_datasets   JSONB,                  -- [{dataset_id, dataset_name, confidence, reason}]
  chosen_dataset_id    TEXT,
  status               TEXT NOT NULL DEFAULT 'pending_choice',
                       -- pending_choice | processing | completed | failed | expired | no_datasets
  result_rows_inserted INTEGER,
  error_message        TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_ingestion_sender
  ON n8n_data.email_ingestion_requests(sender_email, status);
CREATE INDEX IF NOT EXISTS idx_email_ingestion_message_id
  ON n8n_data.email_ingestion_requests(message_id);

-- ── Admin navigation links ────────────────────────────────────────────────────
-- Run once to add admin pages to the nav menu.
-- Only admin users (profile = 'admadmadm') can access these routes.
INSERT INTO n8n_data.nav_links (name, path, "order", separator_before)
VALUES
  ('Ingestion Pipelines', '/ingestion-pipelines', 50, true),
  ('Admin: Profiles',  '/admin/profiles',  100, true),
  ('Admin: Users',     '/admin/users',     101, false),
  ('Admin: Templates', '/admin/templates', 102, false),
  ('App Settings',     '/admin/settings',   95, true)
ON CONFLICT DO NOTHING;
