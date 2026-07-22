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

const compareTaskCountsTool = "asana__compare_task_counts";
const compareCreatedTaskCountsTool = "asana__compare_created_task_counts";
const taskSearchLimit = 100;
const taskCountFilterNames = [
  "completed",
  "completed_on_before",
  "completed_on_after",
  "start_on_before",
  "start_on_after",
  "due_on_before",
  "due_on_after",
  "created_on_before",
  "created_on_after",
  "projects_any",
] as const;

export function isReadOnlyAsanaTool(name: string): boolean {
  return !mutatingName.test(name);
}

export function parseTaskSearchCount(value: string): number | undefined {
  const match = value.match(/\bFound\s+([\d,]+)\s+tasks?\b/i);
  if (!match?.[1]) return undefined;
  const count = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

type TaskSearchCall = (arguments_: Record<string, unknown>) => Promise<unknown>;

type ExhaustiveCount = {
  count: number;
  queryCount: number;
};

export async function countTasksByCreatedAt(
  search: TaskSearchCall,
  filters: Record<string, unknown>,
  start: Date,
  end: Date,
): Promise<ExhaustiveCount> {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw new Error("Created-task count requires a valid non-empty time range");
  }

  const countWindow = async (
    windowStart: Date,
    windowEnd: Date,
    windowFilters: Record<string, unknown>,
  ): Promise<ExhaustiveCount> => {
    const result = await search({
      ...windowFilters,
      created_at_after: new Date(windowStart.getTime() - 1).toISOString(),
      created_at_before: windowEnd.toISOString(),
      sort_by: "created_at",
      sort_ascending: true,
      limit: taskSearchLimit,
      opt_fields: "gid,created_at",
    });
    const returned = extractTaskSearchRows(result).length;
    if (returned < taskSearchLimit) return { count: returned, queryCount: 1 };

    const duration = windowEnd.getTime() - windowStart.getTime();
    if (duration > 1) {
      const midpoint = new Date(windowStart.getTime() + Math.floor(duration / 2));
      const [left, right] = await Promise.all([
        countWindow(windowStart, midpoint, windowFilters),
        countWindow(midpoint, windowEnd, windowFilters),
      ]);
      return {
        count: left.count + right.count,
        queryCount: 1 + left.queryCount + right.queryCount,
      };
    }

    for (const field of ["completed", "is_subtask"] as const) {
      if (windowFilters[field] === undefined) {
        const [falseCount, trueCount] = await Promise.all([
          countWindow(windowStart, windowEnd, { ...windowFilters, [field]: false }),
          countWindow(windowStart, windowEnd, { ...windowFilters, [field]: true }),
        ]);
        return {
          count: falseCount.count + trueCount.count,
          queryCount: 1 + falseCount.queryCount + trueCount.queryCount,
        };
      }
    }

    if (windowFilters.resource_subtype === undefined) {
      const subtypeCounts = await Promise.all(
        ["default_task", "milestone", "approval"].map((resource_subtype) =>
          countWindow(windowStart, windowEnd, { ...windowFilters, resource_subtype }),
        ),
      );
      return {
        count: subtypeCounts.reduce((sum, item) => sum + item.count, 0),
        queryCount: 1 + subtypeCounts.reduce((sum, item) => sum + item.queryCount, 0),
      };
    }

    throw new Error("More than 100 tasks share the same creation millisecond and task type");
  };

  return countWindow(start, end, filters);
}

export function yearBoundsInTimeZone(
  year: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be an integer from 2000 through 2100");
  }
  return {
    start: startOfDateInTimeZone(`${year}-01-01`, timeZone),
    end: startOfDateInTimeZone(`${year + 1}-01-01`, timeZone),
  };
}

export async function getAllAssignedTasks(
  getTasks: TaskSearchCall,
  assignee: string,
  optFields = "gid",
): Promise<{ tasks: Record<string, unknown>[]; pageCount: number }> {
  const tasks = new Map<string, Record<string, unknown>>();
  const seenOffsets = new Set<string>();
  let offset: string | undefined;
  let pageCount = 0;
  do {
    const result = await getTasks({
      assignee,
      limit: 100,
      ...(offset ? { offset } : {}),
      opt_fields: optFields,
    });
    const page = extractTaskPage(result);
    pageCount += 1;
    for (const task of page.tasks) {
      if (typeof task.gid !== "string" || !task.gid) {
        throw new Error("Asana returned an assigned task without a GID");
      }
      tasks.set(task.gid, task);
    }
    offset = page.offset;
    if (offset) {
      if (seenOffsets.has(offset)) throw new Error("Asana repeated a task pagination offset");
      seenOffsets.add(offset);
    }
    if (pageCount >= 1000 && offset) {
      throw new Error("Asana assigned-task pagination exceeded 1000 pages");
    }
  } while (offset);
  return { tasks: [...tasks.values()], pageCount };
}

