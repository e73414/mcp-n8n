require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // Increased limit for large CSV files

const API_SECRET = process.env.API_SECRET || '';
app.use((req, res, next) => {
  if (!API_SECRET) return next(); // skip if not configured
  if (req.headers['x-api-secret'] === API_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

const PORT = process.env.PORT || 3000;
const N8N_BASE = process.env.N8N_BASE_URL || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

if (!N8N_BASE) console.warn('N8N_BASE_URL not set; outgoing calls will fail.');
if (!N8N_API_KEY) console.warn('N8N_API_KEY not set; some n8n endpoints may reject requests.');

const pgPool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'n8n',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

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
app.get('/datasets', async (req, res) => {
  const { email, profile, profiles } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const profilesArray = profiles
    ? String(profiles).split(',').filter(p => p && p.trim().length === 9)
    : [];
  const client = await pgPool.connect();
  try {
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

// Used by the admin Dataset Access Manager.
app.get('/datasets/all', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM n8n_data.dataset_record_manager
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /datasets/all error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/dataset-view/:datasetId', async (req, res) => {
  const { datasetId } = req.params;

  // Validate to prevent SQL injection — dataset IDs are alphanumeric + hyphens only
  if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) {
    return res.status(400).json({ error: 'Invalid dataset ID' });
  }

  const viewName = `v_ds_${datasetId.replace(/-/g, '_')}`;
  const client = await pgPool.connect();
  try {
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
  const { password_hash, template_id, profile, user_timezone, profiles } = req.body;
  const fields = [], values = [];
  if (password_hash  !== undefined) { fields.push(`password_hash = $${fields.length + 1}`);  values.push(password_hash); }
  if (template_id    !== undefined) { fields.push(`template_id = $${fields.length + 1}`);     values.push(template_id); }
  if (profile        !== undefined) { fields.push(`profile = $${fields.length + 1}`);         values.push(profile); }
  if (user_timezone  !== undefined) { fields.push(`user_timezone = $${fields.length + 1}`);   values.push(user_timezone); }
  if (profiles       !== undefined) { fields.push(`profiles = $${fields.length + 1}`);        values.push(Array.isArray(profiles) ? profiles : []); }
  if (fields.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(id);
  const client = await pgPool.connect();
  try {
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

app.get('/ai-models', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.ai_models');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /ai-models error:', err.message);
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const client = await pgPool.connect();
  try {
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const client = await pgPool.connect();
  try {
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
  const client = await pgPool.connect();
  try {
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
  const { name, company_code } = req.body;
  if (!name || !company_code) return res.status(400).json({ error: 'name and company_code required' });
  const client = await pgPool.connect();
  try {
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const client = await pgPool.connect();
  try {
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
  const client = await pgPool.connect();
  try {
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
  const { name, company_code, bu_code } = req.body;
  if (!name || !company_code || !bu_code) return res.status(400).json({ error: 'name, company_code and bu_code required' });
  const client = await pgPool.connect();
  try {
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const client = await pgPool.connect();
  try {
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
  const client = await pgPool.connect();
  try {
    await client.query('DELETE FROM n8n_data.profile_teams WHERE id=$1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/teams/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Admin: Users ──────────────────────────────────────────────────────────────

app.get('/admin/users', async (req, res) => {
  const client = await pgPool.connect();
  try {
    const result = await client.query('SELECT * FROM n8n_data.users ORDER BY user_email ASC');
    res.json(result.rows.map(r => ({ ...r, profiles: r.profiles || [] })));
  } catch (err) {
    console.error('GET /admin/users error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/admin/users', async (req, res) => {
  const { user_email, password_hash, profile, user_timezone, template_id, profiles } = req.body;
  if (!user_email) return res.status(400).json({ error: 'user_email required' });
  const client = await pgPool.connect();
  try {
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
  const client = await pgPool.connect();
  try {
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

app.get('/', (req, res) => res.send('mcp-n8n server running'));

app.listen(PORT, () => console.log(`mcp-n8n listening on ${PORT}`));
