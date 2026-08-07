# Ontix IQ for Art Bradshaw

Ontix IQ is DEPARTURE’s branded, organization-aware Cloudflare OS deployment. It runs as a browser workspace locally and is configured for `art.ontixiq.com` on Cloudflare.

```bash
pnpm start
```

That verifies/installs toolchain dependencies (Homebrew on macOS/Linux when needed, plus Git, Node.js 24+, and pnpm 11), initializes the Cloudflare OS submodule, installs package deps, starts the local server, and opens `http://localhost:8787`. For a warm checkout, `pnpm dev` skips the toolchain bootstrap and only runs the server. The terminal keeps `press q to quit` pinned at the bottom; press `q` to stop everything.

This repository owns customer context, executive skills, read-only Asana and AWS Gatekeepers, the simulated QuickBooks Gatekeeper, deployment controls, and upgrade validation. The upstream Cloudflare OS source remains pinned in a submodule.

See `REQUIREMENTS.md`, `Architecture.md`, and `Deployment.md` for the product contract, trust boundaries, and operator runbook.
