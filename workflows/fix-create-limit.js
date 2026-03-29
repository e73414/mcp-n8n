const fs = require('fs');
const d = require('./execute-plan.json');

// Fixed CREATE_LIST_QUERY — adds LIMIT 50000 wrapper (same as original Execute Direct SQL did)
const CREATE_LIST_QUERY = "={{ (function() {\n  var step = $('Loop Over Steps').item.json.step;\n  var reportId = $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_');\n  var sql = (step.query_strategy && (step.query_strategy.sql || step.query_strategy.logic)) || 'SELECT 1';\n  sql = sql.replace(/\\bstep(\\d+)\\b/gi, function(m, n) { return 'n8n_data.\"tmp_' + reportId + '_step_' + n + '\"'; });\n  sql = sql.trim().replace(/;+\\s*$/g, '');\n  sql = sql.replace(/\"([^\"]+)\"\\s*(?:!=|<>)\\s*''/g, '\"$1\" IS NOT NULL');\n  sql = sql.replace(/\"([^\"]+)\"\\s*=\\s*''/g, '\"$1\" IS NULL');\n  sql = sql.replace(/TRIM\\(\"([^\"]+)\"\\)\\s*(?:!=|<>)\\s*''/gi, '\"$1\" IS NOT NULL');\n  sql = sql.replace(/TRIM\\(\"([^\"]+)\"\\)\\s*=\\s*''/gi, '\"$1\" IS NULL');\n  var hasLimit = /\\bLIMIT\\s+\\d+/i.test(sql);\n  if (!hasLimit) { sql = 'SELECT * FROM (' + sql + ') AS _list_data LIMIT 50000'; }\n  var tableName = 'n8n_data.\"tmp_' + reportId + '_step_' + step.step_number + '\"';\n  return 'CREATE TABLE ' + tableName + ' AS ' + sql;\n})() }}";

// Fixed CREATE_LIST_JOIN_QUERY — same LIMIT 50000 wrapper
const CREATE_LIST_JOIN_QUERY = "={{ (function() {\n  var sql = ($json.output || '').trim().replace(/^```(?:sql)?\\s*/i, '').replace(/\\s*```$/, '').trim();\n  if (!sql || sql.toUpperCase().indexOf('SELECT') !== 0) {\n    var step = $('Loop Over Steps').item.json.step;\n    var cols = (step.expected_output || ['result']).map(function(c) { return 'NULL AS \"' + c + '\"'; }).join(', ');\n    sql = 'SELECT ' + cols + ' WHERE false';\n  }\n  var hasLimit = /\\bLIMIT\\s+\\d+/i.test(sql);\n  if (!hasLimit) { sql = 'SELECT * FROM (' + sql + ') AS _list_data LIMIT 50000'; }\n  var reportId = $('Parse Plan & Generate Report ID').item.json.report_id.replace(/[^a-zA-Z0-9_]/g, '_');\n  var stepNum = $('Loop Over Steps').item.json.step.step_number;\n  var tableName = 'n8n_data.\"tmp_' + reportId + '_step_' + stepNum + '\"';\n  return 'CREATE TABLE ' + tableName + ' AS ' + sql;\n})() }}";

const createList = d.nodes.find(n => n.name === 'Create List Step Table');
const createListJoin = d.nodes.find(n => n.name === 'Create List Join Step Table');

if (!createList) { console.error('Create List Step Table not found'); process.exit(1); }
if (!createListJoin) { console.error('Create List Join Step Table not found'); process.exit(1); }

createList.parameters.query = CREATE_LIST_QUERY;
createListJoin.parameters.query = CREATE_LIST_JOIN_QUERY;

fs.writeFileSync('./execute-plan.json', JSON.stringify(d, null, 2));
console.log('Fixed LIMIT in Create List Step Table and Create List Join Step Table');
