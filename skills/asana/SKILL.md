# Asana

Reads projects, tasks, milestones, project managers, client work, and resource allocation through the official Asana MCP V2 server.

## Authentication

OAuth 2.0 Authorization Code with PKCE. The app must be configured as an MCP app and distributed to the customer's workspace. Run `npm run auth:asana` once before use.

## Safety

Ontix IQ discovers tools at runtime but rejects names that indicate mutation. Write access remains disabled until approval workflows are implemented and audited.

## Evidence

MCP responses are normalized into cited Asana evidence. Permissions never exceed those of the authorizing Asana user.
