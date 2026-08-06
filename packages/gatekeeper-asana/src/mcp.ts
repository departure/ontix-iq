import {
  McpAuthRequiredError,
  McpClient,
  McpProtocolError,
  McpSessionExpiredError,
  type McpToolCallResult,
} from "@gadgets/mcp-shared/client";

export const ASANA_MCP_URL = "https://mcp.asana.com/v2/mcp";
/** V2 MCP is authorized by Asana's app OAuth server, not mcp.asana.com/token. */
export const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";
/** Resource indicator from Asana's oauth-protected-resource/v2 metadata. */
export const ASANA_MCP_RESOURCE = "https://mcp.asana.com/v2/mcp";

const TASK_OPT_FIELDS =
  "gid,name,completed,created_at,completed_at,assignee.gid,assignee.name,projects.gid,projects.name,permalink_url";

export type AsanaOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
};

export type AsanaTokenStore = {
  read(): Promise<AsanaOAuthTokens | null>;
  write(tokens: AsanaOAuthTokens): Promise<void>;
};

export type AsanaMcpCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
};

/** Refresh an Asana MCP OAuth access token using the registered client credentials. */
export async function refreshAsanaMcpTokens(
  credentials: AsanaMcpCredentials,
  refreshToken: string,
): Promise<AsanaOAuthTokens> {
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error("Asana Gatekeeper requires ASANA_CLIENT_ID and ASANA_CLIENT_SECRET");
  }
  if (!refreshToken) {
    throw new Error("Asana Gatekeeper requires ASANA_REFRESH_TOKEN (MCP OAuth refresh token)");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    // Ask Asana for an access token audience-bound to the MCP resource when supported.
    resource: ASANA_MCP_RESOURCE,
  });
  const response = await fetch(ASANA_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    // Some Asana OAuth apps reject unknown `resource`; retry without it.
    if (response.status === 400) {
      const retryBody = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      });
      const retry = await fetch(ASANA_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: retryBody,
      });
      if (!retry.ok) {
        throw new Error(`Asana MCP token refresh failed with HTTP ${retry.status}`);
      }
      const retryJson = await retry.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!retryJson.access_token) throw new Error("Asana MCP token refresh returned no access token");
      return {
        accessToken: retryJson.access_token,
        refreshToken: retryJson.refresh_token ?? refreshToken,
        ...(typeof retryJson.expires_in === "number"
          ? { expiresAt: Date.now() + Math.max(retryJson.expires_in - 60, 30) * 1000 }
          : {}),
      };
    }
    throw new Error(`Asana MCP token refresh failed with HTTP ${response.status}`);
  }
  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error("Asana MCP token refresh returned no access token");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    ...(typeof json.expires_in === "number"
      ? { expiresAt: Date.now() + Math.max(json.expires_in - 60, 30) * 1000 }
      : {}),
  };
}

export class AsanaMcpClient {
  #store: AsanaTokenStore;
  #credentials: AsanaMcpCredentials;
  #sessionId: string | null = null;
  #inflightRefresh: Promise<string> | null = null;

  constructor(credentials: AsanaMcpCredentials, store: AsanaTokenStore) {
    this.#credentials = credentials;
    this.#store = store;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.#withAuthRetry((client) => client.callTool(name, args));
  }

  async searchTasks(args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.callTool("search_tasks", {
      opt_fields: TASK_OPT_FIELDS,
      limit: 100,
      ...args,
    });
  }

  async getTask(taskGid: string): Promise<McpToolCallResult> {
    return this.callTool("get_task", {
      task_gid: taskGid,
      opt_fields: TASK_OPT_FIELDS,
    });
  }

  async getTasks(args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.callTool("get_tasks", {
      opt_fields: TASK_OPT_FIELDS,
      limit: 100,
      ...args,
    });
  }

  async getProjects(args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.callTool("get_projects", {
      opt_fields: "gid,name,archived",
      ...args,
    });
  }

  async #withAuthRetry<T>(run: (client: McpClient) => Promise<T>): Promise<T> {
    try {
      return await this.#invoke(run);
    } catch (error) {
      if (!(error instanceof McpAuthRequiredError) && !(error instanceof McpSessionExpiredError)) {
        throw error;
      }
      if (error instanceof McpSessionExpiredError) this.#sessionId = null;
      await this.#forceRefresh();
      return await this.#invoke(run);
    }
  }

  async #invoke<T>(run: (client: McpClient) => Promise<T>): Promise<T> {
    const client = new McpClient(ASANA_MCP_URL, () => this.#accessToken());
    client.sessionId = this.#sessionId;
    if (!this.#sessionId) await client.initialize("ontix-iq-asana");
    try {
      const result = await run(client);
      this.#sessionId = client.sessionId;
      return result;
    } catch (error) {
      this.#sessionId = client.sessionId;
      if (error instanceof McpProtocolError && error.message.includes("isError")) throw error;
      throw error;
    }
  }

  async #accessToken(): Promise<string> {
    const stored = await this.#store.read();
    if (stored?.accessToken && (!stored.expiresAt || stored.expiresAt > Date.now())) {
      return stored.accessToken;
    }
    if (this.#credentials.accessToken && !stored) {
      return this.#credentials.accessToken;
    }
    return this.#forceRefresh();
  }

  #forceRefresh(): Promise<string> {
    if (this.#inflightRefresh) return this.#inflightRefresh;
    this.#inflightRefresh = (async () => {
      const current = await this.#store.read();
      const refreshToken = current?.refreshToken || this.#credentials.refreshToken;
      const tokens = await refreshAsanaMcpTokens(this.#credentials, refreshToken);
      await this.#store.write(tokens);
      return tokens.accessToken;
    })().finally(() => {
      this.#inflightRefresh = null;
    });
    return this.#inflightRefresh;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractMcpText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .join("\n");
}

export function extractDataRows(result: unknown): unknown[] {
  if (isRecord(result) && result.isError === true) {
    throw new Error(`Asana MCP tool failed: ${extractMcpText(result)}`);
  }
  if (isRecord(result) && isRecord(result.structuredContent)) {
    const payload = result.structuredContent;
    if (Array.isArray(payload.data)) return payload.data;
    if (typeof payload.gid === "string") return [payload];
  }
  const text = extractMcpText(result);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.data)) return parsed.data;
    if (isRecord(parsed) && typeof parsed.gid === "string") return [parsed];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("Asana MCP tool returned an unrecognized response");
}
