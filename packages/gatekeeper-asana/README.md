# Asana Gatekeeper

Read-only access to a configured Asana workspace: bounded task search, single-task reads, and project listing. Configure `ASANA_WORKSPACE_GID` as a variable and `ASANA_ACCESS_TOKEN` as a Worker secret. The previous encrypted MCP OAuth token is intentionally not copied into the Worker.

This release has no mutation methods. Every API request is authorized and logged as an observation.
