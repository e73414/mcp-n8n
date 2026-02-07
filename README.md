# mcp-n8n

Minimal MCP-style adapter that exposes a skill list and forwards skill executions to n8n webhooks.

Quick start (Docker):

1. From the `mcp-n8n` folder run:

```bash
docker compose up --build -d
```

2. Verify the server is running:

```bash
curl http://localhost:3000/
curl http://localhost:3000/mcp/skills
```

Usage example: trigger an n8n webhook via the adapter:

```bash
curl -X POST http://localhost:3000/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"skill":"n8n-webhook","params":{"webhookPath":"webhook/my-workflow"},"input":{"foo":"bar"}}'
```

Notes:
- Create a webhook-based workflow in your n8n instance. The `webhookPath` should be the relative path part of the webhook URL inside your n8n (for example `webhook/abcd-1234`).
- This adapter posts JSON to `N8N_BASE_URL/<webhookPath>` and sends `X-N8N-API-KEY` header from `.env`.
- The `.env` file has been pre-filled with the URL and API key you provided; rotate credentials if needed.
