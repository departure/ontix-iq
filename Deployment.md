# Deployment

## Local browser application

Requirements: Node.js 24+, pnpm 11, and Git.

```bash
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm dev
```

Open `http://localhost:8787`. The wrapper temporarily introduces the Ontix Gatekeepers to the pinned upstream local runner and removes those links when it exits. Local Cloudflare state lives under `cloudflare-os/.wrangler`.

The wrapper reads the existing untracked `.env` without printing values. AWS variables are mapped into the AWS Worker. The Asana Gatekeeper needs `ASANA_ACCESS_TOKEN` and `ASANA_WORKSPACE_GID`; the former TUI’s encrypted MCP OAuth session cannot safely be copied into a Worker. Add those variables locally or complete the dedicated OAuth connection flow in a future sprint. QuickBooks and organization context require no credentials.

Cloudflare OS manages model-provider credentials in its own UI. The existing `OPENAI_API_KEY` is not copied into agent-visible configuration.

## Validate

```bash
pnpm test
pnpm typecheck
pnpm check
```

`pnpm check` builds all Workers and performs deployment dry runs. Active Cloudflare account and Access values are required in `deployment.jsonc`; placeholders intentionally make production validation fail early rather than deploy to the wrong account.

## Production at art.ontixiq.com

1. Create a Cloudflare Access self-hosted application for `art.ontixiq.com`.
2. Fill in `accountId`, Access issuer, audience, admin email, and optional AI Gateway values in `deployment.jsonc`.
3. Install Worker secrets interactively—never place them in `deployment.jsonc`:

```bash
pnpm exec wrangler secret put ASANA_ACCESS_TOKEN --config packages/gatekeeper-asana/wrangler.jsonc
pnpm exec wrangler secret put AWS_ACCESS_KEY --config packages/gatekeeper-aws/wrangler.jsonc
pnpm exec wrangler secret put AWS_ACCESS_KEY_SECRET --config packages/gatekeeper-aws/wrangler.jsonc
```

Set `ASANA_WORKSPACE_GID` and `AWS_REGIONS` as non-secret Worker variables in the production generated configuration before deployment automation is finalized. Then authenticate and deploy:

```bash
pnpm exec wrangler login
pnpm check
pnpm deploy
```

The deploy script builds and deploys the private error reporter, upstream Context Worker, all Ontix Gatekeepers, and finally the Workshop Worker. Wrangler creates DNS/TLS for `art.ontixiq.com` and can automatically provision the configured KV/R2 resources.

After deployment, sign in, open `/admin`, set the Ontix IQ branding, enable the organization and connector Gatekeepers, introduce them to Art’s agent, and verify that reads appear as observations.

## Upgrades and rollback

Update only the pinned `cloudflare-os` submodule commit. Review upstream security and migration notes, run all validation, test on a staging hostname, then promote. Use Cloudflare deployment history or `wrangler rollback` if verification fails.
