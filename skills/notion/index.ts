import { randomUUID } from "node:crypto";
import { Client, iteratePaginatedAPI } from "@notionhq/client";
import type { AppConfig } from "../../src/config.js";
import type {
  DoctorResult,
  Evidence,
  Skill,
  SkillToolDefinition,
} from "../../src/core/types.js";
import { redact, truncate } from "../../src/core/security.js";

type CacheEntry = { expiresAt: number; value: string };

export class NotionSkill implements Skill {
  readonly name = "notion" as const;
  private readonly client?: Client;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: AppConfig) {
    if (config.notion.accessToken) this.client = new Client({ auth: config.notion.accessToken });
  }

  async tools(): Promise<SkillToolDefinition[]> {
    if (!this.client) return [];
    return [
      {
        name: "notion_search",
        skill: this.name,
        description:
          "Search Notion knowledge by title, then retrieve the content of the most relevant pages.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 12 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "notion_page",
        skill: this.name,
        description: "Retrieve a Notion page and its nested text content by page ID.",
        inputSchema: {
          type: "object",
          properties: { pageId: { type: "string" } },
          required: ["pageId"],
          additionalProperties: false,
        },
      },
      {
        name: "notion_query_data_source",
        skill: this.name,
        description:
          "Query rows in a Notion data source by ID. Use after search identifies a relevant data source.",
        inputSchema: {
          type: "object",
          properties: {
            dataSourceId: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["dataSourceId"],
          additionalProperties: false,
        },
      },
    ];
  }

  async execute(
    toolName: string,
    input: unknown,
  ): Promise<Evidence[]> {
    if (!this.client) throw new Error("NOTION_ACCESS_TOKEN is not configured");
    if (!isRecord(input)) throw new Error("Notion tool input must be an object");
    if (toolName === "notion_search") {
      if (typeof input.query !== "string") throw new Error("Notion search requires query");
      return this.search(input.query, numberWithin(input.limit, 1, 12, 6));
    }
    if (toolName === "notion_page") {
      if (typeof input.pageId !== "string") throw new Error("Notion page requires pageId");
      return [await this.pageEvidence(input.pageId, "Notion page")];
    }
    if (toolName === "notion_query_data_source") {
      if (typeof input.dataSourceId !== "string") {
        throw new Error("Notion data source query requires dataSourceId");
      }
      return [await this.queryDataSource(input.dataSourceId, numberWithin(input.limit, 1, 100, 50))];
    }
    throw new Error(`Unknown Notion tool: ${toolName}`);
  }

  async doctor(): Promise<DoctorResult> {
    if (!this.client) {
      return { service: "Notion", status: "error", message: "Access token is missing" };
    }
    try {
      const me = await this.client.users.me({});
      return {
        service: "Notion",
        status: "ok",
        message: `Authenticated as ${me.name ?? me.type}`,
      };
    } catch (error) {
      return {
        service: "Notion",
        status: "error",
        message: redact(error instanceof Error ? error.message : error),
      };
    }
  }

  private async search(query: string, limit: number): Promise<Evidence[]> {
    if (!this.client) return [];
    const response = await this.client.search({
      query,
      page_size: Math.min(100, limit * 3),
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
    const candidates = response.results.slice(0, limit);
    const evidence = await Promise.all(
      candidates.map(async (candidate) => {
        const title = objectTitle(candidate);
        if (candidate.object === "page") {
          return this.pageEvidence(candidate.id, title || "Notion page");
        }
        return notionEvidence(
          title || "Notion data source",
          notionUrl(candidate),
          JSON.stringify(candidate),
          { query, object: candidate.object, id: candidate.id },
        );
      }),
    );
    return evidence;
  }

  private async pageEvidence(pageId: string, title: string): Promise<Evidence> {
    if (!this.client) throw new Error("Notion is unavailable");
    const page = await this.client.pages.retrieve({ page_id: pageId });
    const resolvedTitle = objectTitle(page) || title;
    const content = await this.pageText(pageId, 0);
    return notionEvidence(
      resolvedTitle,
      notionUrl(page),
      truncate(content || JSON.stringify(page), 16000),
      { pageId },
    );
  }

  private async pageText(blockId: string, depth: number): Promise<string> {
    if (!this.client || depth > 4) return "";
    const cached = this.cache.get(blockId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const lines: string[] = [];
    let count = 0;
    for await (const block of iteratePaginatedAPI(this.client.blocks.children.list, {
      block_id: blockId,
      page_size: 100,
    })) {
      if (++count > 500) {
        lines.push("[page content truncated]");
        break;
      }
      lines.push(blockText(block));
      if ("has_children" in block && block.has_children) {
        lines.push(await this.pageText(block.id, depth + 1));
      }
    }
    const value = lines.filter(Boolean).join("\n");
    this.cache.set(blockId, { expiresAt: Date.now() + 5 * 60_000, value });
    return value;
  }

  private async queryDataSource(dataSourceId: string, limit: number): Promise<Evidence> {
    if (!this.client) throw new Error("Notion is unavailable");
    const rows = [];
    for await (const row of iteratePaginatedAPI(this.client.dataSources.query, {
      data_source_id: dataSourceId,
      page_size: Math.min(100, limit),
    })) {
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return notionEvidence(
      "Notion data source rows",
      `notion://data-source/${dataSourceId}`,
      truncate(JSON.stringify(rows), 20000),
      { dataSourceId, limit },
    );
  }
}

function notionEvidence(
  title: string,
  locator: string,
  summary: string,
  query?: Record<string, unknown>,
): Evidence {
  return {
    id: `NOT-${randomUUID().slice(0, 8)}`,
    source: "notion",
    title,
    locator,
    retrievedAt: new Date().toISOString(),
    summary,
    ...(query ? { query } : {}),
  };
}

function objectTitle(value: any): string {
  const properties = value?.properties;
  if (properties && typeof properties === "object") {
    for (const property of Object.values(properties) as any[]) {
      const rich = property?.title ?? property?.rich_text;
      if (Array.isArray(rich)) {
        const text = rich.map((item) => item?.plain_text ?? "").join("");
        if (text) return text;
      }
    }
  }
  if (Array.isArray(value?.title)) {
    return value.title.map((item: any) => item?.plain_text ?? "").join("");
  }
  return "";
}

function blockText(block: any): string {
  const body = block?.[block.type];
  if (!body || typeof body !== "object") return "";
  const rich = body.rich_text;
  const text = Array.isArray(rich)
    ? rich.map((item: any) => item?.plain_text ?? "").join("")
    : "";
  if (block.type === "child_page" || block.type === "child_database") return body.title ?? "";
  return text;
}

function notionUrl(value: any): string {
  return typeof value?.url === "string" ? value.url : `notion://${value.object}/${value.id}`;
}

function numberWithin(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
