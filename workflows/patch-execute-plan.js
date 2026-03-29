const fs = require('fs');
const d = require('./execute-plan.json');

const CREDS = { "id": "5JhwTls4nSPISJqU", "name": "Postgres account" };

const DROP_QUERY = "=DROP TABLE IF EXISTS n8n_data.\"tmp_{{ $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_') + '_step_' + $('Loop Over Steps').item.json.step.step_number }}\"";
const STORE_QUERY = "=UPDATE n8n_data.report_step_results SET raw_table_name = 'tmp_{{ $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_') + '_step_' + $('Loop Over Steps').item.json.step.step_number }}' WHERE report_id = '{{ $('Loop Over Steps').item.json.report_id }}' AND step_number = {{ $('Loop Over Steps').item.json.step.step_number }}";

const CREATE_LIST_QUERY = "={{ (function() {\n  var step = $('Loop Over Steps').item.json.step;\n  var reportId = $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_');\n  var sql = (step.query_strategy && (step.query_strategy.sql || step.query_strategy.logic)) || 'SELECT 1';\n  sql = sql.replace(/\\bstep(\\d+)\\b/gi, function(m, n) { return 'n8n_data.\"tmp_' + reportId + '_step_' + n + '\"'; });\n  sql = sql.trim().replace(/;+\\s*$/g, '');\n  sql = sql.replace(/\"([^\"]+)\"\\s*(?:!=|<>)\\s*''/g, '\"$1\" IS NOT NULL');\n  sql = sql.replace(/\"([^\"]+)\"\\s*=\\s*''/g, '\"$1\" IS NULL');\n  sql = sql.replace(/TRIM\\(\"([^\"]+)\"\\)\\s*(?:!=|<>)\\s*''/gi, '\"$1\" IS NOT NULL');\n  sql = sql.replace(/TRIM\\(\"([^\"]+)\"\\)\\s*=\\s*''/gi, '\"$1\" IS NULL');\n  var tableName = 'n8n_data.\"tmp_' + reportId + '_step_' + step.step_number + '\"';\n  return 'CREATE TABLE ' + tableName + ' AS ' + sql;\n})() }}";

const CREATE_LIST_JOIN_QUERY = "={{ (function() {\n  var sql = ($json.output || '').trim().replace(/^```(?:sql)?\\s*/i, '').replace(/\\s*```$/, '').trim();\n  if (!sql || sql.toUpperCase().indexOf('SELECT') !== 0) {\n    var step = $('Loop Over Steps').item.json.step;\n    var cols = (step.expected_output || ['result']).map(function(c) { return 'NULL AS \"' + c + '\"'; }).join(', ');\n    sql = 'SELECT ' + cols + ' WHERE false';\n  }\n  var reportId = $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_');\n  var stepNum = $('Loop Over Steps').item.json.step.step_number;\n  var tableName = 'n8n_data.\"tmp_' + reportId + '_step_' + stepNum + '\"';\n  return 'CREATE TABLE ' + tableName + ' AS ' + sql;\n})() }}";

const PREVIEW_QUERY = "={{ (function() {\n  var reportId = $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_');\n  var stepNum = $('Loop Over Steps').item.json.step.step_number;\n  return 'SELECT *, COUNT(*) OVER() AS _total_count FROM n8n_data.\"tmp_' + reportId + '_step_' + stepNum + '\" LIMIT 10';\n})() }}";

const FORMAT_CODE = `const items = $input.all();

if (items.length > 0 && items[0].json.error) {
  const err = items[0].json.error;
  let errMsg;
  if (typeof err === 'string') {
    errMsg = err;
  } else {
    const causeMsg = (err.cause && err.cause.message) || null;
    const mainMsg = err.message || null;
    const desc = typeof err.description === 'string' ? err.description : null;
    if (causeMsg && mainMsg && causeMsg !== mainMsg) {
      errMsg = causeMsg + ' | Query: ' + mainMsg.slice(0, 300);
    } else {
      errMsg = causeMsg || mainMsg || desc || JSON.stringify(err).slice(0, 400);
    }
  }
  return [{ json: { output: null, error: 'List step SQL failed: ' + errMsg }, pairedItem: { item: 0 } }];
}

if (!items || items.length === 0) {
  return [{ json: { output: 'No results returned.' }, pairedItem: { item: 0 } }];
}

const rows = items.map(i => i.json);
const totalCount = rows[0]._total_count ?? rows.length;
const headers = Object.keys(rows[0]).filter(h => h !== '_total_count');

const headerRow = '| ' + headers.join(' | ') + ' |';
const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
const previewRows = rows.map(row =>
  '| ' + headers.map(h => {
    const val = row[h];
    return val === null || val === undefined ? '' : String(val).replace(/\\|/g, '\\\\|');
  }).join(' | ') + ' |'
);
const preview = [headerRow, separator, ...previewRows].join('\\n');
const previewNote = totalCount > rows.length
  ? \`\\n_Showing \${rows.length} of \${totalCount} rows — full data available as download_\`
  : '';

const output = \`**Full List (\${totalCount} rows)**\\n\\n\${preview}\${previewNote}\\n<!--LIST_TABLE-->\`;

return [{ json: { output }, pairedItem: items.map((_, i) => ({ item: i })) }];
`;