export function taskMatchesCountFilters(
  task: Record<string, unknown>,
  filters: Record<string, unknown>,
): boolean {
  if (typeof filters.completed === "boolean" && task.completed !== filters.completed) return false;
  if (!matchesDateRange(taskDate(task, "start_on", "start_at"), filters, "start_on")) {
    return false;
  }
  if (!matchesDateRange(taskDate(task, "due_on", "due_at"), filters, "due_on")) return false;
  if (!matchesDateRange(taskDate(task, "created_at"), filters, "created_on")) return false;
  if (!matchesDateRange(taskDate(task, "completed_at"), filters, "completed_on")) return false;

  if (typeof filters.projects_any === "string" && filters.projects_any.trim()) {
    const requested = new Set(
      filters.projects_any.split(",").map((value) => value.trim()).filter(Boolean),
    );
    const projectIds = taskProjectIds(task);
    if (![...requested].some((gid) => projectIds.has(gid))) return false;
  }
  return true;
}

export class AsanaSkill implements Skill {
  readonly name = "asana" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private cachedTools?: SkillToolDefinition[];
  private readonly oauth: AsanaOAuthProvider;
  private authGeneration = 0;
  private refreshPromise?: Promise<void>;

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
    if (tools.some((tool) => tool.name === "asana__get_tasks")) {
      tools.push({
        name: compareTaskCountsTool,
        skill: this.name,
        description:
          "Exhaustive analytical comparison of tasks CURRENTLY ASSIGNED to people. ALWAYS use this instead of retrieving task lists when the user asks how many tasks are assigned to people or which assignee has the most or fewest tasks. This tool follows every get_tasks pagination offset, deduplicates task GIDs, applies optional filters locally, and returns exact ranked counts. It measures current assignment, not historical assignee changes. Use exclusive date boundaries; for calendar year 2026, set start_on_after to 2025-12-31 and start_on_before to 2027-01-01.",
        inputSchema: {
          type: "object",
          properties: {
            assignees: {
              type: "array",
              minItems: 2,
              maxItems: 20,
              description: "People whose matching assigned-task counts should be compared.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Human-readable name to show in the result.",
                  },
                  assignee: {
                    type: "string",
                    description:
                      "Asana user GID or email, normally resolved first with search_objects.",
                  },
                },
                required: ["label", "assignee"],
                additionalProperties: false,
              },
            },
            completed: {
              type: "boolean",
              description: "Optionally count only completed or incomplete tasks.",
            },
            start_on_before: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive upper start-date boundary in YYYY-MM-DD format.",
            },
            start_on_after: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive lower start-date boundary in YYYY-MM-DD format.",
            },
            due_on_before: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive upper due-date boundary in YYYY-MM-DD format.",
            },
            due_on_after: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive lower due-date boundary in YYYY-MM-DD format.",
            },
            created_on_before: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive upper creation-date boundary in YYYY-MM-DD format.",
            },
            created_on_after: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Exclusive lower creation-date boundary in YYYY-MM-DD format.",
            },
            projects_any: {
              type: "string",
              description: "Optional comma-separated project GIDs.",
            },
          },
          required: ["assignees"],
          additionalProperties: false,
        },
      });
    }
    if (tools.some((tool) => tool.name === "asana__search_tasks")) {
      tools.push({
        name: compareCreatedTaskCountsTool,
        skill: this.name,
        description:
          "Exhaustive analytical comparison of tasks CREATED by people. ALWAYS use this when the user asks who created, made, or added the most or fewest tasks, or asks for created-task totals. Unlike search_tasks, this tool is not capped at 100 results: it automatically partitions the requested year into timestamp ranges and sums exact counts. Resolve each person's Asana user GID with search_objects first. Do not perform monthly searches or count task-list evidence yourself.",
        inputSchema: {
          type: "object",
          properties: {
            creators: {
              type: "array",
              minItems: 2,
              maxItems: 20,
              description: "People whose created-task counts should be compared.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Human-readable name to show in the result.",
                  },
                  user: {
                    type: "string",
                    description:
                      "Asana user GID or email, normally resolved first with search_objects.",
                  },
                },
                required: ["label", "user"],
                additionalProperties: false,
              },
            },
            year: {
              type: "integer",
              minimum: 2000,
              maximum: 2100,
              description: "Calendar year in which the tasks were created.",
            },
            time_zone: {
              type: "string",
              default: "America/Los_Angeles",
              description:
                "IANA time zone defining the calendar-year boundaries. Use the organization's primary time zone.",
            },
            completed: {
              type: "boolean",
              description: "Optionally count only completed or incomplete tasks.",
            },
            projects_any: {
              type: "string",
              description: "Optional comma-separated project GIDs.",
            },
            is_subtask: {
              type: "boolean",
              description: "Optionally include only subtasks or only top-level tasks.",
            },
          },
          required: ["creators", "year"],
          additionalProperties: false,
        },
      });
    }
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
    if (toolName === compareTaskCountsTool) {
      return [await this.compareTaskCounts(input)];
    }
    if (toolName === compareCreatedTaskCountsTool) {
      return [await this.compareCreatedTaskCounts(input)];
    }
    const result = await this.callAsanaTool(remoteName, isRecord(input) ? input : {});
    const text = extractMcpText(result);
    return [
      {
        id: `ASN-${randomUUID().slice(0, 8)}`,
        source: this.name,
        title: `Asana ${remoteName.replaceAll("_", " ")}`,
        locator: "https://app.asana.com/",
        retrievedAt: new Date().toISOString(),
        summary: truncate(redact(text), 14000),
        data: isRecord(result) ? result.structuredContent : undefined,
        query: isRecord(input) ? input : {},
      },
    ];
  }

  private async compareTaskCounts(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || !Array.isArray(input.assignees) || input.assignees.length < 2) {
      throw new Error("Task count comparison requires at least two assignees");
    }
    const assignees = input.assignees.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.label !== "string" ||
        !value.label.trim() ||
        typeof value.assignee !== "string" ||
        !value.assignee.trim()
      ) {
        throw new Error("Each assignee requires a non-empty label and Asana user identifier");
      }
      return { label: value.label.trim(), assignee: value.assignee.trim() };
    });
    const filters: Record<string, unknown> = {};
    for (const name of taskCountFilterNames) {
      if (input[name] !== undefined) filters[name] = input[name];
    }
    const optFields = assignedTaskOptFields(filters);
    const counts = await Promise.all(
      assignees.map(async ({ label, assignee }) => {
        const result = await getAllAssignedTasks(
          (arguments_) => this.callAsanaTool("get_tasks", arguments_),
          assignee,
          optFields,
        );
        const count = result.tasks.filter((task) => taskMatchesCountFilters(task, filters)).length;
        return {
          label,
          assignee,
          count,
          retrievedCount: result.tasks.length,
          pageCount: result.pageCount,
        };
      }),
    );
    counts.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    const highest = counts[0]?.count ?? 0;
    const leaders = counts.filter((item) => item.count === highest).map((item) => item.label);
    const comparison = counts.map((item) => `${item.label}: ${item.count}`).join("; ");
    const conclusion =
      leaders.length === 1
        ? `${leaders[0]} has the highest count.`
        : `${leaders.join(" and ")} are tied for the highest count.`;
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: "Asana task count comparison",
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(`${comparison}. ${conclusion}`),
      data: {
        counts,
        leaders,
        filters,
        exact: true,
        method: "paginated_get_tasks",
      },
      query: input,
    };
  }

  private async compareCreatedTaskCounts(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || !Array.isArray(input.creators) || input.creators.length < 2) {
      throw new Error("Created-task comparison requires at least two creators");
    }
    const creators = input.creators.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.label !== "string" ||
        !value.label.trim() ||
        typeof value.user !== "string" ||
        !value.user.trim()
      ) {
        throw new Error("Each creator requires a non-empty label and Asana user identifier");
      }
      return { label: value.label.trim(), user: value.user.trim() };
    });
    if (typeof input.year !== "number") {
      throw new Error("Created-task comparison requires a calendar year");
    }
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const bounds = yearBoundsInTimeZone(input.year, timeZone);
    const sharedFilters: Record<string, unknown> = {};
    for (const name of ["completed", "projects_any", "is_subtask"] as const) {
      if (input[name] !== undefined) sharedFilters[name] = input[name];
    }

    const counts: Array<{
      label: string;
      user: string;
      count: number;
      queryCount: number;
    }> = [];
    for (const { label, user } of creators) {
      const result = await countTasksByCreatedAt(
        (arguments_) => this.callAsanaTool("search_tasks", arguments_),
        { ...sharedFilters, created_by_any: user },
        bounds.start,
        bounds.end,
      );
      counts.push({ label, user, ...result });
    }

    counts.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    const highest = counts[0]?.count ?? 0;
    const leaders = counts.filter((item) => item.count === highest).map((item) => item.label);
    const comparison = counts.map((item) => `${item.label}: ${item.count}`).join("; ");
    const conclusion =
      leaders.length === 1
        ? `${leaders[0]} created the most tasks.`
        : `${leaders.join(" and ")} are tied for the most tasks created.`;
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: `Asana ${input.year} created-task comparison`,
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(`${comparison}. ${conclusion}`),
      data: {
        counts,
        leaders,
        year: input.year,
        timeZone,
        range: {
          start: bounds.start.toISOString(),
          endExclusive: bounds.end.toISOString(),
        },
        exact: true,
        method: "partitioned_search_tasks_by_created_at",
      },
      query: input,
    };
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

  private async callAsanaTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const generation = this.authGeneration;
    let result = await (await this.connect()).callTool({ name, arguments: arguments_ });
    if (!isAsanaAuthError(result)) return result;

    if (generation === this.authGeneration) await this.refreshAuthorization();
    result = await (await this.connect()).callTool({ name, arguments: arguments_ });
    return result;
  }

  private async refreshAuthorization(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        await this.oauth.refreshTokens();
        await this.client?.close();
        this.client = undefined;
        this.transport = undefined;
        this.authGeneration += 1;
      })().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAsanaAuthError(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.isError === true &&
    /unauthorized|token has expired|re-authorize/i.test(extractMcpText(result))
  );
}

