# Ontix IQ for Art Bradshaw

Ontix IQ is DEPARTURE’s branded, organization-aware Cloudflare OS deployment. It runs as a browser workspace locally and is configured for `art.ontixiq.com` on Cloudflare.

```bash
pnpm start
```

Then open `http://localhost:8787`. That initializes the Cloudflare OS submodule, installs dependencies, and starts the local server. For a warm checkout, `pnpm dev` skips install and only runs the server. Press `q` in the terminal to stop everything.

This repository owns customer context, executive skills, read-only Asana and AWS Gatekeepers, the simulated QuickBooks Gatekeeper, deployment controls, and upgrade validation. The upstream Cloudflare OS source remains pinned in a submodule.

See `REQUIREMENTS.md`, `Architecture.md`, and `Deployment.md` for the product contract, trust boundaries, and operator runbook.
