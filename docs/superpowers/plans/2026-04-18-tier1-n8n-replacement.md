# Tier 1 n8n Workflow Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 4 trivial n8n webhook workflows with direct mcp-n8n postgres endpoints, eliminating the n8n round-trip.

**Architecture:** Add 3 new Express endpoints to mcp-n8n `index.js` that query postgres directly using the existing `pgPool`. Move 3 frontend methods from `mcpN8nService` to `mcpPocketbaseService`. The 4th workflow (List Datasets) is already covered by existing endpoints — no code needed.

**Tech Stack:** Express.js, node-postgres (pg), React, TypeScript, Vite

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `mcp-n8n/index.js` | Add 3 endpoints: preview, list templates, delete template |
| Modify | `DataAnalyzer/src/services/mcpPocketbaseService.ts` | Add `getDatasetPreview`, `listTemplates`, `deleteTemplate` |
| Modify | `DataAnalyzer/src/services/mcpN8nService.ts` | Remove 3 methods and their webhook constants |
| Modify | `DataAnalyzer/src/pages/DatasetPromptPage.tsx` | Switch `n8nService.getDatasetPreview` → `pocketbaseService.getDatasetPreview` |
| Modify | `DataAnalyzer/src/pages/PlanReportPage.tsx` | Switch preview call |
| Modify | `DataAnalyzer/src/pages/ResultsPage.tsx` | Switch preview call |
| Modify | `DataAnalyzer/src/pages/ReportTemplateManagerPage.tsx` | Switch template calls |

---

### Task 1: Add `GET /datasets/:datasetId/preview` endpoint to mcp-n8n

**Files:**
- Modify: `mcp-n8n/index.js` (insert after the existing `GET /dataset-view/:datasetId` block around line 376)

- [ ] **Step 1: Add the preview endpoint**

Insert this block after the `dataset-view` endpoint (after line 376):

