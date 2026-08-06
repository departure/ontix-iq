# Asana Gatekeeper

Read-only access to a configured Asana workspace through **Asana MCP** (`https://mcp.asana.com/v2/mcp`): bounded or exhaustive task search, single-task reads, and project listing.

## Credentials

| Name | Kind | Role |
| --- | --- | --- |
| `ASANA_CLIENT_ID` | var | MCP OAuth app client id |
| `ASANA_CLIENT_SECRET` | secret | MCP OAuth app client secret |
| `ASANA_REFRESH_TOKEN` | secret | MCP OAuth refresh token |
| `ASANA_ACCESS_TOKEN` | optional secret | Bootstrap access token (refreshed automatically) |
| `ASANA_WORKSPACE_GID` | var | Workspace used for search/list filters |

Local `pnpm dev` copies client credentials from `.env` and, when `ASANA_REFRESH_TOKEN` is unset, loads the refresh/access pair from `.data/secrets/asana-tokens.json` when present. Token refresh uses `https://app.asana.com/-/oauth_token` (MCP V2's authorization server), not `mcp.asana.com/token`. Do not put a REST personal access token in `ASANA_ACCESS_TOKEN` — MCP rejects it.

Production:

```bash
pnpm exec wrangler secret put ASANA_CLIENT_SECRET --config packages/gatekeeper-asana/wrangler.jsonc
pnpm exec wrangler secret put ASANA_REFRESH_TOKEN --config packages/gatekeeper-asana/wrangler.jsonc
```

Set `ASANA_CLIENT_ID` and `ASANA_WORKSPACE_GID` as Worker vars (see `deployment.jsonc` / deploy script).

This release has no mutation methods. Every MCP read is authorized and logged as an observation. `findUsers` resolves people; assignee `searchTasks` paginates `get_tasks` exhaustively; dated `searchTasks` partitions around MCP's 100-result search page limit (subject to a safety ceiling).
