# Ontix IQ requirements

**Release:** Cloudflare OS migration sprint
**Customer:** DEPARTURE
**Primary user:** Art Bradshaw
**Production hostname:** `art.ontixiq.com`

## Product outcome

Ontix IQ is a managed, customer-specific Cloudflare OS distribution that gives an executive a secure browser workspace grounded in company knowledge and connected business systems. This installation must let Art ask meaningful business questions, obtain evidence-backed answers, and understand uncertainty without using a terminal.

## Platform

- Pin upstream `cloudflare/cloudflare-os` as a Git submodule; do not patch upstream for customer behavior.
- Own branding, context, Gatekeepers, deployment controls, and upgrade validation in this repository.
- Run the complete browser stack locally with one command and deploy it to Cloudflare Workers.
- Use Cloudflare Access for production identity and `/admin` for runtime branding and connector availability.
- Keep each customer in a separate deployment and hostname.

## Knowledge and answer behavior

- Package `ORGANIZATION.md` as canonical, read-only organization context available to every conversation and future workflow.
- Speak directly to Art, lead with the answer, separate facts from recommendations, cite observations, and identify material gaps.
- Preserve the prior TUI’s evidence-first behavior and distinctions between verified zero results, capped samples, and retrieval failures.
- Keep conversation/workspace state in Cloudflare OS Durable Objects and its existing storage boundaries.

## Integrations

All external access must cross a Gatekeeper. Credentials must remain in local `.dev.vars` files or Cloudflare Worker secrets and must never reach an agent, Gadget, log, source file, or tracked deployment configuration.

- **Asana:** read-only task and project retrieval. This sprint exposes no mutation API. Production uses a dedicated credential and workspace GID; OAuth connection UI is deferred.
- **QuickBooks:** fixed, deterministic synthetic dataset only. Every financial answer must label it as simulated.
- **AWS:** least-privilege read-only identity, Cost Explorer, commitment utilization, EC2, RDS, and S3 observations. No mutation API may exist.

Every read must call the Cloudflare OS observation authorization API so it appears in the audit experience. Future writes must use staged actions and explicit approval; adding a direct side-effecting method is prohibited.

## Deferred but enabled

Dashboard polish, Gadgets, Blueprints, scheduled briefs, recurring tasks, and proactive notifications are deferred. The upstream Gadget, Blueprint, scheduler, approvals, and observation infrastructure must remain enabled so later sprints can add them without another platform migration.

## Acceptance criteria

- `pnpm dev` opens Cloudflare OS locally in a browser.
- Organization, Asana, QuickBooks, and AWS capabilities are discoverable and auditable.
- Art can receive meaningful organization-grounded answers; configured Gatekeepers can contribute observed evidence.
- `pnpm test`, `pnpm typecheck`, and `pnpm check` pass without exposing credentials.
- Production configuration targets `art.ontixiq.com`, with remaining account/Access identifiers documented as operator-supplied values.

## Security constraints

- Zero hardcoded credentials.
- Read-only connector surface for this sprint.
- Capability-scoped access and observation logging for every external read.
- Cloudflare Access protects production before requests reach the Workshop Worker.
- Upstream upgrades are pinned, reviewed, tested, and rolled out deliberately.