```javascript
// Returns a random sample of rows from a dataset (replaces n8n "Get Dataset Preview" workflow).
app.get('/datasets/:datasetId/preview', async (req, res) => {
  const { datasetId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM n8n_data.universal_datatable WHERE dataset_id = $1 ORDER BY RANDOM() LIMIT $2`,
      [datasetId, limit]
    );
    const columns = result.fields.map(f => f.name);
    const rows = result.rows;
    res.json({ columns, rows });
  } catch (err) {
    console.error('GET /datasets/:id/preview error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
```

- [ ] **Step 2: Test locally**

Start the mcp-n8n server (if running locally) and call:
```bash
curl -s -H "x-api-secret: 950af2021e79797e4bf848e3d0ad7754e8172adbef38f5559d11470ffb3ab757" "http://localhost:3000/datasets/SOME_DATASET_ID/preview?limit=5"
```
Expected: `{"columns":[...],"rows":[...]}`

- [ ] **Step 3: Commit**

```bash
cd mcp-n8n && git add index.js && git commit -m "Add GET /datasets/:datasetId/preview endpoint"
```

---

### Task 2: Add `GET /templates` endpoint to mcp-n8n

**Files:**
- Modify: `mcp-n8n/index.js` (insert near other CRUD endpoints, e.g. after ai-models section around line 1040)

- [ ] **Step 1: Add the list templates endpoint**

Insert after the `DELETE /ai-models/:id` block:

```javascript
// ── Report Templates ────────────────────────────────────────────────────────────

// List report templates accessible to a user (public + owned).
// Replaces n8n "List Templates" workflow.
app.get('/templates', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `SELECT template_id,
              template_name AS title,
              template_desc AS description,
              html AS html_content,
              owner_email,
              CASE WHEN template_access = 'public' THEN true ELSE false END AS is_public
       FROM n8n_data."data-analyzer-report-templates"
       WHERE template_access = 'public' OR owner_email = $1
       ORDER BY template_name`,
      [email]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /templates error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
```

- [ ] **Step 2: Test locally**

```bash
curl -s -H "x-api-secret: 950af2021e79797e4bf848e3d0ad7754e8172adbef38f5559d11470ffb3ab757" "http://localhost:3000/templates?email=test@example.com"
```
Expected: JSON array of template objects

- [ ] **Step 3: Commit**

```bash
cd mcp-n8n && git add index.js && git commit -m "Add GET /templates endpoint"
```

---

### Task 3: Add `DELETE /templates/:templateId` endpoint to mcp-n8n

**Files:**
- Modify: `mcp-n8n/index.js` (insert right after the `GET /templates` endpoint)

- [ ] **Step 1: Add the delete template endpoint**

Insert after the `GET /templates` block:

```javascript
// Delete a report template (ownership verified). Replaces n8n "Delete Template" workflow.
app.delete('/templates/:templateId', async (req, res) => {
  const { templateId } = req.params;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `DELETE FROM n8n_data."data-analyzer-report-templates"
       WHERE template_id = $1 AND owner_email = $2
       RETURNING template_id`,
      [templateId, email]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found or not owned by user' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /templates/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
```

- [ ] **Step 2: Test locally**

```bash
curl -s -X DELETE -H "x-api-secret: 950af2021e79797e4bf848e3d0ad7754e8172adbef38f5559d11470ffb3ab757" "http://localhost:3000/templates/SOME_TEMPLATE_ID?email=owner@example.com"
```
Expected: `{"deleted":true}` or `{"error":"Template not found or not owned by user"}`

- [ ] **Step 3: Commit**

```bash
cd mcp-n8n && git add index.js && git commit -m "Add DELETE /templates/:templateId endpoint"
```

---

### Task 4: Add `getDatasetPreview`, `listTemplates`, `deleteTemplate` to mcpPocketbaseService

**Files:**
- Modify: `DataAnalyzer/src/services/mcpPocketbaseService.ts`

- [ ] **Step 1: Add the three methods**

Add these methods to the `pocketbaseService` object (e.g. after the `getAccessibleDatasets` method, around line 180):

```typescript
  async getDatasetPreview(datasetId: string, _email: string, limit: number = 20): Promise<DatasetPreview> {
    const response = await mcpN8nApi.get<DatasetPreview>(`/datasets/${encodeURIComponent(datasetId)}/preview`, {
      params: { limit },
    })
    return response.data
  },

  async listTemplates(email: string): Promise<ReportTemplate[]> {
    const response = await mcpN8nApi.get<ReportTemplate[]>('/templates', {
      params: { email },
    })
    return toArray<ReportTemplate>(response.data)
  },

  async deleteTemplate(templateId: string, email: string): Promise<void> {
    await mcpN8nApi.delete(`/templates/${encodeURIComponent(templateId)}`, {
      params: { email },
    })
  },
```

Note: `getDatasetPreview` accepts `_email` for API compatibility with the existing call signatures but doesn't pass it to the endpoint (the new endpoint doesn't require email for authorization — dataset access is not restricted at the preview level, matching the current n8n workflow behavior).

- [ ] **Step 2: Ensure `ReportTemplate` and `DatasetPreview` are in the import**

The existing import line at the top of `mcpPocketbaseService.ts` imports types from `'../types'`. Verify that `DatasetPreview` and `ReportTemplate` are included. If not, add them.

Current import (line 2-6):
```typescript
import type {
  Dataset, AIModel, NavLink, ConversationHistory, UserProfile,
  ProfileCompany, ProfileBusinessUnit, ProfileTeam, TemplateProfileAssignment, AdminUser, AppSettings,
  SavedQuestion, IngestionConfig, IngestionSchedule, IngestionFile, GoogleTokenStatus, MicrosoftTokenStatus, DriveFile
} from '../types'
```

Change to:
```typescript
import type {
  Dataset, DatasetPreview, AIModel, NavLink, ConversationHistory, UserProfile,
  ProfileCompany, ProfileBusinessUnit, ProfileTeam, TemplateProfileAssignment, AdminUser, AppSettings,
  SavedQuestion, IngestionConfig, IngestionSchedule, IngestionFile, ReportTemplate,
  GoogleTokenStatus, MicrosoftTokenStatus, DriveFile
} from '../types'
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd DataAnalyzer && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd DataAnalyzer && git add src/services/mcpPocketbaseService.ts && git commit -m "Add getDatasetPreview, listTemplates, deleteTemplate to pocketbaseService"
```

---

### Task 5: Switch frontend pages to use pocketbaseService for preview

**Files:**
- Modify: `DataAnalyzer/src/pages/DatasetPromptPage.tsx`
- Modify: `DataAnalyzer/src/pages/PlanReportPage.tsx`
- Modify: `DataAnalyzer/src/pages/ResultsPage.tsx`

- [ ] **Step 1: Update DatasetPromptPage.tsx**

Find the import line that uses `n8nService` for `getDatasetPreview`. Add `pocketbaseService` import if not already present. Change the query:

```typescript
// FROM:
queryFn: () => n8nService.getDatasetPreview(selectedDatasetId, session!.email, 20),
// TO:
queryFn: () => pocketbaseService.getDatasetPreview(selectedDatasetId, session!.email, 20),
```

- [ ] **Step 2: Update PlanReportPage.tsx**

```typescript
// FROM:
queryFn: () => n8nService.getDatasetPreview(previewDatasetId!, session!.email, 10),
// TO:
queryFn: () => pocketbaseService.getDatasetPreview(previewDatasetId!, session!.email, 10),
```

- [ ] **Step 3: Update ResultsPage.tsx**

```typescript
// FROM:
queryFn: () => n8nService.getDatasetPreview(datasetId, session!.email, 20),
// TO:
queryFn: () => pocketbaseService.getDatasetPreview(datasetId, session!.email, 20),
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd DataAnalyzer && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd DataAnalyzer && git add src/pages/DatasetPromptPage.tsx src/pages/PlanReportPage.tsx src/pages/ResultsPage.tsx && git commit -m "Switch getDatasetPreview from n8nService to pocketbaseService"
```

---

### Task 6: Switch ReportTemplateManagerPage to use pocketbaseService

**Files:**
- Modify: `DataAnalyzer/src/pages/ReportTemplateManagerPage.tsx`

- [ ] **Step 1: Update template listing**

```typescript
// FROM:
queryFn: () => n8nService.listTemplates(session!.email),
// TO:
queryFn: () => pocketbaseService.listTemplates(session!.email),
```

- [ ] **Step 2: Update template deletion**

```typescript
// FROM:
await n8nService.deleteTemplate(template.template_id, session.email)
// TO:
await pocketbaseService.deleteTemplate(template.template_id, session.email)
```

- [ ] **Step 3: Add pocketbaseService import if not present, remove n8nService import if no longer used**

Check if `n8nService` is still used elsewhere in the file. If not, remove its import. Add `pocketbaseService` import if not already present.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd DataAnalyzer && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd DataAnalyzer && git add src/pages/ReportTemplateManagerPage.tsx && git commit -m "Switch listTemplates/deleteTemplate from n8nService to pocketbaseService"
```

---

### Task 7: Clean up mcpN8nService — remove migrated methods and constants

**Files:**
- Modify: `DataAnalyzer/src/services/mcpN8nService.ts`

- [ ] **Step 1: Remove the three webhook path constants**

Remove these lines from the top of the file:
```typescript
const LIST_TEMPLATES_WEBHOOK_PATH = 'webhook/list-templates'
const DELETE_TEMPLATE_WEBHOOK_PATH = 'webhook/delete-template'
const GET_DATASET_PREVIEW_WEBHOOK_PATH = 'webhook/get-dataset-preview'
```

- [ ] **Step 2: Remove the three methods**

Remove `getDatasetPreview`, `listTemplates`, and `deleteTemplate` methods from the `n8nService` object.

- [ ] **Step 3: Remove unused types from the import if applicable**

Check if `DatasetPreview` or `ReportTemplate` are still referenced in `mcpN8nService.ts`. If not, remove them from the import line.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd DataAnalyzer && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd DataAnalyzer && git add src/services/mcpN8nService.ts && git commit -m "Remove migrated methods from n8nService"
```

---

### Task 8: Build, verify, and push both repos

**Files:** None (verification only)

- [ ] **Step 1: Full build of DataAnalyzer frontend**

```bash
cd DataAnalyzer && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Push mcp-n8n**

```bash
cd mcp-n8n && git push
```

- [ ] **Step 3: Push DataAnalyzer**

```bash
cd DataAnalyzer && git push
```

- [ ] **Step 4: Deploy and verify in production**

After the mcp-n8n container restarts with the new endpoints, test in the DataAnalyzer app:
1. Navigate to a dataset — verify preview loads
2. Go to Report Template Manager — verify templates list loads
3. Delete a test template — verify it works
4. Run an analysis — verify preview still works on the results page

- [ ] **Step 5: Deactivate the 4 n8n workflows**

In n8n, deactivate:
- `Data Analyzer - List Datasets` (IskB0GvdLpdoJ9Bz)
- `Data Analyzer - Get Dataset Preview` (zfqh9mX9tfs1WCdhwXJht)
- `Data Analyzer - List Templates` (FBlOFa07NGZPVkI6)
- `Data Analyzer - Delete Template` (I1wxpJ997wScZfPR)

```bash
# Via n8n API:
API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzMTE1MTNhNi00MTE3LTRhNWMtODllNS0yOGY5NThkYmQzOTAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzcwMTc5ODQxfQ.tkWBcjCUUBMrJMlRZuB9-FF7iqjjeegVqJGpwqie5JE"
for id in IskB0GvdLpdoJ9Bz zfqh9mX9tfs1WCdhwXJht FBlOFa07NGZPVkI6 I1wxpJ997wScZfPR; do
  curl -s -X PATCH -H "X-N8N-API-KEY: $API_KEY" -H "Content-Type: application/json" -d '{"active":false}' "https://n8n.ede-lee.ca/api/v1/workflows/$id"
  echo "Deactivated $id"
done
```
