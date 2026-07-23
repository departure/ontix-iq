# Asana

Reads projects, tasks, milestones, project managers, client work, and resource allocation through the official Asana MCP V2 server.

## Authentication

OAuth 2.0 Authorization Code with PKCE. The app must be configured as an MCP app and distributed to the customer's workspace. Run `npm run auth:asana` once before use.
Expired access tokens are refreshed once and the failed read is retried, including when
expiration is reported inside an MCP tool result during a long paginated analysis.
Rate-limited reads honor Asana's requested delay and resume the active cursor.

Routine token refresh preserves the authorization fingerprint and its warm datasets. A
new browser authorization creates a fingerprint, so prior cache entries cannot be reused
by the new credential.

## Query pipeline

Analytical tool handlers are thin evidence adapters. They send normalized specifications
to created-task or assigned-task query services, which check the cache before calling the
retrieval module. Retrieval owns MCP response parsing, exhaustive timestamp scans,
assigned-task pagination, GID deduplication, and retries. Time helpers own timezone-aware
ranges and calendar buckets. Pure analytics functions group the resulting datasets and
calculate percentages, averages, and forecasts.

The implementation is physically split across `tools/`, `queries/`, `retrieval/`, `time/`,
and `analytics/`. `index.ts` preserves the public exports.

## Dataset cache

The query cache has an in-process memory L1 and an AES-256-GCM encrypted file L2 under
`.data/cache/`. Stable hashed keys include provider and schema version, organization,
user, authorization fingerprint, normalized range and filters, and the requested term,
assignee, or projection. Concurrent identical misses share one retrieval.

Open or current ranges have a 15-minute TTL; completed historical ranges have a 24-hour
TTL. Expiry is strict: stale entries are removed and never served, and retrieval failures
are not cached. Corrupt or unauthenticated L2 files are treated as misses.

Created-task timelines can satisfy fresh narrower ranges by local slicing. Full-text
terms are cached independently and unioned locally across topics or services. Heavier
project/parent data and paginated assignee projections use separate entries. Evidence
reports cache `hit`, `tier` (`memory`, `disk`, or `loader`), `ageMs`, and the underlying
`queryCount`.

Closing the skill closes the MCP client and clears memory L1 and in-flight cache work;
encrypted L2 remains available after restart. The provider-neutral cache contract can
later use Redis or another shared store, and the same query-service approach can be
adopted by AWS and Notion.

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

Topic-percentage questions use `asana__analyze_task_mentions`. It exhaustively searches
each supplied full-text term within the calendar year, unions matching task GIDs across
synonyms, and divides by the exhaustive created-task total. The result measures mentions
in Asana task names, descriptions, and comments; it is not a semantic work classification.

Created-task period comparisons use `asana__compare_created_task_periods`. Inclusive
business dates are converted to exact timestamps in the organization's time zone, each
period is counted exhaustively, and absolute and percentage changes are returned.

Monthly-average questions use `asana__analyze_monthly_task_averages`. It counts calendar
months through an efficient creation-time cursor scan, supports partial years, and returns
exact yearly and combined completed-year baselines without repeated full-year searches.

Future busiest-quarter questions use `asana__forecast_busiest_quarter`. It calculates exact
historical quarter counts, normalizes each quarter by its year's total, and reports the
seasonal winner with confidence and conflicting historical signals.

Service-growth questions use `asana__forecast_service_growth`. Organization-approved
keywords are unioned per service, mixed matches are reported, and full and partial years
are compared using monthly task rates before a forecast winner is selected.