// ── Add 6 new nodes ──────────────────────────────────────────────────────────

d.nodes.push(
  // Path 1 nodes
  { parameters: { operation: 'executeQuery', query: DROP_QUERY, options: {} },
    id: 'a1b2c3d4-0001-0001-0001-000000000001', name: 'Drop List Step Table',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [3760, -2752],
    credentials: { postgres: CREDS } },

  { parameters: { operation: 'executeQuery', query: CREATE_LIST_QUERY, options: {} },
    id: 'a1b2c3d4-0001-0001-0001-000000000002', name: 'Create List Step Table',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [4064, -2752],
    credentials: { postgres: CREDS }, onError: 'continueErrorOutput' },

  { parameters: { operation: 'executeQuery', query: STORE_QUERY, options: {} },
    id: 'a1b2c3d4-0001-0001-0001-000000000003', name: 'Store List raw_table_name',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [4352, -2752],
    credentials: { postgres: CREDS } },

  // Path 2 nodes
  { parameters: { operation: 'executeQuery', query: DROP_QUERY, options: {} },
    id: 'a1b2c3d4-0002-0002-0002-000000000001', name: 'Drop List Join Step Table',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [4560, -2320],
    credentials: { postgres: CREDS } },

  { parameters: { operation: 'executeQuery', query: CREATE_LIST_JOIN_QUERY, options: {} },
    id: 'a1b2c3d4-0002-0002-0002-000000000002', name: 'Create List Join Step Table',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [4752, -2320],
    credentials: { postgres: CREDS }, onError: 'continueErrorOutput' },

  { parameters: { operation: 'executeQuery', query: STORE_QUERY, options: {} },
    id: 'a1b2c3d4-0002-0002-0002-000000000003', name: 'Store List Join raw_table_name',
    type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [4944, -2320],
    credentials: { postgres: CREDS } }
);

// ── Modify Execute Direct SQL and Execute Fixed SQL ──────────────────────────
d.nodes.find(n => n.name === 'Execute Direct SQL').parameters.query = PREVIEW_QUERY;
d.nodes.find(n => n.name === 'Execute Fixed SQL').parameters.query = PREVIEW_QUERY;

// ── Modify Format List Result ────────────────────────────────────────────────
d.nodes.find(n => n.name === 'Format List Result').parameters.jsCode = FORMAT_CODE;

// ── Update connections ───────────────────────────────────────────────────────

// Path 1: Is List Step? (true=0) → Drop List Step Table → Create List Step Table → Store List raw_table_name → Execute Direct SQL
d.connections['Is List Step?'].main[0] = [{ node: 'Drop List Step Table', type: 'main', index: 0 }];
d.connections['Drop List Step Table'] = { main: [[{ node: 'Create List Step Table', type: 'main', index: 0 }]] };
d.connections['Create List Step Table'] = { main: [
  [{ node: 'Store List raw_table_name', type: 'main', index: 0 }],
  [{ node: 'Format List Result', type: 'main', index: 0 }]
]};
d.connections['Store List raw_table_name'] = { main: [[{ node: 'Execute Direct SQL', type: 'main', index: 0 }]] };

// Path 2: Fix Join SQL → Drop List Join Step Table → Create List Join Step Table → Store List Join raw_table_name → Execute Fixed SQL
d.connections['Fix Join SQL'].main[0] = d.connections['Fix Join SQL'].main[0].map(c =>
  c.node === 'Execute Fixed SQL' ? { node: 'Drop List Join Step Table', type: 'main', index: 0 } : c
);
d.connections['Drop List Join Step Table'] = { main: [[{ node: 'Create List Join Step Table', type: 'main', index: 0 }]] };
d.connections['Create List Join Step Table'] = { main: [
  [{ node: 'Store List Join raw_table_name', type: 'main', index: 0 }],
  [{ node: 'Format List Result', type: 'main', index: 0 }]
]};
d.connections['Store List Join raw_table_name'] = { main: [[{ node: 'Execute Fixed SQL', type: 'main', index: 0 }]] };

fs.writeFileSync('./execute-plan.json', JSON.stringify(d, null, 2));
console.log('Done. Total nodes:', d.nodes.length);
