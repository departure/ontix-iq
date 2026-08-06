# Architecture

Ontix IQ is a wrapper-managed Cloudflare OS deployment, not a standalone chatbot runtime.

```text
Art's browser
    │ Cloudflare Access
    ▼
Cloudflare OS Workshop (art.ontixiq.com)
    ├── Workspace Durable Objects and agent sandbox
    ├── ORGANIZATION Gatekeeper ── packaged ORGANIZATION.md
    ├── ASANA Gatekeeper ───────── Asana REST API
    ├── QUICKBOOKS Gatekeeper ──── fixed synthetic dataset
    ├── AWS Gatekeeper ─────────── AWS read-only APIs
    └── Context / Scheduler / Gadget hooks supplied upstream
```

## Ownership boundary

`cloudflare-os/` is a pinned upstream Git submodule. Ontix owns `deployment.jsonc`, deployment/local scripts, customer context, Gatekeeper Workers, skills, tests, and documentation. Customer changes must not be made inside the submodule; upstream updates are reviewed by changing the pinned commit.

## Request flow

1. Cloudflare Access authenticates Art in production; local mode uses the upstream development account.
2. Cloudflare OS creates or resumes Art's workspace and agent.
3. Agent instructions and the organization capability ground interpretation in DEPARTURE context.
4. The agent requests only the Gatekeeper capabilities relevant to the question.
5. Each Gatekeeper authorizes and records the observation before calling a provider or reading simulation data.
6. The agent synthesizes a direct answer from returned structured data and states gaps or simulation status.

Agents and generated Gadgets never receive provider credentials. Gatekeeper Workers own secrets and expose narrow Cap'n Web RPC interfaces. There are no write methods in this release, so the approval queue cannot be bypassed accidentally by an apparently harmless helper.

## Persistence and future work

Cloudflare OS supplies Durable Object workspace state, Gadget isolation, Blueprint support, scheduler Gatekeeper, observation history, and approval infrastructure. They remain available but product-specific dashboards and recurring briefs are deferred. Agent guidance for each capability lives in `skills/*/SKILL.md`; Gatekeeper Workers under `packages/` own credentials and observation APIs.
