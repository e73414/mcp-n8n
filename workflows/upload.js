const https = require('https');
const fs = require('fs');

const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzMTE1MTNhNi00MTE3LTRhNWMtODllNS0yOGY5NThkYmQzOTAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzcwMTc5ODQxfQ.tkWBcjCUUBMrJMlRZuB9-FF7iqjjeegVqJGpwqie5JE';
const HOST = 'n8n.ede-lee.ca';

function uploadWorkflow(file, workflowId) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // n8n PUT /workflows/:id only accepts these fields
  const allowed = { name: raw.name, nodes: raw.nodes, connections: raw.connections, settings: raw.settings, staticData: raw.staticData };
  const body = JSON.stringify(allowed);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path: `/api/v1/workflows/${workflowId}`,
      method: 'PUT',
      headers: {
        'X-N8N-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          if (d.id) console.log('Updated:', d.id, '|', d.name);
          else console.log('Error:', JSON.stringify(d).slice(0, 300));
        } catch { console.log('Raw:', data.slice(0, 300)); }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

uploadWorkflow('./execute-plan.json', 'taHjSlURcGuHr_vMzffkE')
  .then(() => console.log('Done'))
  .catch(e => console.error(e));
