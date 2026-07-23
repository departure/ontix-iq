# Architecture

## Purpose

Ontix IQ is an executive intelligence runtime, not a vendor-specific chatbot. The prototype uses a terminal adapter, but its agent and skills are independent of OpenTUI and can later be called from an HTTP API and Nuxt application.

## Request flow

1. The terminal creates a tenant, user, and conversation context.
2. The agent loads recent conversation, relevant memory, and `ORGANIZATION.md`.
3. The model returns a typed clarification, research plan, or answer-ready decision.
4. The skill registry executes bounded read tools. Asana analytical tools pass normalized query specifications through query services, the tiered cache, MCP retrieval, and pure analytics.
5. Vendor results become normalized evidence. Cached analyses include cache hit, tier, age, and underlying query-count metadata.
6. The model synthesizes an answer from evidence, cites exact evidence IDs, and reports gaps.
7. Conversation and audit records are persisted under the tenant scope.

The agent cannot access vendor clients. All external access crosses the `Skill` interface. The registry records each execution and converts failures into partial-result metadata.

## Asana analytics pipeline

Asana is physically separated into `tools`, `queries`, `retrieval`, `time`, and `analytics` modules. Thin tool handlers validate requests and produce evidence. `CreatedTaskQueryService` and `AssignedTaskQueryService` normalize reusable dataset requests and consult the cache before invoking retrieval. Retrieval owns MCP parsing, exhaustive created-task scans, assigned-task pagination, deduplication, and retries; time owns timezone-aware ranges and buckets; analytics contains pure grouping and forecast calculations. `skills/asana/index.ts` remains the compatibility export.

The created-task service caches minimal timelines, independent full-text term result sets, and heavier project/parent projections. A fresh covering timeline can answer a narrower range by local slicing. Term sets are reused and unioned by task GID for mention and service analyses. Project/parent and assignee datasets remain separate because their fields and retrieval semantics differ; assignee entries are scoped by assignee, filters, and normalized projection.

## Query cache

`QueryCache` is a provider-neutral port. The local adapter uses an in-process L1 and AES-256-GCM encrypted files in `.data/cache/` as L2. Writes are atomic with private file modes; unreadable or unauthenticated files are removed and treated as misses. Concurrent identical misses share one loader.

Keys are canonical SHA-256 hashes scoped by provider, namespace, schema version, organization, user, Asana credential fingerprint, normalized range, filters, terms or assignee, and projection. Tokens and query text are not exposed in filenames. Open or current ranges expire after 15 minutes; completed historical ranges expire after 24 hours. Expiry is strict in L1, L2, and covering-range reuse: stale values and failed loads are never served or cached.

Routine OAuth refresh preserves the credential fingerprint and existing cache entries. A new authorization creates a fingerprint, so old entries become unreachable without broad deletion. `AsanaSkill.close()` closes the MCP client and calls cache `close()`, which clears L1 and in-flight work while retaining encrypted L2 for a later process.

## Decisions

- **Read-only prototype.** Asana MCP can advertise writes, but tool-name policy removes mutation capabilities. Approval workflows must exist before writes are enabled.
- **Application-managed context.** OpenAI receives explicit conversation and evidence context. This avoids dependence on provider-hosted conversation state.
- **Evidence before prose.** Skills return source, locator, retrieval time, query, and bounded content. Citations refer to these records.
- **Tenant IDs now.** Local storage keys every record by organization and user even though only DEPARTURE is configured.
- **Local storage behind ports.** JSON is appropriate for one local process. PostgreSQL/pgvector and Redis adapters can replace it without changing the agent.
- **Runtime boundaries.** OpenTUI, local OAuth callback, filesystem persistence, and Node vendor SDKs are adapters. They are not imported by core domain types.

## Cloud deployment

The analytical core has no terminal assumptions. A hosted release needs an HTTP adapter, managed secret/token store, PostgreSQL/pgvector storage, Redis jobs, and distributed OAuth callback. `QueryCache` allows the local L1/encrypted-file adapter to be replaced by Redis or another shared cache without changing Asana query services; the same query-service pattern can later support AWS and Notion. Cloudflare deployments would replace Node-specific adapters with Web API-compatible implementations; Railway can use the Docker build. A terminal process itself is not a useful Railway service without an attached TTY.

## Safety and observability

Credentials are environment-only. Asana tokens use AES-256-GCM at rest. Tool and conversation events are append-only and redact common credential patterns. External timeouts, pagination bounds, evidence budgets, and partial failures prevent one integration from controlling the entire answer.
