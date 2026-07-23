import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../../../src/config.js";
import type { QueryCache } from "../../../src/core/cache.js";
import type { DoctorResult, Evidence, Skill, SkillToolDefinition } from "../../../src/core/types.js";
import { redact, truncate } from "../../../src/core/security.js";
import { AsanaOAuthProvider } from "../auth/provider.js";
import {
  AssignedTaskQueryService,
  CreatedTaskQueryService,
  type QueryEvidenceMetadata,
} from "../queries/index.js";
import {
  assignedTaskOptFields,
  getAllAssignedTasks,
  getTasksCreatedBetween,
  getTasksCreatedByCursor,
  taskMatchesCountFilters,
} from "../retrieval/index.js";
import {
  calendarMonthInTimeZone,
  dateRangeBoundsInTimeZone,
  monthBoundsInTimeZone,
  yearBoundsInTimeZone,
} from "../time/index.js";
import {
  analyzeClientTasks,
  calculateMonthlyTaskAverages,
  calculateQuarterForecast,
  calculateServiceGrowth,
  calculateTaskMentionAnalysis,
} from "../analytics/index.js";

const mutatingName =
  /(?:^|_)(?:create|update|delete|remove|add|set|move|duplicate|comment|attach)(?:_|$)/i;

const compareTaskCountsTool = "asana__compare_task_counts";
const compareCreatedTaskCountsTool = "asana__compare_created_task_counts";
const analyzeClientTaskCountsTool = "asana__analyze_client_task_counts";
const analyzeTaskMentionsTool = "asana__analyze_task_mentions";
const compareCreatedTaskPeriodsTool = "asana__compare_created_task_periods";
const analyzeMonthlyTaskAveragesTool = "asana__analyze_monthly_task_averages";
const forecastBusiestQuarterTool = "asana__forecast_busiest_quarter";
const forecastServiceGrowthTool = "asana__forecast_service_growth";
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

