# Skills

Skills are independently documented integrations registered through a common interface. Each exposes model-visible JSON schemas, executes with tenant context, returns normalized evidence, and implements a non-destructive health check.

## Asana

Uses the official V2 MCP Streamable HTTP endpoint. OAuth uses a pre-registered MCP client, PKCE, refresh tokens, and an exact local callback URL. Tool discovery occurs through `tools/list`; mutation-like tool names are excluded.

## AWS

Uses AWS SDK v3 with the configured read-only IAM identity. It provides:

- actual cost and amortized cost by period/service
- Reserved Instance and Savings Plans utilization
- EC2, RDS, S3, CloudFront, and WAF inventory

Cost data can lag. Billing APIs may need permissions beyond IAM `ReadOnlyAccess`.

## Notion

Uses Notion search to identify shared pages and data sources, recursively reads bounded page blocks, and queries structured data sources. Only objects shared with the integration are visible.

## Adding a skill

Create `skills/<name>/manifest.json`, `SKILL.md`, and a `Skill` implementation. Register the instance in `src/app.ts`. This manual registration is the only prototype limitation; a future package loader should validate signed manifests before dynamic import.

## Evidence contract

Evidence includes a stable per-answer ID, source, title, locator, retrieval timestamp, summary, optional structured data, and original query. The synthesis prompt may cite only IDs supplied in this collection.

## TODO

Action-capable skills remain disabled until capability-level permissions, previews, user approvals, idempotency, and action audit records are implemented.
