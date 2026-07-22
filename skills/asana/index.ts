import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../../src/config.js";
import type {
  DoctorResult,
  Evidence,
  Skill,
  SkillToolDefinition,
} from "../../src/core/types.js";
import { redact, truncate } from "../../src/core/security.js";
import { AsanaOAuthProvider } from "./auth/provider.js";

const mutatingName =
  /(?:^|_)(?:create|update|delete|remove|add|set|move|duplicate|comment|attach)(?:_|$)/i;

export function isReadOnlyAsanaTool(name: string): boolean {
  return !mutatingName.test(name);
}

export class AsanaSkill implements Skill {
  readonly name = "asana" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private cachedTools?: SkillToolDefinition[];
  private readonly oauth: AsanaOAuthProvider;

  constructor(private readonly config: AppConfig) {
    this.oauth = new AsanaOAuthProvider(config);
  }

  async tools(): Promise<SkillToolDefinition[]> {
    if (!this.config.asana.clientId || !this.config.asana.clientSecret) return [];
    if (this.cachedTools) return this.cachedTools;
    const client = await this.connect();
    const tools: SkillToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const response = await client.listTools(cursor ? { cursor } : {});
      for (const tool of response.tools) {
        if (!isReadOnlyAsanaTool(tool.name)) continue;
        tools.push({
          name: `asana__${tool.name}`,
          skill: this.name,
          description: `Read Asana: ${tool.description ?? tool.name}`,
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
            string,
            unknown
          >,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
    this.cachedTools = tools;
    return tools;
  }

  async execute(
    toolName: string,
    input: unknown,
  ): Promise<Evidence[]> {
    const remoteName = toolName.replace(/^asana__/, "");
    if (remoteName === toolName || !isReadOnlyAsanaTool(remoteName)) {
      throw new Error(`Asana tool is not allowed in read-only mode: ${toolName}`);
    }
    const allowed = await this.tools();
    if (!allowed.some((tool) => tool.name === toolName)) {
      throw new Error(`Asana tool is unavailable or not read-only: ${toolName}`);
    }
    const result = await (await this.connect()).callTool({
      name: remoteName,
      arguments: isRecord(input) ? input : {},
    });
    const text = extractMcpText(result);
    return [
      {
        id: `ASN-${randomUUID().slice(0, 8)}`,
        source: this.name,
        title: `Asana ${remoteName.replaceAll("_", " ")}`,
        locator: "https://app.asana.com/",
        retrievedAt: new Date().toISOString(),
        summary: truncate(redact(text), 14000),
        data: "structuredContent" in result ? result.structuredContent : undefined,
        query: isRecord(input) ? input : {},
      },
    ];
  }

  async doctor(): Promise<DoctorResult> {
    if (!this.config.asana.clientId || !this.config.asana.clientSecret) {
      return { service: "Asana", status: "error", message: "OAuth client credentials are missing" };
    }
    if (!(await this.oauth.tokens())) {
      return {
        service: "Asana",
        status: "warning",
        message: "Not authorized; run npm run auth:asana",
      };
    }
    try {
      const count = (await this.tools()).length;
      return { service: "Asana", status: "ok", message: `${count} read-only MCP tools available` };
    } catch (error) {
      return {
        service: "Asana",
        status: "error",
        message: redact(error instanceof Error ? error.message : error),
      };
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "ontix-iq", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(this.config.asana.serverUrl, {
      authProvider: this.oauth,
    });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    return client;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMcpText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .join("\n");
}
