# Ontix IQ for Art Bradshaw

Ontix IQ is DEPARTURE’s branded, organization-aware Cloudflare OS deployment. It runs as a browser workspace locally and is configured for `art.ontixiq.com` on Cloudflare.

```bash
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm dev
```

Then open `http://localhost:8787`.

This repository owns customer context, executive skills, read-only Asana and AWS Gatekeepers, the simulated QuickBooks Gatekeeper, deployment controls, and upgrade validation. The upstream Cloudflare OS source remains pinned in a submodule.

See `REQUIREMENTS.md`, `Architecture.md`, and `Deployment.md` for the product contract, trust boundaries, and operator runbook.
