require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // Increased limit for large CSV files

const PORT = process.env.PORT || 3000;
const N8N_BASE = process.env.N8N_BASE_URL || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

if (!N8N_BASE) console.warn('N8N_BASE_URL not set; outgoing calls will fail.');
if (!N8N_API_KEY) console.warn('N8N_API_KEY not set; some n8n endpoints may reject requests.');

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

app.get('/', (req, res) => res.send('mcp-n8n server running'));

app.listen(PORT, () => console.log(`mcp-n8n listening on ${PORT}`));
