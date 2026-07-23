import { createServer } from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { readConfig } from "../config.js";
import { AsanaOAuthProvider } from "../../skills/asana/auth/provider.js";

const config = readConfig();
if (!config.asana.clientId || !config.asana.clientSecret) {
  throw new Error("ASANA_CLIENT_ID and ASANA_CLIENT_SECRET are required in .env");
}

const provider = new AsanaOAuthProvider(config);
const callback = config.asana.callbackUrl;
const server = createServer((request, response) => {
  void handleCallback(request.url ?? "/")
    .then(() => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Ontix IQ is authorized. You can close this window.");
    })
    .catch((error) => {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Authorization failed");
    });
});

async function handleCallback(requestUrl: string): Promise<void> {
  const url = new URL(requestUrl, callback);
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Asana denied authorization: ${error}`);
  provider.verifyState(url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Asana did not return an authorization code");
  const result = await auth(provider, {
    serverUrl: config.asana.serverUrl,
    authorizationCode: code,
  });
  if (result !== "AUTHORIZED") throw new Error("Asana authorization did not complete");
  process.stdout.write("Asana authorization saved securely.\n");
  setTimeout(() => server.close(), 50);
}

server.listen(Number(callback.port), callback.hostname, async () => {
  process.stdout.write(`Waiting for Asana at ${callback.toString()}\n`);
  try {
    const result = await authorizeWithExpiredTokenRecovery();
    if (result === "AUTHORIZED") {
      process.stdout.write("Asana is already authorized.\n");
      server.close();
    }
  } catch (error) {
    server.close();
    throw error;
  }
});

async function authorizeWithExpiredTokenRecovery() {
  try {
    return await auth(provider, { serverUrl: config.asana.serverUrl });
  } catch (error) {
    if (!isInvalidGrant(error)) throw error;
    process.stdout.write("Stored Asana authorization expired; reconnecting.\n");
    await provider.invalidateCredentials("tokens");
    return auth(provider, { serverUrl: config.asana.serverUrl });
  }
}

function isInvalidGrant(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "InvalidGrantError" ||
    /\binvalid[_ ]grant\b|\brefresh_token\b.*\binvalid\b/i.test(error.message)
  );
}
