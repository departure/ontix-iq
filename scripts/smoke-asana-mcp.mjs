/**
 * Standalone Asana MCP smoke test (no Worker bundler). Does not print secrets.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_URL = "https://mcp.asana.com/v2/mcp";
const PROTOCOL = "2025-06-18";

function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const value = line.trim();
        if (!value || value.startsWith("#") || !value.includes("=")) return [];
        const i = value.indexOf("=");
        return [[value.slice(0, i).trim(), value.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]];
      }),
  );
}

function loadLocalTokens(env) {
  const dataDir = env.ONTIX_DATA_DIR || join(root, ".data");
  const tokenPath = join(dataDir, "secrets", "asana-tokens.json");
  const keyPath = join(dataDir, "secrets", "local-token.key");
  if (!existsSync(tokenPath)) return null;
  let key;
  if (env.ONTIX_TOKEN_ENCRYPTION_KEY) {
    key = createHash("sha256").update(env.ONTIX_TOKEN_ENCRYPTION_KEY).digest();
  } else if (existsSync(keyPath)) {
    key = Buffer.from(readFileSync(keyPath, "utf8"), "base64");
  } else return null;
  if (key.length !== 32) return null;
  const payload = JSON.parse(readFileSync(tokenPath, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  const decrypted = JSON.parse(plaintext.toString("utf8"));
  const tokens = decrypted.tokens ?? decrypted;
  if (!tokens.refresh_token) return null;
  return {
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token,
  };
}

async function refresh(clientId, clientSecret, refreshToken) {
  const attempts = [
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      resource: "https://mcp.asana.com/v2/mcp",
    }),
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  ];
  let lastStatus = 0;
  for (const body of attempts) {
    const response = await fetch("https://app.asana.com/-/oauth_token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    lastStatus = response.status;
    if (!response.ok) continue;
    const json = await response.json();
    if (!json.access_token) throw new Error("refresh returned no access_token");
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || refreshToken,
    };
  }
  throw new Error(`token refresh HTTP ${lastStatus}`);
}

async function readSseOrJson(response, id) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    for (const block of text.split(/\n\n+/)) {
      const data = block
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.id === id) return parsed;
      } catch {
        // ignore
      }
    }
    throw new Error("SSE stream contained no matching response");
  }
  return await response.json();
}

function createClient(getAccessToken) {
  let sessionId = null;
  let requestId = 0;
  async function post(body) {
    const token = await getAccessToken();
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
    if (response.status === 401) throw new Error("MCP_AUTH_REQUIRED");
    const next = response.headers.get("mcp-session-id");
    if (next) sessionId = next;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status} for ${body.method}`);
    return readSseOrJson(response, body.id);
  }
  async function call(method, params) {
    const id = ++requestId;
    const parsed = await post({ jsonrpc: "2.0", id, method, params });
    if (parsed.error) throw new Error(`${method}: ${parsed.error.message}`);
    return parsed.result;
  }
  return {
    async initialize() {
      await call("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "ontix-iq-smoke", version: "1.0.0" },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
    },
    callTool(name, args) {
      return call("tools/call", { name, arguments: args });
    },
    listTools() {
      return call("tools/list", {});
    },
  };
}

function extractRows(result) {
  if (result?.isError) throw new Error(extractText(result));
  const payload = result?.structuredContent;
  if (payload && Array.isArray(payload.data)) return { rows: payload.data, next: payload.next_page?.offset };
  if (payload && typeof payload.gid === "string") return { rows: [payload], next: undefined };
  try {
    const parsed = JSON.parse(extractText(result));
    if (Array.isArray(parsed?.data)) return { rows: parsed.data, next: parsed.next_page?.offset };
    if (typeof parsed?.gid === "string") return { rows: [parsed], next: undefined };
  } catch {
    // fall through
  }
  throw new Error("unrecognized tool payload");
}

function extractText(result) {
  if (!Array.isArray(result?.content)) return JSON.stringify(result);
  return result.content.map((item) => (item?.type === "text" ? item.text : JSON.stringify(item))).join("\n");
}

async function main() {
  const env = loadEnv(join(root, ".env"));
  const local = loadLocalTokens(env);
  const clientId = env.ASANA_CLIENT_ID || "";
  const clientSecret = env.ASANA_CLIENT_SECRET || "";
  const workspace = env.ASANA_WORKSPACE_GID || "";
  let accessToken = local?.accessToken || "";
  let refreshToken = env.ASANA_REFRESH_TOKEN || local?.refreshToken || "";

  console.log(JSON.stringify({
    hasClientId: Boolean(clientId),
    hasClientSecret: Boolean(clientSecret),
    hasWorkspace: Boolean(workspace),
    hasRefresh: Boolean(refreshToken),
    hasAccessBootstrap: Boolean(accessToken),
    source: env.ASANA_REFRESH_TOKEN ? "env" : local ? "local-store" : "missing",
  }));

  if (!clientId || !clientSecret || !refreshToken || !workspace) {
    throw new Error("Missing Asana MCP credentials or workspace");
  }

  const getAccessToken = async () => {
    if (accessToken) return accessToken;
    const refreshed = await refresh(clientId, clientSecret, refreshToken);
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    console.log("refreshed access token");
    return accessToken;
  };

  // Prefer a fresh token up front — stored access tokens are often expired.
  {
    const refreshed = await refresh(clientId, clientSecret, refreshToken);
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    console.log("initial token refresh ok");
  }

  const client = createClient(getAccessToken);
  await client.initialize();
  console.log("initialize ok");

  const tools = await client.listTools();
  const names = (tools.tools || []).map((tool) => tool.name).sort();
  console.log(`tools (${names.length}): ${names.join(", ")}`);

  const projects = extractRows(await client.callTool("get_projects", {
    workspace,
    limit: 5,
    archived: false,
  }));
  console.log(`get_projects ok rows=${projects.rows.length}`);

  let robertGid;
  try {
    const users = extractRows(await client.callTool("get_workspace_users", {
      workspace,
      opt_fields: "gid,name,email",
    }));
    for (const row of users.rows) {
      if (/robert\s+palmer/i.test(String(row.name || ""))) {
        robertGid = String(row.gid);
        console.log(`matched user name=${row.name}`);
        break;
      }
    }
    if (!robertGid) console.log(`workspace users scanned=${users.rows.length}; no Robert Palmer`);
  } catch (error) {
    console.log(`get_workspace_users: ${error.message}`);
  }

  if (!robertGid) {
    const search = await client.callTool("search_objects", {
      query: "Robert Palmer",
      resource_type: "user",
      workspace,
    });
    console.log(`search_objects preview=${extractText(search).slice(0, 180)}`);
    try {
      const rows = extractRows(search).rows;
      const hit = rows.find((row) => /robert\s+palmer/i.test(String(row.name || "")));
      if (hit?.gid) {
        robertGid = String(hit.gid);
        console.log("matched via search_objects");
      }
    } catch (error) {
      console.log(`search_objects parse: ${error.message}`);
    }
  }

  if (!robertGid) throw new Error("Could not resolve Robert Palmer");

  const assigned = [];
  let offset;
  let pages = 0;
  do {
    const result = await client.callTool("get_tasks", {
      assignee: robertGid,
      completed: false,
      limit: 100,
      opt_fields: "gid,name,completed,assignee.gid,assignee.name",
      ...(offset ? { offset } : {}),
    });
    const page = extractRows(result);
    pages += 1;
    assigned.push(...page.rows);
    offset = page.next;
    if (pages > 50) throw new Error("pagination exceeded 50 pages");
  } while (offset);

  // Also exercise search_tasks the way the Gatekeeper session does.
  const searched = extractRows(await client.callTool("search_tasks", {
    workspace,
    assignee_any: robertGid,
    completed: false,
    limit: 100,
    opt_fields: "gid,name,completed,assignee.gid,assignee.name",
  }));

  console.log(JSON.stringify({
    ok: true,
    incompleteAssignedViaGetTasks: assigned.length,
    pages,
    incompleteViaSearchTasksPage: searched.rows.length,
    sampleNames: assigned.slice(0, 5).map((task) => String(task.name || "")),
  }, null, 2));
}

main().catch((error) => {
  console.error("SMOKE_FAILED", error.message || String(error));
  process.exitCode = 1;
});
