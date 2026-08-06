import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv(path) {
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").flatMap((line) => {
    const value = line.trim();
    if (!value || value.startsWith("#") || !value.includes("=")) return [];
    const i = value.indexOf("=");
    return [[value.slice(0, i).trim(), value.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]];
  }));
}

function loadLocalTokens(env) {
  const dataDir = env.ONTIX_DATA_DIR || ".data";
  const tokenPath = join(dataDir, "secrets", "asana-tokens.json");
  const keyPath = join(dataDir, "secrets", "local-token.key");
  const key = env.ONTIX_TOKEN_ENCRYPTION_KEY
    ? createHash("sha256").update(env.ONTIX_TOKEN_ENCRYPTION_KEY).digest()
    : Buffer.from(readFileSync(keyPath, "utf8"), "base64");
  const payload = JSON.parse(readFileSync(tokenPath, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  const decrypted = JSON.parse(plaintext.toString("utf8"));
  return decrypted.tokens ?? decrypted;
}

const env = loadEnv(".env");
const tokens = loadLocalTokens(env);
const body = new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: tokens.refresh_token,
  client_id: env.ASANA_CLIENT_ID,
  client_secret: env.ASANA_CLIENT_SECRET,
});
const tok = await (await fetch("https://app.asana.com/-/oauth_token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
})).json();

let sessionId = null;
let id = 0;

async function call(method, params) {
  id += 1;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    authorization: `Bearer ${tok.access_token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch("https://mcp.asana.com/v2/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const ct = res.headers.get("content-type") || "";
  let parsed;
  if (ct.includes("event-stream")) {
    const text = await res.text();
    for (const block of text.split(/\n\n+/)) {
      const data = block
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const candidate = JSON.parse(data);
        if (candidate.id === id) {
          parsed = candidate;
          break;
        }
      } catch {
        // ignore
      }
    }
  } else {
    parsed = await res.json();
  }
  if (!parsed) throw new Error("no response");
  if (parsed.error) throw new Error(parsed.error.message);
  return parsed.result;
}

await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "findusers", version: "1" },
});
await fetch("https://mcp.asana.com/v2/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    authorization: `Bearer ${tok.access_token}`,
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});

for (const name of ["get_users", "search_objects"]) {
  try {
    const args = name === "search_objects"
      ? { query: "Robert Palmer", resource_type: "user", workspace: env.ASANA_WORKSPACE_GID }
      : { workspace: env.ASANA_WORKSPACE_GID, opt_fields: "gid,name,email" };
    const result = await call("tools/call", { name, arguments: args });
    const payload = result.structuredContent;
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : payload?.gid
        ? [payload]
        : [];
    const hit = rows.find((row) => /robert\s+palmer/i.test(String(row.name || "")));
    console.log(JSON.stringify({
      tool: name,
      isError: Boolean(result.isError),
      rowCount: rows.length,
      matched: Boolean(hit),
      matchedName: hit?.name || null,
    }));
  } catch (error) {
    console.log(JSON.stringify({ tool: name, threw: String(error.message || error).slice(0, 160) }));
  }
}
