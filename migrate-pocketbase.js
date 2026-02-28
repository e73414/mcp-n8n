/**
 * One-off migration: Pocketbase → Postgres
 *
 * Usage:
 *   node migrate-pocketbase.js --dry-run   # preview what would be inserted
 *   node migrate-pocketbase.js             # perform the actual migration
 *
 * Reads Pocketbase credentials from .env (PB_BASE_URL, PB_EMAIL, PB_PASSWORD)
 * Reads Postgres credentials from .env (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD)
 */

const path = require('path');
const fs = require('fs');
// Load parent .env first (provides PB_* and PG_* vars), then local .env
// (provides service-specific overrides). dotenv won't overwrite already-set vars.
const localEnv = path.join(__dirname, '.env');
const parentEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(parentEnv)) require('dotenv').config({ path: parentEnv });
if (fs.existsSync(localEnv))  require('dotenv').config({ path: localEnv });
const axios = require('axios');
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const PB_BASE = (process.env.PB_BASE_URL || '').replace(/\/$/, '');
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;

if (!PB_BASE || !PB_EMAIL || !PB_PASSWORD) {
  console.error('Missing PB_BASE_URL, PB_EMAIL, or PB_PASSWORD in .env');
  process.exit(1);
}

const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'n8n',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// ── Pocketbase helpers ────────────────────────────────────────────────────────

async function pbAdminAuth() {
  // Try v0.22+ superusers endpoint first, fall back to legacy admins endpoint
  const endpoints = [
    `${PB_BASE}/api/collections/_superusers/auth-with-password`,
    `${PB_BASE}/api/superusers/auth-with-password`,
    `${PB_BASE}/api/admins/auth-with-password`,
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await axios.post(url, { identity: PB_EMAIL, password: PB_PASSWORD });
      return res.data.token;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function pbFetchAll(token, collection) {
  const records = [];
  let page = 1;
  while (true) {
    let res;
    try {
      res = await axios.get(`${PB_BASE}/api/collections/${collection}/records`, {
        params: { page, perPage: 500, sort: '+created' },
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const body = err.response?.data;
      console.error(`  ✗ Failed fetching ${collection} page ${page}:`, JSON.stringify(body));
      throw err;
    }
    const { items, totalPages } = res.data;
    records.push(...items);
    if (page >= totalPages) break;
    page++;
  }
  return records;
}

// ── Migration functions ───────────────────────────────────────────────────────

async function migrateNavLinks(token, client) {
  const records = await pbFetchAll(token, 'nav_links');
  console.log(`\nnav_links: ${records.length} records`);
  for (const r of records) {
    const row = {
      name: r.name,
      path: r.path,
      order: r.order ?? 0,
      color: r.color || null,
      separator_before: r.separator_before ?? false,
    };
    if (DRY_RUN) {
      console.log('  [dry-run] INSERT nav_links:', JSON.stringify(row));
    } else {
      await client.query(
        `INSERT INTO n8n_data.nav_links (name, path, "order", color, separator_before)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [row.name, row.path, row.order, row.color, row.separator_before]
      );
    }
  }
  if (!DRY_RUN) console.log(`  ✓ Inserted ${records.length} nav_links`);
}

async function migrateAiModels(token, client) {
  const records = await pbFetchAll(token, 'ai_models_v2');
  console.log(`\nai_models_v2: ${records.length} records`);
  for (const r of records) {
    const row = {
      model_id: r.model_id,
      name: r.name,
      provider: r.provider || null,
      description: r.description || null,
    };
    if (DRY_RUN) {
      console.log('  [dry-run] INSERT ai_models:', JSON.stringify(row));
    } else {
      await client.query(
        `INSERT INTO n8n_data.ai_models (model_id, name, provider, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [row.model_id, row.name, row.provider, row.description]
      );
    }
  }
  if (!DRY_RUN) console.log(`  ✓ Inserted ${records.length} ai_models`);
}

async function migrateUsers(token, client) {
  const records = await pbFetchAll(token, 'data_analyzer_user_profile');
  console.log(`\ndata_analyzer_user_profile: ${records.length} records`);
  for (const r of records) {
    const row = {
      user_email: r.user_email,
      password_hash: r.password_hash || null,
      template_id: r.template_id || null,
      user_timezone: r.user_timezone || null,
      created_at: r.created_at || r.created || new Date().toISOString(),
    };
    if (DRY_RUN) {
      console.log('  [dry-run] INSERT users:', JSON.stringify({ ...row, password_hash: row.password_hash ? '[REDACTED]' : null }));
    } else {
      await client.query(
        `INSERT INTO n8n_data.users (user_email, password_hash, template_id, user_timezone, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_email) DO UPDATE SET
           password_hash  = EXCLUDED.password_hash,
           template_id    = EXCLUDED.template_id,
           user_timezone  = EXCLUDED.user_timezone`,
        [row.user_email, row.password_hash, row.template_id, row.user_timezone, row.created_at]
      );
    }
  }
  if (!DRY_RUN) console.log(`  ✓ Inserted/updated ${records.length} users`);
}

async function migrateConversations(token, client) {
  const records = await pbFetchAll(token, 'conversation_history');
  console.log(`\nconversation_history: ${records.length} records`);
  let inserted = 0;
  for (const r of records) {
    const row = {
      user_email: r.user_email,
      prompt: r.prompt || '',
      response: r.response || '',
      ai_model: r.ai_model || '',
      dataset_id: r.dataset_id || '',
      dataset_name: r.dataset_name || '',
      duration_seconds: r.duration_seconds ?? null,
      report_plan: r.report_plan || null,
      report_id: r.report_id || null,
      created_at: r.created_at || r.created || new Date().toISOString(),
    };
    if (DRY_RUN) {
      if (inserted === 0) console.log('  [dry-run] First record sample:', JSON.stringify({
        ...row,
        prompt: row.prompt.substring(0, 60) + '...',
        response: row.response.substring(0, 60) + '...',
      }));
    } else {
      await client.query(
        `INSERT INTO n8n_data.conversation_history
           (user_email, prompt, response, ai_model, dataset_id, dataset_name,
            duration_seconds, report_plan, report_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.user_email, row.prompt, row.response, row.ai_model,
         row.dataset_id, row.dataset_name, row.duration_seconds,
         row.report_plan, row.report_id, row.created_at]
      );
    }
    inserted++;
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] Would insert ${records.length} conversation_history records`);
  } else {
    console.log(`  ✓ Inserted ${inserted} conversation_history records`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN — no data will be written ===' : '=== LIVE MIGRATION ===');

  let pbToken;
  try {
    pbToken = await pbAdminAuth();
    console.log('✓ Authenticated with Pocketbase');
  } catch (err) {
    console.error('✗ Failed to authenticate with Pocketbase:', err.message);
    process.exit(1);
  }

  const client = DRY_RUN ? null : await pgPool.connect();
  try {
    await migrateNavLinks(pbToken, client);
    await migrateAiModels(pbToken, client);
    await migrateUsers(pbToken, client);
    await migrateConversations(pbToken, client);
    console.log('\n=== Migration complete ===');
  } catch (err) {
    console.error('\n✗ Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pgPool.end();
  }
}

main();
