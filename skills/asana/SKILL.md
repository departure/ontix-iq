# Asana

Reads projects, tasks, milestones, project managers, client work, and resource allocation through the official Asana MCP V2 server.

## Authentication

OAuth 2.0 Authorization Code with PKCE. The app must be configured as an MCP app and distributed to the customer's workspace. Run `npm run auth:asana` once before use.
Expired access tokens are refreshed once and the failed read is retried, including when
expiration is reported inside an MCP tool result during a long paginated analysis.

## Safety

Ontix IQ discovers tools at runtime but rejects names that indicate mutation. Write access remains disabled until approval workflows are implemented and audited.

## Evidence

MCP responses are normalized into cited Asana evidence. Permissions never exceed those of the authorizing Asana user.

Task-volume questions use the local `asana__compare_task_counts` analytical tool. It runs
paginated `get_tasks` retrieval for multiple assignees, deduplicates task GIDs, applies
optional filters locally, and returns compact exact counts and leaders instead of sending
task lists to the model.

Creator-volume questions use `asana__compare_created_task_counts`. Asana task search is
limited to 100 results and cannot be paginated conventionally, so this tool recursively
partitions the calendar year by `created_at` timestamp until every result set is below the
limit. Calendar boundaries use the organization's IANA time zone, and the final evidence
contains exact totals rather than raw task lists.

Client-volume questions use `asana__analyze_client_task_counts`. It retrieves every task
created in the calendar year, attributes subtasks through their parent projects, groups
multiple recognizable projects for the same client, and reports internal, shared-project,
and projectless tasks separately from the client ranking.
