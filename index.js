require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const cron = require('node-cron');
const JSZip = require('jszip');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // Increased limit for large CSV files

const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  console.error('FATAL: API_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}
app.use((req, res, next) => {
  if (req.path === '/google/callback') return next(); // OAuth redirect — no API secret
  if (req.headers['x-api-secret'] === API_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

const PORT = process.env.PORT || 3000;
const N8N_BASE = process.env.N8N_BASE_URL || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/google/callback';
const EXCEL_TO_SQL_URL = (process.env.EXCEL_TO_SQL_URL || 'http://excel-to-sql:8000').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

if (!N8N_BASE) console.warn('N8N_BASE_URL not set; outgoing calls will fail.');
if (!N8N_API_KEY) console.warn('N8N_API_KEY not set; some n8n endpoints may reject requests.');
if (!GOOGLE_CLIENT_ID) console.warn('GOOGLE_CLIENT_ID not set; Google Drive ingestion will not work.');

const pgPool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'n8n',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// ── Authorization helpers ─────────────────────────────────────────────────────

async function getUserAuth(client, email) {
  const r = await client.query(
    'SELECT id, profile, profiles FROM n8n_data.users WHERE user_email=$1', [email]
  );
  if (r.rowCount === 0) return null;
  const { id, profile, profiles } = r.rows[0];
  return {
    id,
    profile: profile ?? null,
    profilesArray: Array.isArray(profiles) ? profiles.filter(p => p && p.trim().length === 9) : [],
  };
}

async function isAdmin(email, client) {
  const r = await client.query('SELECT profile FROM n8n_data.users WHERE user_email=$1', [email]);
  return r.rows[0]?.profile?.trim() === 'admadmadm';
}

async function canAccessDataset(client, email, datasetId) {
  const auth = await getUserAuth(client, email);
  if (!auth) return false;
  const { profile, profilesArray } = auth;
  if (profile?.trim() === 'admadmadm') return true;
  const r = await client.query(`
    SELECT 1 FROM n8n_data.dataset_record_manager d
    LEFT JOIN n8n_data.template_profiles tp ON tp.template_id = d.dataset_id::text
    WHERE d.dataset_id = $1 AND (
      (tp.profile_code IS NULL AND d.owner_email = $2)
      OR (
        tp.profile_code IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest($3::text[]) AS up(user_profile)
          WHERE
            TRIM(SUBSTRING(tp.profile_code::text, 1, 3)) = TRIM(SUBSTRING(up.user_profile, 1, 3))
            AND (TRIM(SUBSTRING(tp.profile_code::text, 4, 3)) = '000'
                 OR TRIM(SUBSTRING(tp.profile_code::text, 4, 3)) = TRIM(SUBSTRING(up.user_profile, 4, 3)))
            AND (TRIM(SUBSTRING(tp.profile_code::text, 7, 3)) = '000'
                 OR TRIM(SUBSTRING(tp.profile_code::text, 7, 3)) = TRIM(SUBSTRING(up.user_profile, 7, 3)))
        )
      )
    )
  `, [datasetId, email, profilesArray]);
  return r.rowCount > 0;
}

app.get('/mcp/skills', (req, res) => {
  res.json([
    {
      id: 'n8n-webhook',
      name: 'n8n Webhook Skill',
      description: 'Trigger an n8n workflow by calling its webhook path or workflowId',
      params: [
        { name: 'webhookPath', type: 'string', description: 'Path part of your n8n webhook (eg: webhooks/webhook-id)' },
        { name: 'workflowId', type: 'string', description: 'Workflow webhookId (alternative to webhookPath)'}
      ]
    },
    {
      id: 'n8n-code-javascript',
      name: 'n8n Code (JavaScript)',
      description: 'Run a JavaScript code workflow in n8n via webhook',
      params: [
        { name: 'webhookPath', type: 'string' },
        { name: 'workflowId', type: 'string' }
      ]
    },
    {
      id: 'n8n-code-python',
      name: 'n8n Code (Python)',
      description: 'Run a Python code workflow in n8n via webhook',
      params: [
        { name: 'webhookPath', type: 'string' },
        { name: 'workflowId', type: 'string' }
      ]
    },
    {
      id: 'n8n-guardrails',
      name: 'n8n Guardrails',
      description: 'Run Guardrails-style validation workflow in n8n via webhook',
      params: [
        { name: 'webhookPath', type: 'string' },
        { name: 'workflowId', type: 'string' }
      ]
    },
    {
      id: 'n8n-expression-syntax',
      name: 'n8n Expression Syntax',
      description: 'Run or validate expression-syntax workflows in n8n via webhook',
      params: [ { name: 'webhookPath', type: 'string' }, { name: 'workflowId', type: 'string' } ]
    },
    {
      id: 'n8n-mcp-tools-expert',
      name: 'n8n MCP Tools (Expert)',
      description: 'Advanced MCP tools for n8n via webhook',
      params: [ { name: 'webhookPath', type: 'string' }, { name: 'workflowId', type: 'string' } ]
    },
    {
      id: 'n8n-node-configuration',
      name: 'n8n Node Configuration',
      description: 'Configure or run node-configuration workflows via webhook',
      params: [ { name: 'webhookPath', type: 'string' }, { name: 'workflowId', type: 'string' } ]
    },
    {
      id: 'n8n-validation-expert',
      name: 'n8n Validation (Expert)',
      description: 'Run validation and QA workflows via webhook',
      params: [ { name: 'webhookPath', type: 'string' }, { name: 'workflowId', type: 'string' } ]
    },
    {
      id: 'n8n-workflow-patterns',
      name: 'n8n Workflow Patterns',
      description: 'Pattern-based workflow runs via webhook',
      params: [ { name: 'webhookPath', type: 'string' }, { name: 'workflowId', type: 'string' } ]
    }
  ]);
});

app.post('/mcp/execute', async (req, res) => {
  const { skill, params = {}, input = {} } = req.body;

  const supported = [
    'n8n-webhook','n8n-code-javascript','n8n-code-python','n8n-guardrails',
    'n8n-expression-syntax','n8n-mcp-tools-expert','n8n-node-configuration','n8n-validation-expert','n8n-workflow-patterns'
  ];
  if (!supported.includes(skill)) return res.status(400).json({ error: 'unknown skill' });

  // Accept either a direct webhookPath (relative) or a workflowId (webhookId)
  let webhookPath = params.webhookPath || null;
  if (!webhookPath && params.workflowId) {
    webhookPath = `webhook/${params.workflowId}`;
  }
  if (!webhookPath) return res.status(400).json({ error: 'missing params.webhookPath or params.workflowId' });

  const base = N8N_BASE.replace(/\/$/, '');
  const path = webhookPath.replace(/^\//, '');
  const url = `${base}/${path}`;

  try {
    const resp = await axios.post(url, input, {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 300000,  // 5 minutes for AI processing
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    res.json({ status: 'ok', code: resp.status, data: resp.data });
  } catch (err) {
    const message = err.message || 'request_failed';
    const details = err.response ? { status: err.response.status, data: err.response.data } : null;
    res.status(500).json({ error: message, details });
  }
});

// ── Code generation helpers ───────────────────────────────────────────────────

const RESERVED_CODES = ['adm', '000'];
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomCode() {
  let c = '';
  for (let i = 0; i < 3; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return c;
}

async function uniqueCode(client, table, extraWhere = '', extraVals = []) {
  for (let i = 0; i < 50; i++) {
    const code = randomCode();
    if (RESERVED_CODES.includes(code)) continue;
    const q = `SELECT 1 FROM ${table} WHERE code=$1${extraWhere ? ' AND ' + extraWhere : ''} LIMIT 1`;
    const r = await client.query(q, [code, ...extraVals]);
    if (r.rows.length === 0) return code;
  }
  throw new Error('Could not generate unique code after 50 attempts');
}

// Returns datasets accessible to a specific user based on profile/email rules.
// Rules: admin (admadmadm) sees all; no profile_code = owner only; profile_code = hierarchical match.
// Profile is looked up server-side — client-supplied profile params are ignored.
app.get('/datasets', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const auth = await getUserAuth(client, email);
    if (!auth) return res.status(403).json({ error: 'User not found' });
    const { profile, profilesArray } = auth;
    const result = await client.query(`
      SELECT DISTINCT ON (d.dataset_id) d.*, tp.profile_code
      FROM n8n_data.dataset_record_manager d
      LEFT JOIN n8n_data.template_profiles tp ON tp.template_id = d.dataset_id::text
      WHERE
        $1 = 'admadmadm'
        OR
        (tp.profile_code IS NULL AND d.owner_email = $2)
        OR
        (
          tp.profile_code IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest($3::text[]) AS up(user_profile)
            WHERE
              TRIM(SUBSTRING(tp.profile_code::text, 1, 3)) = TRIM(SUBSTRING(up.user_profile, 1, 3))
              AND (TRIM(SUBSTRING(tp.profile_code::text, 4, 3)) = '000'
                   OR TRIM(SUBSTRING(tp.profile_code::text, 4, 3)) = TRIM(SUBSTRING(up.user_profile, 4, 3)))
              AND (TRIM(SUBSTRING(tp.profile_code::text, 7, 3)) = '000'
                   OR TRIM(SUBSTRING(tp.profile_code::text, 7, 3)) = TRIM(SUBSTRING(up.user_profile, 7, 3)))
          )
        )
      ORDER BY d.dataset_id
    `, [profile ?? null, email, profilesArray]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /datasets error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Used by the admin Dataset Access Manager — must be before /:datasetId to avoid route shadowing.
app.get('/datasets/all', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query(`SELECT * FROM n8n_data.dataset_record_manager`);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /datasets/all error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Returns a single dataset row including sample_questions.
app.get('/datasets/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `SELECT dataset_id, dataset_name, sample_questions
       FROM n8n_data.dataset_record_manager
       WHERE dataset_id = $1`,
      [datasetId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Dataset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /datasets/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Returns all datasets from the dataset_record_manager table (all owners).
// Update dataset owner_email — admin use.
app.patch('/datasets/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const { owner_email } = req.body;
  if (!owner_email || typeof owner_email !== 'string') {
    return res.status(400).json({ error: 'owner_email required' });
  }
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `UPDATE n8n_data.dataset_record_manager SET owner_email = $1, updated_at = now() WHERE dataset_id = $2 RETURNING dataset_id, owner_email`,
      [owner_email.trim(), datasetId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Dataset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /datasets/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Update sample_questions JSONB for a dataset.
app.patch('/datasets/:datasetId/sample-questions', async (req, res) => {
  const { datasetId } = req.params;
  const { sample_questions } = req.body;
  if (!sample_questions || typeof sample_questions !== 'object') {
    return res.status(400).json({ error: 'sample_questions object required' });
  }
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `UPDATE n8n_data.dataset_record_manager
       SET sample_questions = $1, updated_at = now()
       WHERE dataset_id = $2
       RETURNING dataset_id`,
      [JSON.stringify(sample_questions), datasetId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('PATCH /datasets/:id/sample-questions error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/dataset-view/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Validate to prevent SQL injection — dataset IDs are alphanumeric + hyphens only
  if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) {
    return res.status(400).json({ error: 'Invalid dataset ID' });
  }

  const viewName = `v_ds_${datasetId.replace(/-/g, '_')}`;
  const client = await pgPool.connect();
  try {
    if (!(await canAccessDataset(client, email, datasetId)))
      return res.status(403).json({ error: 'Forbidden' });
    const result = await client.query(`SELECT * FROM n8n_data."${viewName}" LIMIT 100000`);
    const columns = result.fields.map(f => f.name);
    const rows = result.rows;
    res.json({ columns, rows });
  } catch (err) {
    console.error('dataset-view query error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/datasets/:datasetId/download-csv', async (req, res) => {
  const { datasetId } = req.params;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) return res.status(400).json({ error: 'Invalid dataset ID' });

  const viewName = `v_ds_${datasetId.replace(/-/g, '_')}`;
  const client = await pgPool.connect();
  try {
    if (!(await canAccessDataset(client, email, datasetId)))
      return res.status(403).json({ error: 'Forbidden' });
    const metaResult = await client.query(
      `SELECT column_mapping, dataset_name FROM n8n_data.dataset_record_manager WHERE dataset_id=$1`,
      [datasetId]
    );
    if (metaResult.rowCount === 0) return res.status(404).json({ error: 'Dataset not found' });

    const { column_mapping, dataset_name } = metaResult.rows[0];
    const dbToOriginal = {};
    if (column_mapping) {
      const mapping = typeof column_mapping === 'string' ? JSON.parse(column_mapping) : column_mapping;
      Object.entries(mapping).forEach(([orig, db]) => { dbToOriginal[db] = orig; });
    }

    const result = await client.query(`SELECT * FROM n8n_data."${viewName}"`);
    const dbColumns = result.fields.map(f => f.name);
    const headers = dbColumns.map(col => dbToOriginal[col] || col);

    const escape = (val) => {
      const str = (val === null || val === undefined) ? '' : String(val);
      return (str.includes(',') || str.includes('"') || str.includes('\n'))
        ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const csvRows = [
      headers.map(escape).join(','),
      ...result.rows.map(row => dbColumns.map(col => escape(row[col])).join(','))
    ];

    const filename = (dataset_name || datasetId).replace(/[^a-zA-Z0-9_\- ]/g, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('GET /datasets/:id/download-csv error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Users ────────────────────────────────────────────────────────────────────

app.get('/users', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM n8n_data.users WHERE user_email = $1 LIMIT 1', [email]
    );
    const row = result.rows[0];
    if (!row) return res.json(null);
    res.json({ ...row, profiles: row.profiles || [] });
  } catch (err) {
    console.error('GET /users error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { password_hash, template_id, profile, user_timezone, profiles, user_email, actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    const actor = await getUserAuth(client, actor_email);
    if (!actor) return res.status(403).json({ error: 'Unauthorized' });
    const actorIsAdmin = actor.profile?.trim() === 'admadmadm';
    // Non-admin can only modify their own record and may not touch profile/profiles/user_email
    if (!actorIsAdmin) {
      if (actor.id !== id) return res.status(403).json({ error: 'Forbidden' });
      if (profile !== undefined || profiles !== undefined || user_email !== undefined)
        return res.status(403).json({ error: 'Admin only: cannot change profile or email' });
    }
    const fields = [], values = [];
    if (user_email     !== undefined) { fields.push(`user_email = $${fields.length + 1}`);      values.push(user_email); }
    if (password_hash  !== undefined) { fields.push(`password_hash = $${fields.length + 1}`);  values.push(password_hash); }
    if (template_id    !== undefined) { fields.push(`template_id = $${fields.length + 1}`);     values.push(template_id); }
    if (profile        !== undefined) { fields.push(`profile = $${fields.length + 1}`);         values.push(profile); }
    if (user_timezone  !== undefined) { fields.push(`user_timezone = $${fields.length + 1}`);   values.push(user_timezone); }
    if (profiles       !== undefined) { fields.push(`profiles = $${fields.length + 1}`);        values.push(Array.isArray(profiles) ? profiles : []); }
    if (fields.length === 0) return res.status(400).json({ error: 'nothing to update' });
    values.push(id);
    const result = await client.query(
      `UPDATE n8n_data.users SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /users/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Conversations ─────────────────────────────────────────────────────────────

app.get('/conversations', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM n8n_data.conversation_history WHERE user_email = $1 ORDER BY created_at DESC LIMIT 500',
      [email]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /conversations error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/conversations', async (req, res) => {
  const { user_email, prompt, response, ai_model, dataset_id, dataset_name,
          duration_seconds, report_plan, report_id, detail_level, report_detail, created_at } = req.body;
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `INSERT INTO n8n_data.conversation_history
         (user_email, prompt, response, ai_model, dataset_id, dataset_name,
          duration_seconds, report_plan, report_id, detail_level, report_detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [user_email, prompt, response, ai_model, dataset_id, dataset_name,
       duration_seconds ?? null, report_plan ?? null, report_id ?? null,
       detail_level ?? null, report_detail ?? null,
       created_at || new Date().toISOString()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /conversations error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/conversations/:id', async (req, res) => {
  const { id } = req.params;
  const { prompt, response } = req.body;
  const fields = [], values = [];
  if (prompt   !== undefined) { fields.push(`prompt = $${fields.length + 1}`);   values.push(prompt); }
  if (response !== undefined) { fields.push(`response = $${fields.length + 1}`); values.push(response); }
  if (fields.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(id);
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `UPDATE n8n_data.conversation_history SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /conversations/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/conversations/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pgPool.connect();
  try {
    await client.query('DELETE FROM n8n_data.conversation_history WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /conversations/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Nav links & AI models ─────────────────────────────────────────────────────

app.get('/nav-links', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.nav_links ORDER BY "order" ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /nav-links error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/nav-links', async (req, res) => {
  const { name, path, order, color, separator_before, actor_email } = req.body;
  if (!name || !path) return res.status(400).json({ error: 'name and path required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      `INSERT INTO n8n_data.nav_links (name, path, "order", color, separator_before)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, path, order ?? 0, color ?? null, separator_before ?? false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /nav-links error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/nav-links/:id', async (req, res) => {
  const { id } = req.params;
  const { name, path, order, color, separator_before, actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      `UPDATE n8n_data.nav_links
       SET name=COALESCE($1,name), path=COALESCE($2,path), "order"=COALESCE($3,"order"),
           color=$4, separator_before=COALESCE($5,separator_before)
       WHERE id=$6 RETURNING *`,
      [name ?? null, path ?? null, order ?? null, color ?? null, separator_before ?? null, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /nav-links/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/nav-links/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.nav_links WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /nav-links/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/ai-models', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.ai_models ORDER BY display_order ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /ai-models error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/ai-models', async (req, res) => {
  const { model_id, name, provider, description, display_order, actor_email } = req.body;
  if (!model_id || !name) return res.status(400).json({ error: 'model_id and name required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      `INSERT INTO n8n_data.ai_models (model_id, name, provider, description, display_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [model_id, name, provider ?? null, description ?? null, display_order ?? 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /ai-models error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/ai-models/:id', async (req, res) => {
  const { id } = req.params;
  const { model_id, name, provider, description, display_order, actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      `UPDATE n8n_data.ai_models
       SET model_id=COALESCE($1,model_id), name=COALESCE($2,name),
           provider=$3, description=$4, display_order=COALESCE($5,display_order)
       WHERE id=$6 RETURNING *`,
      [model_id ?? null, name ?? null, provider ?? null, description ?? null, display_order ?? null, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /ai-models/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/ai-models/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.ai_models WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /ai-models/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Companies ──────────────────────────────────────────────────────────

app.get('/admin/companies', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.profile_companies ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /admin/companies error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/admin/companies', async (req, res) => {
  const { name, actor_email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const code = await uniqueCode(client, 'n8n_data.profile_companies');
    const result = await client.query(
      'INSERT INTO n8n_data.profile_companies (name, code) VALUES ($1, $2) RETURNING *',
      [name, code]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /admin/companies error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/admin/companies/:id', async (req, res) => {
  const { id } = req.params;
  const { name, actor_email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      'UPDATE n8n_data.profile_companies SET name=$1 WHERE id=$2 RETURNING *',
      [name, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /admin/companies/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/admin/companies/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.profile_companies WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/companies/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Business Units ─────────────────────────────────────────────────────

app.get('/admin/business-units', async (req, res) => {
  const { company_code } = req.query;
  if (!company_code) return res.status(400).json({ error: 'company_code required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM n8n_data.profile_business_units WHERE company_code=$1 ORDER BY name ASC',
      [company_code]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /admin/business-units error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/admin/business-units', async (req, res) => {
  const { name, company_code, actor_email } = req.body;
  if (!name || !company_code) return res.status(400).json({ error: 'name and company_code required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const code = await uniqueCode(client, 'n8n_data.profile_business_units', 'company_code=$2', [company_code]);
    const result = await client.query(
      'INSERT INTO n8n_data.profile_business_units (name, code, company_code) VALUES ($1, $2, $3) RETURNING *',
      [name, code, company_code]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /admin/business-units error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/admin/business-units/:id', async (req, res) => {
  const { id } = req.params;
  const { name, actor_email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      'UPDATE n8n_data.profile_business_units SET name=$1 WHERE id=$2 RETURNING *',
      [name, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /admin/business-units/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/admin/business-units/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.profile_business_units WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/business-units/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Teams ──────────────────────────────────────────────────────────────

app.get('/admin/teams', async (req, res) => {
  const { company_code, bu_code } = req.query;
  if (!company_code || !bu_code) return res.status(400).json({ error: 'company_code and bu_code required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM n8n_data.profile_teams WHERE company_code=$1 AND bu_code=$2 ORDER BY name ASC',
      [company_code, bu_code]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /admin/teams error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/admin/teams', async (req, res) => {
  const { name, company_code, bu_code, actor_email } = req.body;
  if (!name || !company_code || !bu_code) return res.status(400).json({ error: 'name, company_code and bu_code required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const code = await uniqueCode(client, 'n8n_data.profile_teams', 'company_code=$2 AND bu_code=$3', [company_code, bu_code]);
    const result = await client.query(
      'INSERT INTO n8n_data.profile_teams (name, code, company_code, bu_code) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, code, company_code, bu_code]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /admin/teams error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/admin/teams/:id', async (req, res) => {
  const { id } = req.params;
  const { name, actor_email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      'UPDATE n8n_data.profile_teams SET name=$1 WHERE id=$2 RETURNING *',
      [name, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /admin/teams/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/admin/teams/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.profile_teams WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/teams/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Users ──────────────────────────────────────────────────────────────

app.get('/admin/users', async (req, res) => {
  const { actor_email } = req.query;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query('SELECT * FROM n8n_data.users ORDER BY user_email ASC');
    res.json(result.rows.map(r => ({ ...r, profiles: r.profiles || [] })));
  } catch (err) {
    console.error('GET /admin/users error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/admin/users', async (req, res) => {
  const { user_email, password_hash, profile, user_timezone, template_id, profiles, actor_email } = req.body;
  if (!user_email) return res.status(400).json({ error: 'user_email required' });
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    const result = await client.query(
      `INSERT INTO n8n_data.users (user_email, password_hash, profile, user_timezone, template_id, profiles)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_email, password_hash ?? null, profile ?? null, user_timezone ?? null, template_id ?? null, profiles ?? []]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /admin/users error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/admin/users/:id', async (req, res) => {
  const { id } = req.params;
  const { actor_email } = req.body;
  if (!actor_email) return res.status(400).json({ error: 'actor_email required' });
  const client = await pgPool.connect();
  try {
    if (!(await isAdmin(actor_email, client))) return res.status(403).json({ error: 'Admin only' });
    await client.query('DELETE FROM n8n_data.users WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/users/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Template Profiles ──────────────────────────────────────────────────

app.get('/admin/template-profiles', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.template_profiles');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /admin/template-profiles error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/admin/template-profiles/:template_id', async (req, res) => {
  const { template_id } = req.params;
  const { profile_code } = req.body;
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `INSERT INTO n8n_data.template_profiles (template_id, profile_code, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (template_id) DO UPDATE SET profile_code=EXCLUDED.profile_code, updated_at=now()
       RETURNING *`,
      [template_id, profile_code ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /admin/template-profiles/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── App Settings ──────────────────────────────────────────────────────────────
app.get('/app-settings', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT key, value FROM n8n_data.app_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error('GET /app-settings error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/app-settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  const client = await pgPool.connect();
  try {
    await client.query(
      `INSERT INTO n8n_data.app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value || null]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('PUT /app-settings/:key error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Saved Questions ───────────────────────────────────────────────────────────

app.post('/saved-questions', async (req, res) => {
  const { prompt, dataset_id, dataset_name, ai_model, editable, audience, owner_email } = req.body;
  if (!prompt || !dataset_id || !dataset_name || !ai_model || !owner_email)
    return res.status(400).json({ error: 'prompt, dataset_id, dataset_name, ai_model, owner_email required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `INSERT INTO n8n_data.saved_questions
         (prompt, dataset_id, dataset_name, ai_model, editable, audience, owner_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [prompt, dataset_id, dataset_name, ai_model, editable ?? true, audience ?? [], owner_email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /saved-questions error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/saved-questions/browse', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const userResult = await client.query(
      'SELECT profile FROM n8n_data.users WHERE user_email=$1', [email]
    );
    const userProfile = userResult.rows[0]?.profile?.trim();
    const isAdmin = userProfile === 'admadmadm';
    const result = isAdmin
      ? await client.query(`
          SELECT sq.*, u.profile as owner_profile
          FROM n8n_data.saved_questions sq
          LEFT JOIN n8n_data.users u ON u.user_email = sq.owner_email
          ORDER BY sq.owner_email, sq.created_at DESC`)
      : await client.query(`
          SELECT sq.*, u.profile as owner_profile
          FROM n8n_data.saved_questions sq
          LEFT JOIN n8n_data.users u ON u.user_email = sq.owner_email
          WHERE cardinality(sq.audience) = 0 OR $1 = ANY(sq.audience)
          ORDER BY sq.owner_email, sq.created_at DESC`, [email]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /saved-questions/browse error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/saved-questions', async (req, res) => {
  const { email, all } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const q = all === 'true'
      ? 'SELECT * FROM n8n_data.saved_questions ORDER BY created_at DESC'
      : 'SELECT * FROM n8n_data.saved_questions WHERE owner_email=$1 ORDER BY created_at DESC';
    const result = await client.query(q, all === 'true' ? [] : [email]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /saved-questions error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/saved-questions/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.saved_questions WHERE id=$1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /saved-questions/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/saved-questions/:id', async (req, res) => {
  const { id } = req.params;
  const { prompt, editable, audience } = req.body;
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `UPDATE n8n_data.saved_questions
       SET prompt=COALESCE($1,prompt), editable=COALESCE($2,editable),
           audience=COALESCE($3,audience), updated_at=now()
       WHERE id=$4 RETURNING *`,
      [prompt ?? null, editable ?? null, audience ?? null, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /saved-questions/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/saved-questions/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pgPool.connect();
  try {
    await client.query('DELETE FROM n8n_data.saved_questions WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /saved-questions/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// User email search (for audience picker)
app.get('/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q || String(q).length < 2) return res.json([]);
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `SELECT user_email FROM n8n_data.users WHERE user_email ILIKE $1 LIMIT 10`,
      [`%${q}%`]
    );
    res.json(result.rows.map(r => r.user_email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Ingestion Pipeline ────────────────────────────────────────────────────────

const activeJobs = new Map(); // keyed by dataset_id

function createOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function getValidAccessToken(email, client) {
  const r = await client.query(
    'SELECT access_token, refresh_token, token_expiry FROM n8n_data.google_oauth_tokens WHERE user_email=$1',
    [email]
  );
  if (r.rowCount === 0) throw new Error('Google Drive not connected for this user');
  const { access_token, refresh_token, token_expiry } = r.rows[0];
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token, refresh_token });
  // Refresh if expired or expiring within 5 minutes
  if (!token_expiry || new Date(token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await client.query(
      `UPDATE n8n_data.google_oauth_tokens
       SET access_token=$1, token_expiry=$2, updated_at=now()
       WHERE user_email=$3`,
      [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, email]
    );
    oauth2Client.setCredentials(credentials);
  }
  return oauth2Client;
}

async function runIngestion(datasetId, triggeredBy = 'schedule') {
  const client = await pgPool.connect();
  let ownerEmail = null;
  let latestFileName = null;
  let latestFileId = null;
  try {
    // 1. Load schedule
    const schedR = await client.query(
      'SELECT * FROM n8n_data.dataset_ingestion_schedule WHERE dataset_id=$1', [datasetId]
    );
    if (schedR.rowCount === 0) throw new Error('No ingestion schedule found');
    const sched = schedR.rows[0];
    ownerEmail = sched.owner_email;

    // 2. Load ingestion config
    const cfgR = await client.query(
      'SELECT * FROM n8n_data.dataset_ingestion_config WHERE dataset_id=$1', [datasetId]
    );
    if (cfgR.rowCount === 0) throw new Error('No ingestion config found. Save config from CSV Optimizer PLUS first.');
    const config = cfgR.rows[0].config;

    // 3. Get OAuth client
    const oauth2Client = await getValidAccessToken(ownerEmail, client);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // 4. List files in folder sorted by createdTime desc
    const listResp = await drive.files.list({
      q: `'${sched.folder_id}' in parents and trashed=false`,
      orderBy: 'createdTime desc',
      pageSize: 10,
      fields: 'files(id,name,createdTime,mimeType)',
    });
    const files = listResp.data.files || [];
    if (files.length === 0) {
      await client.query(
        `UPDATE n8n_data.dataset_ingestion_schedule SET last_run_at=now(), last_run_status='no_new_file' WHERE dataset_id=$1`,
        [datasetId]
      );
      return { status: 'no_new_file' };
    }

    // 5. Most recent file
    const latestFile = files[0];
    latestFileName = latestFile.name;
    latestFileId = latestFile.id;

    // 6. Skip if already successfully ingested
    const existR = await client.query(
      `SELECT 1 FROM n8n_data.dataset_ingestion_files
       WHERE dataset_id=$1 AND file_id=$2 AND ingestion_result='success'`,
      [datasetId, latestFile.id]
    );
    if (existR.rowCount > 0) {
      await client.query(
        `UPDATE n8n_data.dataset_ingestion_schedule SET last_run_at=now(), last_run_status='no_new_file' WHERE dataset_id=$1`,
        [datasetId]
      );
      return { status: 'no_new_file', message: 'Most recent file already ingested' };
    }

    // 7. Download file from Drive
    const dlResp = await drive.files.get(
      { fileId: latestFile.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const fileBuffer = Buffer.from(dlResp.data);

    // 8. Call excel-to-sql service with config
    const sheets = config.sheets || [{ name: '0' }];
    const firstSheet = sheets[0];
    const params = new URLSearchParams();
    params.set('sheet', firstSheet.name || '0');
    if (config.no_unpivot) params.set('no_unpivot', 'true');
    if (config.keep_dupes) params.set('keep_dupes', 'true');
    if (firstSheet.header_row != null && firstSheet.header_row !== '') {
      params.set('header_row', String(firstSheet.header_row));
    }

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'application/octet-stream' }), latestFile.name);
    const convertResp = await fetch(`${EXCEL_TO_SQL_URL}/convert?${params.toString()}`, {
      method: 'POST',
      body: formData,
    });
    if (!convertResp.ok) {
      const errText = await convertResp.text();
      throw new Error(`Conversion service error ${convertResp.status}: ${errText}`);
    }

    // 9. Extract clean CSV from ZIP response
    const zipBuffer = await convertResp.arrayBuffer();
    const zip = await JSZip.loadAsync(zipBuffer);
    let cleanCsv = null;
    for (const [filename, fileObj] of Object.entries(zip.files)) {
      if (filename.endsWith('_clean.csv')) {
        cleanCsv = await fileObj.async('string');
        break;
      }
    }
    if (!cleanCsv) throw new Error('Conversion service did not return a clean CSV');

    // 10. Apply column exclusions (by name, not index)
    const excludedColNames = firstSheet.excluded_col_names || [];
    if (excludedColNames.length > 0) {
      const lines = cleanCsv.split('\n');
      const headerCells = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
      const keepIndices = headerCells.map((h, i) => excludedColNames.includes(h) ? -1 : i).filter(i => i !== -1);
      cleanCsv = lines.map(line => {
        if (!line.trim()) return line;
        const cells = line.split(',');
        return keepIndices.map(i => cells[i] ?? '').join(',');
      }).join('\n');
    }

    // 11. Validate columns against saved dataset_headers (hard fail on missing)
    const datasetR = await client.query(
      'SELECT dataset_headers, dataset_name FROM n8n_data.dataset_record_manager WHERE dataset_id=$1',
      [datasetId]
    );
    const datasetName = datasetR.rows[0]?.dataset_name || datasetId;
    if (datasetR.rowCount > 0 && datasetR.rows[0].dataset_headers) {
      const savedHeaders = datasetR.rows[0].dataset_headers;
      const incomingHeaders = cleanCsv.split('\n')[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
      const missingCols = savedHeaders.filter(h => !incomingHeaders.includes(h));
      if (missingCols.length > 0) {
        throw new Error(`Format change detected — missing columns: [${missingCols.join(', ')}]. Ingestion aborted; existing data preserved.`);
      }
    }

    // 12. Upload via update-dataset n8n webhook
    const csvBase64 = Buffer.from(cleanCsv).toString('base64');
    const n8nBase = N8N_BASE.replace(/\/$/, '');
    const updateResp = await axios.post(
      `${n8nBase}/webhook/update-dataset`,
      { datasetId, email: ownerEmail, csvData: csvBase64, fileName: latestFile.name },
      { headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' }, timeout: 300000 }
    );
    const updateResult = updateResp.data;
    if (updateResult.status !== 'ok') throw new Error(updateResult.message || 'Dataset update failed');
    const rowsInserted = updateResult.rowsInserted || null;

    // 13. Log success
    await client.query(
      `INSERT INTO n8n_data.dataset_ingestion_files
         (dataset_id, file_name, file_id, file_location, location_type, ingested_at, ingestion_result, rows_inserted)
       VALUES ($1, $2, $3, $4, $5, now(), 'success', $6)`,
      [datasetId, latestFile.name, latestFile.id, sched.folder_id, sched.location_type, rowsInserted]
    );
    await client.query(
      `UPDATE n8n_data.dataset_ingestion_schedule SET last_run_at=now(), last_run_status='success' WHERE dataset_id=$1`,
      [datasetId]
    );
    await client.query(
      `INSERT INTO n8n_data.conversation_history
         (user_email, prompt, response, ai_model, dataset_id, dataset_name)
       VALUES ($1, $2, $3, 'ingestion', $4, $5)`,
      [
        ownerEmail,
        `[Ingestion] ${latestFile.name}`,
        `✓ Ingestion successful.${rowsInserted ? ' ' + rowsInserted + ' rows inserted.' : ''} File: ${latestFile.name}`,
        datasetId, datasetName
      ]
    );
    return { status: 'success', rowsInserted, fileName: latestFile.name };

  } catch (err) {
    console.error(`runIngestion error [${datasetId}]:`, err.message);
    try {
      await client.query(
        `INSERT INTO n8n_data.dataset_ingestion_files
           (dataset_id, file_name, file_id, ingestion_result, error_message, ingested_at)
         VALUES ($1, $2, $3, 'fail', $4, now())`,
        [datasetId, latestFileName, latestFileId, err.message]
      );
      await client.query(
        `UPDATE n8n_data.dataset_ingestion_schedule SET last_run_at=now(), last_run_status='fail' WHERE dataset_id=$1`,
        [datasetId]
      );
      if (ownerEmail) {
        await client.query(
          `INSERT INTO n8n_data.conversation_history
             (user_email, prompt, response, ai_model, dataset_id, dataset_name)
           VALUES ($1, $2, $3, 'ingestion', $4, $4)`,
          [ownerEmail, `[Ingestion] ${latestFileName || 'unknown file'}`, `✗ Ingestion failed: ${err.message}`, datasetId]
        );
      }
    } catch (logErr) {
      console.error('Failed to log ingestion error:', logErr.message);
    }
    return { status: 'fail', message: err.message };
  } finally {
    client.release();
  }
}

function scheduleJob(row) {
  if (!row.schedule || !cron.validate(row.schedule)) return;
  unscheduleJob(row.dataset_id);
  const job = cron.schedule(row.schedule, () => {
    runIngestion(row.dataset_id, 'schedule')
      .catch(e => console.error(`Cron ingestion error [${row.dataset_id}]:`, e.message));
  });
  activeJobs.set(row.dataset_id, job);
  console.log(`Scheduled ingestion for dataset ${row.dataset_id}: ${row.schedule}`);
}

function unscheduleJob(datasetId) {
  const existing = activeJobs.get(datasetId);
  if (existing) { existing.stop(); activeJobs.delete(datasetId); }
}

async function loadAndScheduleAll() {
  const client = await pgPool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM n8n_data.dataset_ingestion_schedule WHERE enabled=true AND schedule IS NOT NULL`
    );
    for (const row of rows) scheduleJob(row);
    if (rows.length > 0) console.log(`Loaded ${rows.length} ingestion schedule(s)`);
  } catch (err) {
    console.error('Failed to load ingestion schedules:', err.message);
  } finally {
    client.release();
  }
}

// ── Google OAuth endpoints ────────────────────────────────────────────────────

app.get('/google/auth-url', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google OAuth not configured on server' });
  const oauth2Client = createOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    state: encodeURIComponent(email),
  });
  res.json({ url });
});

// Public — no API_SECRET (called by Google redirect)
app.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  const email = decodeURIComponent(String(state));
  const client = await pgPool.connect();
  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(String(code));
    await client.query(
      `INSERT INTO n8n_data.google_oauth_tokens (user_email, access_token, refresh_token, token_expiry)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_email) DO UPDATE SET
         access_token=$2,
         refresh_token=COALESCE($3, google_oauth_tokens.refresh_token),
         token_expiry=$4,
         updated_at=now()`,
      [email, tokens.access_token, tokens.refresh_token || null,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null]
    );
    res.redirect(`${FRONTEND_URL}/?google_connected=1`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send('Google OAuth failed: ' + err.message);
  } finally {
    client.release();
  }
});

app.get('/google/token-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const r = await client.query(
      'SELECT user_email FROM n8n_data.google_oauth_tokens WHERE user_email=$1', [email]
    );
    res.json({ connected: r.rowCount > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/google/disconnect', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    await client.query('DELETE FROM n8n_data.google_oauth_tokens WHERE user_email=$1', [email]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/google/drive/files', async (req, res) => {
  const { email, folder_id } = req.query;
  if (!email || !folder_id) return res.status(400).json({ error: 'email and folder_id required' });
  const client = await pgPool.connect();
  try {
    const oauth2Client = await getValidAccessToken(email, client);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const listResp = await drive.files.list({
      q: `'${folder_id}' in parents and trashed=false`,
      orderBy: 'createdTime desc',
      pageSize: 10,
      fields: 'files(id,name,createdTime,mimeType)',
    });
    res.json(listResp.data.files || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Ingestion config endpoints ────────────────────────────────────────────────

app.get('/ingestion/config/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const client = await pgPool.connect();
  try {
    const r = await client.query(
      'SELECT * FROM n8n_data.dataset_ingestion_config WHERE dataset_id=$1', [datasetId]
    );
    res.json(r.rowCount > 0 ? r.rows[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/ingestion/config', async (req, res) => {
  const { dataset_id, config, source_type = 'excel' } = req.body;
  if (!dataset_id || !config) return res.status(400).json({ error: 'dataset_id and config required' });
  const client = await pgPool.connect();
  try {
    await client.query(
      `INSERT INTO n8n_data.dataset_ingestion_config (dataset_id, config, source_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (dataset_id) DO UPDATE SET config=$2, source_type=$3, updated_at=now()`,
      [dataset_id, JSON.stringify(config), source_type]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Ingestion schedule endpoints ──────────────────────────────────────────────

app.get('/ingestion/schedule/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const client = await pgPool.connect();
  try {
    const r = await client.query(
      'SELECT * FROM n8n_data.dataset_ingestion_schedule WHERE dataset_id=$1', [datasetId]
    );
    res.json(r.rowCount > 0 ? r.rows[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/ingestion/schedule', async (req, res) => {
  const { dataset_id, owner_email, folder_id, schedule, enabled = true } = req.body;
  if (!dataset_id || !owner_email || !folder_id) {
    return res.status(400).json({ error: 'dataset_id, owner_email, and folder_id required' });
  }
  const client = await pgPool.connect();
  try {
    const r = await client.query(
      `INSERT INTO n8n_data.dataset_ingestion_schedule
         (dataset_id, owner_email, folder_id, schedule, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dataset_id) DO UPDATE SET
         folder_id=$3, schedule=$4, enabled=$5, updated_at=now()
       RETURNING *`,
      [dataset_id, owner_email, folder_id, schedule || null, enabled]
    );
    const row = r.rows[0];
    if (row.enabled && row.schedule) scheduleJob(row);
    else unscheduleJob(dataset_id);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/ingestion/schedule/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const { folder_id, schedule, enabled } = req.body;
  const client = await pgPool.connect();
  try {
    const fields = [];
    const vals = [];
    let idx = 1;
    if (folder_id !== undefined) { fields.push(`folder_id=$${idx++}`); vals.push(folder_id); }
    if (schedule !== undefined) { fields.push(`schedule=$${idx++}`); vals.push(schedule || null); }
    if (enabled !== undefined) { fields.push(`enabled=$${idx++}`); vals.push(enabled); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at=now()');
    vals.push(datasetId);
    const r = await client.query(
      `UPDATE n8n_data.dataset_ingestion_schedule SET ${fields.join(', ')}
       WHERE dataset_id=$${idx} RETURNING *`,
      vals
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Schedule not found' });
    const row = r.rows[0];
    if (row.enabled && row.schedule) scheduleJob(row);
    else unscheduleJob(datasetId);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/ingestion/schedule/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const client = await pgPool.connect();
  try {
    unscheduleJob(datasetId);
    await client.query(
      'DELETE FROM n8n_data.dataset_ingestion_schedule WHERE dataset_id=$1', [datasetId]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/ingestion/run/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const schedR = await client.query(
      'SELECT owner_email FROM n8n_data.dataset_ingestion_schedule WHERE dataset_id=$1', [datasetId]
    );
    if (schedR.rowCount === 0) return res.status(404).json({ error: 'No schedule found for this dataset' });
    const isOwner = schedR.rows[0].owner_email === email;
    const admin = await isAdmin(email, client);
    if (!isOwner && !admin) return res.status(403).json({ error: 'Not authorized' });
  } catch (err) {
    client.release();
    return res.status(500).json({ error: err.message });
  }
  client.release();
  res.json({ status: 'started', message: 'Ingestion started. Check your history for results.' });
  runIngestion(datasetId, 'manual')
    .catch(e => console.error(`Manual ingestion error [${datasetId}]:`, e.message));
});

app.get('/ingestion/files/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const client = await pgPool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM n8n_data.dataset_ingestion_files
       WHERE dataset_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [datasetId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('mcp-n8n server running'));

app.listen(PORT, () => {
  console.log(`mcp-n8n listening on ${PORT}`);
  loadAndScheduleAll();
});
