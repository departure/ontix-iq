# Deployment

## Run in the terminal

Requirements: macOS/Linux, Node.js 26.4 or newer, npm, and an interactive terminal.

```bash
npm install
npm run setup
```

Edit `.env` with the OpenAI, AWS, Notion, and Asana values. The Asana app must be an MCP app, distributed to the DEPARTURE workspace, with this exact redirect URL:

```text
http://127.0.0.1:3334/oauth/callback
```

Authorize and validate:

```bash
npm run auth:asana
npm run doctor
```

Launch the chatbot:

```bash
npm run dev
```

Use `/help` in the terminal. Production-compiled launch:

```bash
npm run build
npm start
```

OpenTUI uses Node's native FFI renderer. The npm scripts supply `--experimental-ffi`; launching the JavaScript file directly without that flag will fail.

## Docker

```bash
docker compose build
docker compose run --rm ontix-iq
```

The Compose service allocates a TTY and persists encrypted OAuth tokens and local memory in a named volume. Complete Asana authorization on the host first or expose a callback appropriate to the container.

## Railway

`railway.json` and the Dockerfile are build-compatible, but this release's only interface is interactive terminal I/O. A normal Railway web service has no end-user TTY. Deploy the future HTTP adapter rather than treating a continuously running terminal process as production hosting.

Configure all environment variables in Railway; do not upload `.env`. Use a persistent volume for `ONTIX_DATA_DIR` until PostgreSQL and a managed token store are implemented.

## Cloudflare Temporary Accounts

The core interfaces are portable, but this Node terminal artifact is not a Workers application. A Cloudflare release must provide Web API adapters for model calls, OAuth callback, storage, and vendor connectivity. No core agent or evidence contract needs to change.

## Troubleshooting

- **Asana client not found/workspace unavailable:** verify MCP app type, distribution workspace, V2 endpoint, and exact callback URL.
- **Asana says not authorized:** run `npm run auth:asana`; deleting `.data/secrets/asana-tokens.json` forces a clean flow.
- **AWS costs unavailable:** enable Cost Explorer and grant billing read access.
- **Notion returns little data:** share relevant pages and data sources with the integration.
- **Doctor reports model error:** verify `OPENAI_MODEL` is available to the API key.
- **Terminal error:** confirm `node --version` is at least 26.4 and run through npm scripts.