function extractTaskPage(
  result: unknown,
): { tasks: Record<string, unknown>[]; offset?: string } {
  if (isRecord(result) && result.isError === true) {
    throw new Error(`Asana assigned-task retrieval failed: ${extractMcpText(result)}`);
  }
  let payload: unknown =
    isRecord(result) && isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined;
  if (!isRecord(payload)) {
    try {
      payload = JSON.parse(extractMcpText(result)) as unknown;
    } catch {
      throw new Error("Asana assigned-task retrieval returned an unrecognized response");
    }
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Asana assigned-task retrieval returned an invalid task page");
  }
  const tasks = payload.data.map((task) => {
    if (!isRecord(task)) throw new Error("Asana returned an invalid assigned task");
    return task;
  });
  const offset =
    isRecord(payload.next_page) && typeof payload.next_page.offset === "string"
      ? payload.next_page.offset
      : undefined;
  return { tasks, ...(offset ? { offset } : {}) };
}

function taskDate(task: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = task[field];
    if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  }
  return undefined;
}

function matchesDateRange(
  value: string | undefined,
  filters: Record<string, unknown>,
  prefix: string,
): boolean {
  const after = filters[`${prefix}_after`];
  const before = filters[`${prefix}_before`];
  if (after === undefined && before === undefined) return true;
  if (!value) return false;
  if (typeof after === "string" && value <= after) return false;
  if (typeof before === "string" && value >= before) return false;
  return true;
}

