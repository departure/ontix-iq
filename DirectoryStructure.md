# Directory structure

```text
cloudflare-os/                   pinned upstream browser workspace
branding/                        site name, logo, accent, CSS overrides
packages/
  custom-gatekeeper/             canonical ORGANIZATION.md capability
  gatekeeper-asana/              read-only Asana Worker
  gatekeeper-quickbooks/         fixed synthetic QuickBooks Worker
  gatekeeper-aws/                read-only AWS Worker
  error-reporter/                private structured error Worker
scripts/
  run-local.mjs                  local wrapper and secret handoff
  apply-branding.mjs             inject branding/overrides.css into frontend dist
  deploy.mjs                     validation and ordered Cloudflare deploy
skills/                          Ontix executive usage guidance
ORGANIZATION.md                  canonical editable company source
deployment.jsonc                non-secret deployment source of truth
REQUIREMENTS.md                  product acceptance contract
Architecture.md                 trust boundaries and request flow
Deployment.md                   local and production runbook
src/, tests/                     preserved TUI migration reference
```

Generated `.wrangler`, `.dev.vars`, distribution, and production Wrangler files are ignored. Gatekeeper `types.d.ts` files are both RPC contracts and agent-facing API documentation; the build synchronizes their runtime text representation.
