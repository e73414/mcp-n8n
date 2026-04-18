# Tier 1 n8n Workflow Replacement Design

Replace 4 trivial n8n workflows (pure SQL passthrough) with direct mcp-n8n endpoints, eliminating the n8n round-trip.

## Current Architecture

```
Frontend → mcpN8nService → mcp-n8n /mcp/execute → n8n webhook → n8n postgres → response
```

## Target Architecture

```
Frontend → mcpPocketbaseService → mcp-n8n direct endpoint → postgres → response
```

## Replacements

### 1. List Datasets — No new endpoint

The frontend already uses `pocketbaseService.getAccessibleDatasets()` for the main dataset list. The n8n `List Datasets` webhook is only used by the MCP skill path.

**Action:** Deactivate the n8n workflow. No code changes needed.

### 2. Get Dataset Preview

**New endpoint:** `GET /datasets/:datasetId/preview?limit=N`

SQL (from n8n workflow):
```sql
SELECT * FROM n8n_data.universal_datatable
WHERE dataset_id = $1
ORDER BY RANDOM()
LIMIT $2
```

Default limit: 20. Returns array of row objects.

**Frontend:** Move `getDatasetPreview` from `mcpN8nService` to `mcpPocketbaseService`.

### 3. List Templates

**New endpoint:** `GET /templates?email=X`

SQL (from n8n workflow):
```sql
SELECT template_id,
       template_name AS title,
       template_desc AS description,
       html AS html_content,
       owner_email,
       CASE WHEN template_access = 'public' THEN true ELSE false END AS is_public
FROM n8n_data."data-analyzer-report-templates"
WHERE template_access = 'public' OR owner_email = $1
ORDER BY template_name
```

Returns array of template objects.

**Frontend:** Move `listTemplates` from `mcpN8nService` to `mcpPocketbaseService`.

### 4. Delete Template

**New endpoint:** `DELETE /templates/:templateId?email=X`

SQL (from n8n workflow):
```sql
DELETE FROM n8n_data."data-analyzer-report-templates"
WHERE template_id = $1 AND owner_email = $2
RETURNING template_id
```

Returns 200 with `{ deleted: true }` if row was deleted, 404 if not found.

**Frontend:** Move `deleteTemplate` from `mcpN8nService` to `mcpPocketbaseService`.

## Files Changed

### mcp-n8n (backend)

| File | Change |
|------|--------|
| `index.js` | Add 3 new endpoints: `GET /datasets/:datasetId/preview`, `GET /templates`, `DELETE /templates/:templateId` |

### DataAnalyzer (frontend)

| File | Change |
|------|--------|
| `mcpPocketbaseService.ts` | Add `getDatasetPreview`, `listTemplates`, `deleteTemplate` methods |
| `mcpN8nService.ts` | Remove `getDatasetPreview`, `listTemplates`, `deleteTemplate` and their webhook path constants |
| `DatasetPromptPage.tsx` | Switch `n8nService.getDatasetPreview` → `pocketbaseService.getDatasetPreview` |
| `MobileDatasetPromptPage.tsx` | Switch preview call |
| `PlanReportPage.tsx` | Switch preview call |
| `ResultsPage.tsx` | Switch preview call |
| `ReportTemplateManagerPage.tsx` | Switch `listTemplates` / `deleteTemplate` |
| `MobilePlanReportPage.tsx` | Switch any preview/template calls |

## Post-Implementation

After all 4 replacements are verified working:
- Deactivate the 4 n8n workflows in production
- Remove the unused webhook path constants from `mcpN8nService.ts`