function taskProjectIds(task: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(task.projects)) {
    for (const project of task.projects) {
      if (isRecord(project) && typeof project.gid === "string") ids.add(project.gid);
    }
  }
  if (Array.isArray(task.memberships)) {
    for (const membership of task.memberships) {
      if (
        isRecord(membership) &&
        isRecord(membership.project) &&
        typeof membership.project.gid === "string"
      ) {
        ids.add(membership.project.gid);
      }
    }
  }
  return ids;
}

function assignedTaskOptFields(filters: Record<string, unknown>): string {
  const fields = new Set(["gid"]);
  if (typeof filters.completed === "boolean") fields.add("completed");
  if (filters.start_on_after !== undefined || filters.start_on_before !== undefined) {
    fields.add("start_on");
    fields.add("start_at");
  }
  if (filters.due_on_after !== undefined || filters.due_on_before !== undefined) {
    fields.add("due_on");
    fields.add("due_at");
  }
  if (filters.created_on_after !== undefined || filters.created_on_before !== undefined) {
    fields.add("created_at");
  }
  if (filters.completed_on_after !== undefined || filters.completed_on_before !== undefined) {
    fields.add("completed_at");
  }
  if (filters.projects_any !== undefined) {
    fields.add("projects.gid");
    fields.add("memberships.project.gid");
  }
  return [...fields].join(",");
}

function extractTaskSearchRows(result: unknown): unknown[] {
  if (isRecord(result) && result.isError === true) {
    throw new Error(`Asana task search failed: ${extractMcpText(result)}`);
  }
  if (isRecord(result) && isRecord(result.structuredContent)) {
    const rows = result.structuredContent.data;
    if (Array.isArray(rows)) return rows;
  }
  const text = extractMcpText(result);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.data)) return parsed.data;
  } catch {
    // The explicit error below is safer than treating an unknown response as zero tasks.
  }
  throw new Error("Asana task search returned an unrecognized response");
}

function startOfDateInTimeZone(date: string, timeZone: string): Date {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate = target - (represented - candidate);
  }
  return new Date(candidate);
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