export class AsanaSkill implements Skill {
  readonly name = "asana" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private cachedTools?: SkillToolDefinition[];
  private readonly oauth: AsanaOAuthProvider;
  private readonly createdTasks: CreatedTaskQueryService;
  private readonly assignedTasks: AssignedTaskQueryService;
  private authGeneration = 0;
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly cache: QueryCache,
  ) {
    this.oauth = new AsanaOAuthProvider(config);
    const scope = async () => ({
      organizationId: config.runtime.organizationId,
      userId: config.runtime.userId,
      credentialFingerprint: await this.oauth.credentialFingerprint(),
    });
    this.createdTasks = new CreatedTaskQueryService(
      cache,
      scope,
      async (spec) => {
        const search = (arguments_: Record<string, unknown>) =>
          this.callAsanaTool("search_tasks", arguments_);
        if (spec.projection === "project-parent") {
          return getTasksCreatedBetween(
            search,
            spec.filters ?? {},
            spec.start,
            spec.end,
            "gid,name,created_at,parent.gid,parent.name,parent.projects.gid,parent.projects.name,projects.gid,projects.name",
          );
        }
        return getTasksCreatedByCursor(
          search,
          spec.start,
          spec.end,
          "gid,created_at",
          spec.filters ?? {},
        );
      },
    );
    this.assignedTasks = new AssignedTaskQueryService(
      cache,
      scope,
      (assignee, projection) =>
        getAllAssignedTasks(
          (arguments_) => this.callAsanaTool("get_tasks", arguments_),
          assignee,
          projection,
        ),
    );
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
      tools.push({
        name: analyzeClientTaskCountsTool,
        skill: this.name,
        description:
          "Exhaustive year-to-date client ranking by tasks created. ALWAYS use this when the user asks which client or customer has the most tasks, is the biggest by task volume, or requests created-task counts by client. It partitions search_tasks by exact creation timestamps, attributes subtasks through parent project membership, groups multiple projects for the same client, excludes recognizable internal projects, and returns exact compact rankings plus attribution coverage. Do not infer a winner from capped search_tasks samples.",
        inputSchema: {
          type: "object",
          properties: {
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
          },
          required: ["year"],
          additionalProperties: false,
        },
      });
      tools.push({
        name: analyzeTaskMentionsTool,
        skill: this.name,
        description:
          "Exhaustive percentage of tasks created in a year whose Asana full text mentions a topic. ALWAYS use this for questions asking what percentage or how many tasks mentioned, referenced, or involved a keyword/topic. It partitions both the denominator and every full-text keyword search around Asana's 100-result limit, unions matching task GIDs, and returns an exact percentage. Supply separate synonymous terms to OR them together. For DEPARTURE video-work questions, use the organization keywords video, YouTube, and TikTok.",
        inputSchema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "Human-readable topic shown in the result, such as video work.",
            },
            terms: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              description:
                "Full-text terms to search independently and combine with OR semantics.",
              items: { type: "string", minLength: 1 },
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
          },
          required: ["topic", "terms", "year"],
          additionalProperties: false,
        },
      });
      tools.push({
        name: compareCreatedTaskPeriodsTool,
        skill: this.name,
        description:
          "Exhaustive comparison of tasks CREATED in two or more date periods. ALWAYS use this after the user clarifies that started means created in Asana, or whenever they compare created-task totals across halves, quarters, months, years, or custom ranges. Each from/through range is inclusive and converted using the organization time zone. The tool partitions around Asana's 100-result limit and returns exact totals plus absolute and percentage change. Do not use raw search_tasks results for period totals.",
        inputSchema: {
          type: "object",
          properties: {
            periods: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              description: "Periods to count and compare.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Human-readable period label, such as H1 2026.",
                  },
                  from: {
                    type: "string",
                    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                    description: "Inclusive first calendar date.",
                  },
                  through: {
                    type: "string",
                    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                    description: "Inclusive final calendar date.",
                  },
                },
                required: ["label", "from", "through"],
                additionalProperties: false,
              },
            },
            time_zone: {
              type: "string",
              default: "America/Los_Angeles",
              description:
                "IANA time zone defining calendar-day boundaries. Use the organization's primary time zone.",
            },
          },
          required: ["periods"],
          additionalProperties: false,
        },
      });
      tools.push({
        name: analyzeMonthlyTaskAveragesTool,
        skill: this.name,
        description:
          "Exact monthly averages of tasks CREATED across multiple years or partial years. ALWAYS use this when the user asks for average tasks per month over years, annual monthly averages, or a comparison that mixes completed years with a year-to-date period. It performs an efficient creation-time cursor scan, buckets tasks into calendar months, and returns yearly plus combined totals and averages. For January-June, set through_month to 6.",
        inputSchema: {
          type: "object",
          properties: {
            years: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              description: "Calendar years and the final month to include in each.",
              items: {
                type: "object",
                properties: {
                  year: {
                    type: "integer",
                    minimum: 2000,
                    maximum: 2100,
                  },
                  through_month: {
                    type: "integer",
                    minimum: 1,
                    maximum: 12,
                    default: 12,
                    description: "Last included month, where January is 1 and December is 12.",
                  },
                },
                required: ["year"],
                additionalProperties: false,
              },
            },
            time_zone: {
              type: "string",
              default: "America/Los_Angeles",
              description:
                "IANA time zone defining calendar-month boundaries. Use the organization's primary time zone.",
            },
          },
          required: ["years"],
          additionalProperties: false,
        },
      });
      tools.push({
        name: forecastBusiestQuarterTool,
        skill: this.name,
        description:
          "Forecast which quarter of a future year is likely to be busiest from historical CREATED-task seasonality. ALWAYS use this for questions asking which future quarter will be busiest based on prior task volumes. It scans the requested historical years once, buckets tasks by quarter, normalizes each quarter as a share of its year's total so unusually busy years do not dominate, and reports the winner, historical counts, margin, and forecast confidence.",
        inputSchema: {
          type: "object",
          properties: {
            historical_years: {
              type: "array",
              minItems: 2,
              maxItems: 10,
              uniqueItems: true,
              description: "Completed calendar years used to estimate quarterly seasonality.",
              items: {
                type: "integer",
                minimum: 2000,
                maximum: 2100,
              },
            },
            target_year: {
              type: "integer",
              minimum: 2000,
              maximum: 2100,
              description: "Future year being forecast.",
            },
            time_zone: {
              type: "string",
              default: "America/Los_Angeles",
              description:
                "IANA time zone defining calendar-quarter boundaries. Use the organization's primary time zone.",
            },
          },
          required: ["historical_years", "target_year"],
          additionalProperties: false,
        },
      });
      tools.push({
        name: forecastServiceGrowthTool,
        skill: this.name,
        description:
          "Forecast which service is growing faster from exact full-text CREATED-task trends. ALWAYS use this for task-volume growth comparisons between services. It unions and deduplicates each service's organization-approved keywords, reports mixed-service overlap, compares monthly task rates so partial years are comparable with full years, and ranks services by the latest growth rate with confidence. For DEPARTURE, branding terms include branding, logo, logotype, style guide, colors, lockup, identity; web terms include website, WordPress, Vue, HTML, JavaScript, CSS, UI, UX.",
        inputSchema: {
          type: "object",
          properties: {
            services: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  terms: {
                    type: "array",
                    minItems: 1,
                    maxItems: 20,
                    uniqueItems: true,
                    items: { type: "string", minLength: 1 },
                  },
                },
                required: ["label", "terms"],
                additionalProperties: false,
              },
            },
            periods: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  from: {
                    type: "string",
                    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                  },
                  through: {
                    type: "string",
                    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                  },
                  month_count: {
                    type: "integer",
                    minimum: 1,
                    maximum: 120,
                  },
                },
                required: ["label", "from", "through", "month_count"],
                additionalProperties: false,
              },
            },
            time_zone: {
              type: "string",
              default: "America/Los_Angeles",
              description:
                "IANA time zone defining period boundaries. Use the organization's primary time zone.",
            },
          },
          required: ["services", "periods"],
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
    if (toolName === analyzeClientTaskCountsTool) {
      return [await this.analyzeClientTaskCounts(input)];
    }
    if (toolName === analyzeTaskMentionsTool) {
      return [await this.analyzeTaskMentions(input)];
    }
    if (toolName === compareCreatedTaskPeriodsTool) {
      return [await this.compareCreatedTaskPeriods(input)];
    }
    if (toolName === analyzeMonthlyTaskAveragesTool) {
      return [await this.analyzeMonthlyTaskAverages(input)];
    }
    if (toolName === forecastBusiestQuarterTool) {
      return [await this.forecastBusiestQuarter(input)];
    }
    if (toolName === forecastServiceGrowthTool) {
      return [await this.forecastServiceGrowth(input)];
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
    const retrieved = await Promise.all(
      assignees.map(async ({ label, assignee }) => {
        const result = await this.assignedTasks.query({
          assignee,
          filters,
          projection: optFields,
        });
        const count = result.tasks.filter((task) => taskMatchesCountFilters(task, filters)).length;
        return {
          count: {
            label,
            assignee,
            count,
            retrievedCount: result.tasks.length,
            pageCount: result.pageCount,
          },
          cache: result.cache,
        };
      }),
    );
    const counts = retrieved.map((item) => item.count);
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
        cache: combineCacheMetadata(retrieved.map((item) => item.cache)),
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
      cache: QueryEvidenceMetadata;
    }> = [];
    for (const { label, user } of creators) {
      const result = await this.createdTasks.query({
        start: bounds.start,
        end: bounds.end,
        filters: { ...sharedFilters, created_by_any: user },
        projection: "timeline",
      });
      counts.push({
        label,
        user,
        count: result.tasks.length,
        queryCount: result.queryCount,
        cache: result.cache,
      });
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
        counts: counts.map(({ label, user, count, queryCount }) => ({
          label,
          user,
          count,
          queryCount,
        })),
        leaders,
        year: input.year,
        timeZone,
        range: {
          start: bounds.start.toISOString(),
          endExclusive: bounds.end.toISOString(),
        },
        exact: true,
        method: "partitioned_search_tasks_by_created_at",
        cache: combineCacheMetadata(counts.map((item) => item.cache)),
      },
      query: input,
    };
  }

  private async analyzeClientTaskCounts(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || typeof input.year !== "number") {
      throw new Error("Client task analysis requires a calendar year");
    }
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const bounds = yearBoundsInTimeZone(input.year, timeZone);
    const result = await this.createdTasks.projectParent(bounds.start, bounds.end);
    const analysis = analyzeClientTasks(result.tasks);
    const winner = analysis.clients[0];
    const ranking = analysis.clients
      .slice(0, 10)
      .map((client) => `${client.client}: ${client.count}`)
      .join("; ");
    const conclusion = winner
      ? `${winner.client} has the highest directly attributable client task count.`
      : "No client-attributable tasks were found.";
    const coverage =
      `${result.tasks.length} unique tasks analyzed; ` +
      `${analysis.unattributedTaskCount} had no project, ` +
      `${analysis.unclassifiedTaskCount} were in unclassified shared projects, and ` +
      `${analysis.internalTaskCount} were internal.`;
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: `Asana ${input.year} client task ranking`,
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(`${ranking}. ${conclusion} ${coverage}`),
      data: {
        ...analysis,
        totalTaskCount: result.tasks.length,
        queryCount: result.queryCount,
        winner: winner?.client,
        year: input.year,
        timeZone,
        range: {
          start: bounds.start.toISOString(),
          endExclusive: bounds.end.toISOString(),
        },
        exact: true,
        method: "partitioned_created_at_with_project_and_parent_attribution",
        cache: result.cache,
      },
      query: input,
    };
  }

  private async analyzeTaskMentions(input: unknown): Promise<Evidence> {
    if (
      !isRecord(input) ||
      typeof input.topic !== "string" ||
      !input.topic.trim() ||
      !Array.isArray(input.terms) ||
      input.terms.length === 0 ||
      typeof input.year !== "number"
    ) {
      throw new Error("Task mention analysis requires a topic, search terms, and calendar year");
    }
    const terms = [
      ...new Map(
        input.terms.map((term) => {
          if (typeof term !== "string" || !term.trim()) {
            throw new Error("Every task mention search term must be a non-empty string");
          }
          return [term.trim().toLowerCase(), term.trim()];
        }),
      ).values(),
    ];
    const topic = input.topic.trim();
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const bounds = yearBoundsInTimeZone(input.year, timeZone);
    const total = await this.createdTasks.timeline(bounds.start, bounds.end);
    const matches: Array<{ term: string; tasks: Record<string, unknown>[] }> = [];
    let queryCount = total.queryCount;
    const cacheMetadata = [total.cache];
    for (const term of terms) {
      const result = await this.createdTasks.term(bounds.start, bounds.end, term);
      matches.push({ term, tasks: result.tasks });
      queryCount += result.queryCount;
      cacheMetadata.push(result.cache);
    }
    const analysis = calculateTaskMentionAnalysis(total.tasks.length, matches);
    const percentage = analysis.percentage.toFixed(1);
    const termDetails = analysis.termCounts
      .map(({ term, count }) => `${term}: ${count}`)
      .join("; ");
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: `Asana ${input.year} ${topic} task mentions`,
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(
        `${analysis.matchingTaskCount} of ${total.tasks.length} tasks (${percentage}%) created in ${input.year} matched the Asana full-text terms for ${topic}. Term counts before deduplication: ${termDetails}.`,
      ),
      data: {
        ...analysis,
        totalTaskCount: total.tasks.length,
        topic,
        terms,
        year: input.year,
        timeZone,
        queryCount,
        exact: true,
        searchSemantics: "Asana full-text match across task names, descriptions, and comments",
        method: "partitioned_created_at_full_text_union",
        cache: combineCacheMetadata(cacheMetadata),
      },
      query: input,
    };
  }

  private async compareCreatedTaskPeriods(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || !Array.isArray(input.periods) || input.periods.length < 2) {
      throw new Error("Created-task period comparison requires at least two periods");
    }
    const periods = input.periods.map((period) => {
      if (
        !isRecord(period) ||
        typeof period.label !== "string" ||
        !period.label.trim() ||
        typeof period.from !== "string" ||
        typeof period.through !== "string"
      ) {
        throw new Error("Each comparison period requires a label, from date, and through date");
      }
      return {
        label: period.label.trim(),
        from: period.from,
        through: period.through,
      };
    });
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const retrievedPeriods = await Promise.all(
      periods.map(async (period) => {
        const bounds = dateRangeBoundsInTimeZone(period.from, period.through, timeZone);
        const result = await this.createdTasks.timeline(bounds.start, bounds.end);
        return {
          period: {
            ...period,
            count: result.tasks.length,
            queryCount: result.queryCount,
            range: {
              start: bounds.start.toISOString(),
              endExclusive: bounds.end.toISOString(),
            },
          },
          cache: result.cache,
        };
      }),
    );
    const counts = retrievedPeriods.map((item) => item.period);
    const chronological = [...counts].sort((left, right) => left.from.localeCompare(right.from));
    const current = chronological.at(-1);
    const previous = chronological.at(-2);
    const change = current && previous ? current.count - previous.count : 0;
    const percentageChange =
      previous && previous.count > 0 ? (change / previous.count) * 100 : undefined;
    const comparison =
      current && previous
        ? change === 0
          ? `${current.label} and ${previous.label} had the same number of tasks.`
          : `${current.label} had ${Math.abs(change)} ${change > 0 ? "more" : "fewer"} tasks than ${previous.label}` +
            (percentageChange === undefined
              ? "."
              : ` (${Math.abs(percentageChange).toFixed(1)}% ${change > 0 ? "increase" : "decrease"}).`)
        : "";
    const totals = counts.map((period) => `${period.label}: ${period.count}`).join("; ");
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: "Asana created-task period comparison",
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(`${totals}. ${comparison}`),
      data: {
        periods: counts,
        comparison:
          current && previous
            ? {
                current: current.label,
                previous: previous.label,
                change,
                percentageChange,
              }
            : undefined,
        timeZone,
        exact: true,
        method: "partitioned_created_at_period_comparison",
        cache: combineCacheMetadata(retrievedPeriods.map((item) => item.cache)),
      },
      query: input,
    };
  }

  private async analyzeMonthlyTaskAverages(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || !Array.isArray(input.years) || input.years.length === 0) {
      throw new Error("Monthly task average analysis requires at least one year");
    }
    const years = input.years.map((value) => {
      if (!isRecord(value) || typeof value.year !== "number") {
        throw new Error("Each monthly task average year requires a numeric year");
      }
      const throughMonth =
        value.through_month === undefined ? 12 : Number(value.through_month);
      if (
        !Number.isInteger(value.year) ||
        value.year < 2000 ||
        value.year > 2100 ||
        !Number.isInteger(throughMonth) ||
        throughMonth < 1 ||
        throughMonth > 12
      ) {
        throw new Error("Monthly task average years and through months are invalid");
      }
      return { year: value.year, throughMonth };
    });
    if (new Set(years.map((item) => item.year)).size !== years.length) {
      throw new Error("Monthly task average years must be unique");
    }
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const requestedMonths = years.flatMap(({ year, throughMonth }) =>
      Array.from({ length: throughMonth }, (_, index) => ({ year, month: index + 1 })),
    );
    const sortedMonths = [...requestedMonths].sort(
      (left, right) => left.year - right.year || left.month - right.month,
    );
    const firstMonth = sortedMonths[0];
    const lastMonth = sortedMonths.at(-1);
    if (!firstMonth || !lastMonth) throw new Error("No calendar months were requested");
    const firstBounds = monthBoundsInTimeZone(firstMonth.year, firstMonth.month, timeZone);
    const lastBounds = monthBoundsInTimeZone(lastMonth.year, lastMonth.month, timeZone);
    const retrieval = await this.getCreatedTaskTimeline(
      firstBounds.start,
      lastBounds.end,
    );
    const requestedKeys = new Set(
      requestedMonths.map(({ year, month }) => `${year}-${month}`),
    );
    const countsByMonth = new Map<string, number>();
    for (const task of retrieval.tasks) {
      if (typeof task.created_at !== "string") continue;
      const month = calendarMonthInTimeZone(task.created_at, timeZone);
      const key = `${month.year}-${month.month}`;
      if (requestedKeys.has(key)) countsByMonth.set(key, (countsByMonth.get(key) ?? 0) + 1);
    }
    const monthResults = requestedMonths.map(({ year, month }) => ({
      year,
      month,
      count: countsByMonth.get(`${year}-${month}`) ?? 0,
    }));
    const analysis = calculateMonthlyTaskAverages(monthResults);
    const fullYearSet = new Set(
      years.filter((item) => item.throughMonth === 12).map((item) => item.year),
    );
    const fullYearMonths = monthResults.filter((item) => fullYearSet.has(item.year));
    const completedYearBaseline = calculateMonthlyTaskAverages(fullYearMonths);
    const yearlySummary = analysis.years
      .map(
        (year) =>
          `${year.year}: ${year.total} tasks over ${year.monthCount} months (${year.monthlyAverage.toFixed(1)}/month)`,
      )
      .join("; ");
    const baselineSummary =
      completedYearBaseline.monthCount > 0
        ? `Completed-year baseline: ${completedYearBaseline.total} tasks over ${completedYearBaseline.monthCount} months (${completedYearBaseline.monthlyAverage.toFixed(1)}/month).`
        : "";
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: "Asana monthly created-task averages",
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(`${yearlySummary}. ${baselineSummary}`),
      data: {
        ...analysis,
        months: monthResults,
        completedYearBaseline,
        requestedYears: years,
        timeZone,
        queryCount: retrieval.queryCount,
        exact: true,
        method: "created_at_cursor_scan_bucketed_by_calendar_month",
        cache: retrieval.cache,
      },
      query: input,
    };
  }

  private async forecastBusiestQuarter(input: unknown): Promise<Evidence> {
    if (
      !isRecord(input) ||
      !Array.isArray(input.historical_years) ||
      input.historical_years.length < 2 ||
      typeof input.target_year !== "number"
    ) {
      throw new Error("Quarter forecast requires historical years and a target year");
    }
    const historicalYears = input.historical_years.map((year) => {
      if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new Error("Quarter forecast historical years are invalid");
      }
      return year;
    });
    if (new Set(historicalYears).size !== historicalYears.length) {
      throw new Error("Quarter forecast historical years must be unique");
    }
    if (
      !Number.isInteger(input.target_year) ||
      input.target_year < 2000 ||
      input.target_year > 2100
    ) {
      throw new Error("Quarter forecast target year is invalid");
    }
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const firstYear = Math.min(...historicalYears);
    const lastYear = Math.max(...historicalYears);
    const start = monthBoundsInTimeZone(firstYear, 1, timeZone).start;
    const end = monthBoundsInTimeZone(lastYear, 12, timeZone).end;
    const retrieval = await this.getCreatedTaskTimeline(
      start,
      end,
    );
    const requestedYears = new Set(historicalYears);
    const counts = new Map<string, number>();
    for (const task of retrieval.tasks) {
      if (typeof task.created_at !== "string") continue;
      const month = calendarMonthInTimeZone(task.created_at, timeZone);
      if (!requestedYears.has(month.year)) continue;
      const key = `${month.year}-${month.month}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const months = historicalYears.flatMap((year) =>
      Array.from({ length: 12 }, (_, index) => ({
        year,
        month: index + 1,
        count: counts.get(`${year}-${index + 1}`) ?? 0,
      })),
    );
    const forecast = calculateQuarterForecast(months);
    const shares = forecast.quarters
      .map((quarter) => `${quarter.quarter}: ${(quarter.averageShare * 100).toFixed(1)}%`)
      .join("; ");
    const historicalWinners = forecast.history
      .map((year) => {
        const maximum = Math.max(...year.quarters.map((quarter) => quarter.count));
        const winners = year.quarters
          .filter((quarter) => quarter.count === maximum)
          .map((quarter) => quarter.quarter)
          .join("/");
        return `${year.year}: ${winners}`;
      })
      .join("; ");
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: `Asana ${input.target_year} busiest-quarter forecast`,
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(
        `${forecast.winner} is the most likely busiest quarter of ${input.target_year}, based on average normalized historical task share (${shares}). Confidence: ${forecast.confidence}; annual historical winners were ${historicalWinners}.`,
      ),
      data: {
        ...forecast,
        historicalYears,
        targetYear: input.target_year,
        timeZone,
        totalHistoricalTasks: months.reduce((sum, month) => sum + month.count, 0),
        queryCount: retrieval.queryCount,
        exactHistoricalCounts: true,
        forecast: true,
        method: "normalized_historical_quarter_share",
        cache: retrieval.cache,
      },
      query: input,
    };
  }

  private async forecastServiceGrowth(input: unknown): Promise<Evidence> {
    if (
      !isRecord(input) ||
      !Array.isArray(input.services) ||
      input.services.length < 2 ||
      !Array.isArray(input.periods) ||
      input.periods.length < 2
    ) {
      throw new Error("Service growth forecast requires services and comparison periods");
    }
    const services = input.services.map((service) => {
      if (
        !isRecord(service) ||
        typeof service.label !== "string" ||
        !service.label.trim() ||
        !Array.isArray(service.terms) ||
        service.terms.length === 0
      ) {
        throw new Error("Each service growth entry requires a label and search terms");
      }
      const terms = [
        ...new Map(
          service.terms.map((term) => {
            if (typeof term !== "string" || !term.trim()) {
              throw new Error("Service growth search terms must be non-empty strings");
            }
            return [term.trim().toLowerCase(), term.trim()];
          }),
        ).values(),
      ];
      return { label: service.label.trim(), terms };
    });
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const periods = input.periods
      .map((period) => {
        if (
          !isRecord(period) ||
          typeof period.label !== "string" ||
          !period.label.trim() ||
          typeof period.from !== "string" ||
          typeof period.through !== "string" ||
          typeof period.month_count !== "number" ||
          !Number.isInteger(period.month_count) ||
          period.month_count < 1
        ) {
          throw new Error("Each service growth period requires dates and a month count");
        }
        const bounds = dateRangeBoundsInTimeZone(period.from, period.through, timeZone);
        return {
          label: period.label.trim(),
          from: period.from,
          through: period.through,
          monthCount: period.month_count,
          start: bounds.start.getTime(),
          end: bounds.end.getTime(),
        };
      })
      .sort((left, right) => left.start - right.start);
    const overallStart = new Date(Math.min(...periods.map((period) => period.start)));
    const overallEnd = new Date(Math.max(...periods.map((period) => period.end)));
    const uniqueTerms = [
      ...new Map(
        services.flatMap((service) =>
          service.terms.map((term) => [term.toLowerCase(), term] as const),
        ),
      ).values(),
    ];
    const termTasks = new Map<string, Record<string, unknown>[]>();
    let queryCount = 0;
    const cacheMetadata: QueryEvidenceMetadata[] = [];
    for (const term of uniqueTerms) {
      const result = await this.createdTasks.term(overallStart, overallEnd, term);
      termTasks.set(term.toLowerCase(), result.tasks);
      queryCount += result.queryCount;
      cacheMetadata.push(result.cache);
    }
    const serviceTasks = services.map((service) => {
      const tasks = new Map<string, Record<string, unknown>>();
      for (const term of service.terms) {
        for (const task of termTasks.get(term.toLowerCase()) ?? []) {
          if (typeof task.gid === "string") tasks.set(task.gid, task);
        }
      }
      return { service: service.label, tasks };
    });
    const growthInput = serviceTasks.map((service) => ({
      service: service.service,
      periods: periods.map((period) => ({
        label: period.label,
        monthCount: period.monthCount,
        count: [...service.tasks.values()].filter((task) => {
          if (typeof task.created_at !== "string") return false;
          const timestamp = Date.parse(task.created_at);
          return timestamp >= period.start && timestamp < period.end;
        }).length,
      })),
    }));
    const growth = calculateServiceGrowth(growthInput);
    const mixedByPeriod = periods.map((period) => {
      const memberships = new Map<string, number>();
      for (const service of serviceTasks) {
        for (const task of service.tasks.values()) {
          if (typeof task.gid !== "string" || typeof task.created_at !== "string") continue;
          const timestamp = Date.parse(task.created_at);
          if (timestamp >= period.start && timestamp < period.end) {
            memberships.set(task.gid, (memberships.get(task.gid) ?? 0) + 1);
          }
        }
      }
      return {
        label: period.label,
        count: [...memberships.values()].filter((count) => count > 1).length,
      };
    });
    const serviceSummary = growth.services
      .map((service) => {
        const rates = service.periods
          .map((period) => `${period.label}: ${period.count} (${period.monthlyRate.toFixed(1)}/month)`)
          .join(", ");
        const latest =
          service.latestGrowth === undefined
            ? "latest growth unavailable"
            : `${service.latestGrowth >= 0 ? "+" : ""}${(service.latestGrowth * 100).toFixed(1)}% latest growth`;
        return `${service.service} — ${rates}; ${latest}`;
      })
      .join(". ");
    return {
      id: `ASN-${randomUUID().slice(0, 8)}`,
      source: this.name,
      title: "Asana service task-growth forecast",
      locator: "https://app.asana.com/",
      retrievedAt: new Date().toISOString(),
      summary: redact(
        `${growth.winner} is likely to grow faster based on the latest monthly task-rate change. Confidence: ${growth.confidence}. ${serviceSummary}. Mixed-service matches: ${mixedByPeriod.map((period) => `${period.label}: ${period.count}`).join("; ")}.`,
      ),
      data: {
        ...growth,
        mixedByPeriod,
        services: growth.services.map((service) => ({
          ...service,
          terms: services.find((item) => item.label === service.service)?.terms ?? [],
        })),
        periods: periods.map(({ label, from, through, monthCount }) => ({
          label,
          from,
          through,
          monthCount,
        })),
        timeZone,
        queryCount,
        exactHistoricalMatches: true,
        forecast: true,
        searchSemantics: "Asana full-text match across task names, descriptions, and comments",
        method: "full_text_service_union_monthly_rate_growth",
        cache: combineCacheMetadata(cacheMetadata),
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
    await this.cache.close?.();
  }

  private async getCreatedTaskTimeline(
    start: Date,
    end: Date,
  ) {
    return this.createdTasks.timeline(start, end);
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
    let authenticationRetried = false;
    let transientRetries = 0;
    for (let rateLimitAttempt = 0; rateLimitAttempt <= 2; rateLimitAttempt++) {
      const generation = this.authGeneration;
      const result = await (await this.connect()).callTool({ name, arguments: arguments_ });
      if (isAsanaAuthError(result) && !authenticationRetried) {
        if (generation === this.authGeneration) await this.refreshAuthorization();
        authenticationRetried = true;
        rateLimitAttempt -= 1;
        continue;
      }
      if (isAsanaRateLimitError(result) && rateLimitAttempt < 2) {
        await delay(asanaRateLimitDelay(result));
        continue;
      }
      if (isAsanaTransientError(result) && transientRetries < 3) {
        await delay(250 * 2 ** transientRetries);
        transientRetries += 1;
        rateLimitAttempt -= 1;
        continue;
      }
      return result;
    }
    throw new Error("Asana tool retry loop ended unexpectedly");
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

function isAsanaRateLimitError(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.isError === true &&
    /rate_limit|too many requests|rate limit/i.test(extractMcpText(result))
  );
}

function isAsanaTransientError(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.isError === true &&
    /unable to verify MCP attestation token|please retry|temporarily unavailable/i.test(
      extractMcpText(result),
    )
  );
}

function asanaRateLimitDelay(result: unknown): number {
  const seconds = Number(extractMcpText(result).match(/wait\s+(\d+)\s+seconds?/i)?.[1] ?? 60);
  return Math.min(Math.max(seconds, 1), 60) * 1000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function combineCacheMetadata(
  entries: QueryEvidenceMetadata[],
): QueryEvidenceMetadata {
  return {
    hit: entries.length > 0 && entries.every((entry) => entry.hit),
    tier: entries.some((entry) => entry.tier === "loader")
      ? "loader"
      : entries.some((entry) => entry.tier === "disk")
        ? "disk"
        : "memory",
    ageMs: entries.reduce((maximum, entry) => Math.max(maximum, entry.ageMs), 0),
    queryCount: entries.reduce((total, entry) => total + entry.queryCount, 0),
  };
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
