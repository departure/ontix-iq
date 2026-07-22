# Architecture

## Purpose

Ontix IQ is an executive intelligence runtime, not a vendor-specific chatbot. The prototype uses a terminal adapter, but its agent and skills are independent of OpenTUI and can later be called from an HTTP API and Nuxt application.

## Request flow

1. The terminal creates a tenant, user, and conversation context.
2. The agent loads recent conversation, relevant memory, and `ORGANIZATION.md`.
3. The model returns a typed clarification, research plan, or answer-ready decision.
4. The skill registry executes bounded read tools. Vendor results become normalized evidence.
5. The model synthesizes an answer from evidence, cites exact evidence IDs, and reports gaps.
6. Conversation and audit records are persisted under the tenant scope.

The agent cannot access vendor clients. All external access crosses the `Skill` interface. The registry records each execution and converts failures into partial-result metadata.

## Decisions

- **Read-only prototype.** Asana MCP can advertise writes, but tool-name policy removes mutation capabilities. Approval workflows must exist before writes are enabled.
- **Application-managed context.** OpenAI receives explicit conversation and evidence context. This avoids dependence on provider-hosted conversation state.
- **Evidence before prose.** Skills return source, locator, retrieval time, query, and bounded content. Citations refer to these records.
- **Tenant IDs now.** Local storage keys every record by organization and user even though only DEPARTURE is configured.
- **Local storage behind ports.** JSON is appropriate for one local process. PostgreSQL/pgvector and Redis adapters can replace it without changing the agent.
- **Runtime boundaries.** OpenTUI, local OAuth callback, filesystem persistence, and Node vendor SDKs are adapters. They are not imported by core domain types.

## Cloud deployment

The analytical core has no terminal assumptions. A hosted release needs an HTTP adapter, managed secret/token store, PostgreSQL/pgvector storage, Redis jobs, and distributed OAuth callback. Cloudflare deployments would replace Node-specific adapters with Web API-compatible implementations; Railway can use the Docker build. A terminal process itself is not a useful Railway service without an attached TTY.

## Safety and observability

Credentials are environment-only. Asana tokens use AES-256-GCM at rest. Tool and conversation events are append-only and redact common credential patterns. External timeouts, pagination bounds, evidence budgets, and partial failures prevent one integration from controlling the entire answer.
