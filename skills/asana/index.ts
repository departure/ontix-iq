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
const analyzeClientTaskCountsTool = "asana__analyze_client_task_counts";
const analyzeTaskMentionsTool = "asana__analyze_task_mentions";
const compareCreatedTaskPeriodsTool = "asana__compare_created_task_periods";
const analyzeMonthlyTaskAveragesTool = "asana__analyze_monthly_task_averages";
const forecastBusiestQuarterTool = "asana__forecast_busiest_quarter";
const forecastServiceGrowthTool = "asana__forecast_service_growth";
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

export async function getTasksCreatedBetween(
  search: TaskSearchCall,
  filters: Record<string, unknown>,
  start: Date,
  end: Date,
  optFields: string,
): Promise<{ tasks: Record<string, unknown>[]; queryCount: number }> {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw new Error("Created-task retrieval requires a valid non-empty time range");
  }

  const collectWindow = async (
    windowStart: Date,
    windowEnd: Date,
    windowFilters: Record<string, unknown>,
  ): Promise<{ tasks: Record<string, unknown>[]; queryCount: number }> => {
    const result = await search({
      ...windowFilters,
      created_at_after: new Date(windowStart.getTime() - 1).toISOString(),
      created_at_before: windowEnd.toISOString(),
      sort_by: "created_at",
      sort_ascending: true,
      limit: taskSearchLimit,
      opt_fields: optFields,
    });
    const tasks = extractTaskSearchRows(result).map((task) => {
      if (!isRecord(task) || typeof task.gid !== "string") {
        throw new Error("Asana created-task search returned a task without a GID");
      }
      return task;
    });
    if (tasks.length < taskSearchLimit) return { tasks, queryCount: 1 };

    const duration = windowEnd.getTime() - windowStart.getTime();
    if (duration > 1) {
      const midpoint = new Date(windowStart.getTime() + Math.floor(duration / 2));
      const [left, right] = await Promise.all([
        collectWindow(windowStart, midpoint, windowFilters),
        collectWindow(midpoint, windowEnd, windowFilters),
      ]);
      return mergeTaskCollections([left, right]);
    }

    for (const field of ["completed", "is_subtask"] as const) {
      if (windowFilters[field] === undefined) {
        const partitions = await Promise.all([
          collectWindow(windowStart, windowEnd, { ...windowFilters, [field]: false }),
          collectWindow(windowStart, windowEnd, { ...windowFilters, [field]: true }),
        ]);
        return mergeTaskCollections(partitions);
      }
    }

    if (windowFilters.resource_subtype === undefined) {
      const partitions = await Promise.all(
        ["default_task", "milestone", "approval"].map((resource_subtype) =>
          collectWindow(windowStart, windowEnd, { ...windowFilters, resource_subtype }),
        ),
      );
      return mergeTaskCollections(partitions);
    }

    throw new Error("More than 100 tasks share the same creation millisecond and task type");
  };

  return collectWindow(start, end, filters);
}

export async function getTasksCreatedByCursor(
  search: TaskSearchCall,
  start: Date,
  end: Date,
  optFields: string,
  filters: Record<string, unknown> = {},
): Promise<{ tasks: Record<string, unknown>[]; queryCount: number }> {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw new Error("Created-task cursor retrieval requires a valid non-empty time range");
  }
  const tasks = new Map<string, Record<string, unknown>>();
  let cursor = start.getTime() - 1;
  let queryCount = 0;
  for (let page = 0; page < 1000; page++) {
    const result = await search({
      ...filters,
      created_at_after: new Date(cursor).toISOString(),
      created_at_before: end.toISOString(),
      sort_by: "created_at",
      sort_ascending: true,
      limit: taskSearchLimit,
      opt_fields: optFields,
    });
    queryCount += 1;
    const rows = extractTaskSearchRows(result).map((task) => {
      if (
        !isRecord(task) ||
        typeof task.gid !== "string" ||
        typeof task.created_at !== "string"
      ) {
        throw new Error("Asana cursor search returned a task without a GID or creation time");
      }
      return task;
    });
    for (const task of rows) tasks.set(task.gid as string, task);
    if (rows.length < taskSearchLimit) return { tasks: [...tasks.values()], queryCount };

    const lastTimestamp = Date.parse(rows.at(-1)?.created_at as string);
    if (!Number.isFinite(lastTimestamp) || lastTimestamp <= cursor) {
      throw new Error("Asana created-task cursor did not advance");
    }
    const boundaryRows = rows.filter(
      (task) => Date.parse(task.created_at as string) === lastTimestamp,
    );
    if (boundaryRows.length > 1) {
      const boundary = await getTasksCreatedBetween(
        search,
        filters,
        new Date(lastTimestamp),
        new Date(lastTimestamp + 1),
        optFields,
      );
      queryCount += boundary.queryCount;
      for (const task of boundary.tasks) tasks.set(task.gid as string, task);
    }
    cursor = lastTimestamp;
  }
  throw new Error("Asana created-task cursor retrieval exceeded 1000 pages");
}

export type ClientTaskAnalysis = {
  clients: Array<{
    client: string;
    count: number;
    projects: Array<{ gid: string; name: string; count: number }>;
  }>;
  attributedTaskCount: number;
  internalTaskCount: number;
  unclassifiedTaskCount: number;
  unattributedTaskCount: number;
  crossClientTaskCount: number;
};

export function analyzeClientTasks(tasks: Record<string, unknown>[]): ClientTaskAnalysis {
  const projectNames = new Map<string, string>();
  for (const task of tasks) {
    for (const project of taskProjects(task)) projectNames.set(project.gid, project.name);
  }
  const projectClients = new Map<string, { key: string; label: string; classification: string }>();
  for (const [gid, name] of projectNames) {
    projectClients.set(gid, classifyProjectClient(name, [...projectNames.values()]));
  }

  const clientTasks = new Map<string, Set<string>>();
  const clientLabels = new Map<string, string>();
  const clientProjects = new Map<string, Map<string, { name: string; tasks: Set<string> }>>();
  const internalTasks = new Set<string>();
  const unclassifiedTasks = new Set<string>();
  const unattributedTasks = new Set<string>();
  let crossClientTaskCount = 0;

  for (const task of tasks) {
    if (typeof task.gid !== "string") continue;
    const projects = taskProjects(task);
    if (projects.length === 0) {
      unattributedTasks.add(task.gid);
      continue;
    }
    const taskClientKeys = new Set<string>();
    let hasInternalProject = false;
    let hasUnclassifiedProject = false;
    for (const project of projects) {
      const client = projectClients.get(project.gid);
      if (!client) continue;
      if (client.classification === "internal") {
        hasInternalProject = true;
        continue;
      }
      if (client.classification === "unclassified") {
        hasUnclassifiedProject = true;
        continue;
      }
      taskClientKeys.add(client.key);
      clientLabels.set(client.key, client.label);
      const projectMap = clientProjects.get(client.key) ?? new Map();
      const projectEntry = projectMap.get(project.gid) ?? {
        name: project.name,
        tasks: new Set<string>(),
      };
      projectEntry.tasks.add(task.gid);
      projectMap.set(project.gid, projectEntry);
      clientProjects.set(client.key, projectMap);
    }
    if (taskClientKeys.size > 0) {
      if (taskClientKeys.size > 1) crossClientTaskCount += 1;
      for (const key of taskClientKeys) {
        const gids = clientTasks.get(key) ?? new Set<string>();
        gids.add(task.gid);
        clientTasks.set(key, gids);
      }
    } else if (hasUnclassifiedProject) {
      unclassifiedTasks.add(task.gid);
    } else if (hasInternalProject) {
      internalTasks.add(task.gid);
    }
  }

  const clients = [...clientTasks.entries()]
    .map(([key, gids]) => ({
      client: clientLabels.get(key) ?? key,
      count: gids.size,
      projects: [...(clientProjects.get(key)?.entries() ?? [])]
        .map(([gid, project]) => ({ gid, name: project.name, count: project.tasks.size }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => right.count - left.count || left.client.localeCompare(right.client));
  return {
    clients,
    attributedTaskCount: new Set([...clientTasks.values()].flatMap((gids) => [...gids])).size,
    internalTaskCount: internalTasks.size,
    unclassifiedTaskCount: unclassifiedTasks.size,
    unattributedTaskCount: unattributedTasks.size,
    crossClientTaskCount,
  };
}

export function calculateTaskMentionAnalysis(
  totalTaskCount: number,
  matches: Array<{ term: string; tasks: Record<string, unknown>[] }>,
): {
  matchingTaskCount: number;
  percentage: number;
  termCounts: Array<{ term: string; count: number }>;
} {
  if (!Number.isSafeInteger(totalTaskCount) || totalTaskCount < 0) {
    throw new Error("Total task count must be a non-negative integer");
  }
  const allMatches = new Set<string>();
  const termCounts = matches.map(({ term, tasks }) => {
    const termMatches = new Set<string>();
    for (const task of tasks) {
      if (typeof task.gid !== "string") continue;
      termMatches.add(task.gid);
      allMatches.add(task.gid);
    }
    return { term, count: termMatches.size };
  });
  const matchingTaskCount = allMatches.size;
  return {
    matchingTaskCount,
    percentage: totalTaskCount === 0 ? 0 : (matchingTaskCount / totalTaskCount) * 100,
    termCounts,
  };
}

export function dateRangeBoundsInTimeZone(
  from: string,
  through: string,
  timeZone: string,
): { start: Date; end: Date } {
  const fromParts = parseCalendarDate(from);
  const throughParts = parseCalendarDate(through);
  const fromOrdinal = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const throughOrdinal = Date.UTC(throughParts.year, throughParts.month - 1, throughParts.day);
  if (fromOrdinal > throughOrdinal) throw new Error("Period start date must not follow its end date");
  const dayAfterThrough = new Date(throughOrdinal + 86_400_000).toISOString().slice(0, 10);
  return {
    start: startOfDateInTimeZone(from, timeZone),
    end: startOfDateInTimeZone(dayAfterThrough, timeZone),
  };
}

export function monthBoundsInTimeZone(
  year: number,
  month: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be an integer from 2000 through 2100");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Month must be an integer from 1 through 12");
  }
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return {
    start: startOfDateInTimeZone(start, timeZone),
    end: startOfDateInTimeZone(nextMonth, timeZone),
  };
}

export function calculateMonthlyTaskAverages(
  months: Array<{ year: number; month: number; count: number }>,
): {
  years: Array<{ year: number; monthCount: number; total: number; monthlyAverage: number }>;
  monthCount: number;
  total: number;
  monthlyAverage: number;
} {
  const grouped = new Map<number, { monthCount: number; total: number }>();
  for (const item of months) {
    if (
      !Number.isInteger(item.year) ||
      !Number.isInteger(item.month) ||
      item.month < 1 ||
      item.month > 12 ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0
    ) {
      throw new Error("Monthly task counts require valid years, months, and non-negative totals");
    }
    const year = grouped.get(item.year) ?? { monthCount: 0, total: 0 };
    year.monthCount += 1;
    year.total += item.count;
    grouped.set(item.year, year);
  }
  const years = [...grouped.entries()]
    .map(([year, values]) => ({
      year,
      ...values,
      monthlyAverage: values.monthCount === 0 ? 0 : values.total / values.monthCount,
    }))
    .sort((left, right) => left.year - right.year);
  const total = years.reduce((sum, year) => sum + year.total, 0);
  const monthCount = years.reduce((sum, year) => sum + year.monthCount, 0);
  return {
    years,
    monthCount,
    total,
    monthlyAverage: monthCount === 0 ? 0 : total / monthCount,
  };
}

export function calculateQuarterForecast(
  months: Array<{ year: number; month: number; count: number }>,
): {
  winner: string;
  confidence: "low" | "moderate" | "high";
  margin: number;
  quarters: Array<{
    quarter: string;
    averageShare: number;
    averageCount: number;
    medianCount: number;
    yearsBusiest: number;
  }>;
  history: Array<{
    year: number;
    total: number;
    quarters: Array<{ quarter: string; count: number; share: number }>;
  }>;
} {
  const byYear = new Map<number, number[]>();
  for (const item of months) {
    if (
      !Number.isInteger(item.year) ||
      !Number.isInteger(item.month) ||
      item.month < 1 ||
      item.month > 12 ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0
    ) {
      throw new Error("Quarter forecasts require valid monthly task counts");
    }
    const quarters = byYear.get(item.year) ?? [0, 0, 0, 0];
    quarters[Math.floor((item.month - 1) / 3)] =
      (quarters[Math.floor((item.month - 1) / 3)] ?? 0) + item.count;
    byYear.set(item.year, quarters);
  }
  const history = [...byYear.entries()]
    .map(([year, counts]) => {
      const total = counts.reduce((sum, count) => sum + count, 0);
      return {
        year,
        total,
        quarters: counts.map((count, index) => ({
          quarter: `Q${index + 1}`,
          count,
          share: total === 0 ? 0 : count / total,
        })),
      };
    })
    .filter((year) => year.total > 0)
    .sort((left, right) => left.year - right.year);
  if (history.length === 0) throw new Error("Quarter forecast has no historical tasks");

  const quarters = [0, 1, 2, 3]
    .map((index) => {
      const observations = history.map((year) => year.quarters[index]?.count ?? 0);
      const shares = history.map((year) => year.quarters[index]?.share ?? 0);
      const sorted = [...observations].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const medianCount =
        sorted.length % 2 === 0
          ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
          : (sorted[middle] ?? 0);
      return {
        quarter: `Q${index + 1}`,
        averageShare: shares.reduce((sum, share) => sum + share, 0) / shares.length,
        averageCount:
          observations.reduce((sum, count) => sum + count, 0) / observations.length,
        medianCount,
        yearsBusiest: history.filter((year) => {
          const maximum = Math.max(...year.quarters.map((quarter) => quarter.count));
          return year.quarters[index]?.count === maximum;
        }).length,
      };
    })
    .sort(
      (left, right) =>
        right.averageShare - left.averageShare || left.quarter.localeCompare(right.quarter),
    );
  const margin = (quarters[0]?.averageShare ?? 0) - (quarters[1]?.averageShare ?? 0);
  const winnerConsistency = (quarters[0]?.yearsBusiest ?? 0) / history.length;
  const confidence =
    margin >= 0.08 && winnerConsistency >= 2 / 3
      ? "high"
      : margin >= 0.03 || winnerConsistency >= 2 / 3
        ? "moderate"
        : "low";
  return {
    winner: quarters[0]?.quarter ?? "Q1",
    confidence,
    margin,
    quarters,
    history,
  };
}

export function calculateServiceGrowth(
  services: Array<{
    service: string;
    periods: Array<{ label: string; count: number; monthCount: number }>;
  }>,
): {
  winner: string;
  confidence: "low" | "moderate" | "high";
  services: Array<{
    service: string;
    periods: Array<{
      label: string;
      count: number;
      monthCount: number;
      monthlyRate: number;
    }>;
    changes: Array<{
      from: string;
      to: string;
      percentageChange?: number;
    }>;
    latestGrowth?: number;
  }>;
} {
  if (services.length < 2) throw new Error("Service growth requires at least two services");
  const analyzed = services.map((service) => {
    if (!service.service.trim() || service.periods.length < 2) {
      throw new Error("Each service requires a name and at least two periods");
    }
    const periods = service.periods.map((period) => {
      if (
        !period.label.trim() ||
        !Number.isSafeInteger(period.count) ||
        period.count < 0 ||
        !Number.isInteger(period.monthCount) ||
        period.monthCount < 1
      ) {
        throw new Error("Service growth periods require valid counts and month totals");
      }
      return { ...period, monthlyRate: period.count / period.monthCount };
    });
    const changes = periods.slice(1).map((period, index) => {
      const previous = periods[index];
      return {
        from: previous?.label ?? "",
        to: period.label,
        ...(previous && previous.monthlyRate > 0
          ? {
              percentageChange:
                (period.monthlyRate - previous.monthlyRate) / previous.monthlyRate,
            }
          : {}),
      };
    });
    return {
      service: service.service,
      periods,
      changes,
      latestGrowth: changes.at(-1)?.percentageChange,
    };
  });
  const ranked = [...analyzed].sort(
    (left, right) =>
      (right.latestGrowth ?? Number.NEGATIVE_INFINITY) -
        (left.latestGrowth ?? Number.NEGATIVE_INFINITY) ||
      left.service.localeCompare(right.service),
  );
  const winner = ranked[0]?.service ?? analyzed[0]?.service ?? "";
  const first = ranked[0]?.latestGrowth;
  const second = ranked[1]?.latestGrowth;
  const margin =
    first === undefined || second === undefined ? 0 : Math.abs(first - second);
  const winnerChanges = ranked[0]?.changes
    .map((change) => change.percentageChange)
    .filter((value): value is number => value !== undefined) ?? [];
  const directionConsistent =
    winnerChanges.length > 1 &&
    winnerChanges.every((value) => Math.sign(value) === Math.sign(winnerChanges[0] ?? 0));
  const confidence =
    margin >= 0.25 && directionConsistent
      ? "high"
      : margin >= 0.15 || directionConsistent
        ? "moderate"
        : "low";
  return { winner, confidence, services: analyzed };
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
  private createdTaskTimelineCache?: {
    start: number;
    end: number;
    tasks: Record<string, unknown>[];
  };

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

  private async analyzeClientTaskCounts(input: unknown): Promise<Evidence> {
    if (!isRecord(input) || typeof input.year !== "number") {
      throw new Error("Client task analysis requires a calendar year");
    }
    const timeZone =
      typeof input.time_zone === "string" && input.time_zone.trim()
        ? input.time_zone.trim()
        : "America/Los_Angeles";
    const bounds = yearBoundsInTimeZone(input.year, timeZone);
    const result = await getTasksCreatedBetween(
      (arguments_) => this.callAsanaTool("search_tasks", arguments_),
      {},
      bounds.start,
      bounds.end,
      "gid,name,created_at,parent.gid,parent.name,parent.projects.gid,parent.projects.name,projects.gid,projects.name",
    );
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
    const total = await countTasksByCreatedAt(
      (arguments_) => this.callAsanaTool("search_tasks", arguments_),
      {},
      bounds.start,
      bounds.end,
    );
    const matches: Array<{ term: string; tasks: Record<string, unknown>[] }> = [];
    let queryCount = total.queryCount;
    for (const term of terms) {
      const result = await getTasksCreatedBetween(
        (arguments_) => this.callAsanaTool("search_tasks", arguments_),
        { text: term },
        bounds.start,
        bounds.end,
        "gid,created_at",
      );
      matches.push({ term, tasks: result.tasks });
      queryCount += result.queryCount;
    }
    const analysis = calculateTaskMentionAnalysis(total.count, matches);
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
        `${analysis.matchingTaskCount} of ${total.count} tasks (${percentage}%) created in ${input.year} matched the Asana full-text terms for ${topic}. Term counts before deduplication: ${termDetails}.`,
      ),
      data: {
        ...analysis,
        totalTaskCount: total.count,
        topic,
        terms,
        year: input.year,
        timeZone,
        queryCount,
        exact: true,
        searchSemantics: "Asana full-text match across task names, descriptions, and comments",
        method: "partitioned_created_at_full_text_union",
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
    const counts = await Promise.all(
      periods.map(async (period) => {
        const bounds = dateRangeBoundsInTimeZone(period.from, period.through, timeZone);
        const result = await countTasksByCreatedAt(
          (arguments_) => this.callAsanaTool("search_tasks", arguments_),
          {},
          bounds.start,
          bounds.end,
        );
        return {
          ...period,
          count: result.count,
          queryCount: result.queryCount,
          range: {
            start: bounds.start.toISOString(),
            endExclusive: bounds.end.toISOString(),
          },
        };
      }),
    );
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
    for (const term of uniqueTerms) {
      const result = await getTasksCreatedByCursor(
        (arguments_) => this.callAsanaTool("search_tasks", arguments_),
        overallStart,
        overallEnd,
        "gid,created_at",
        { text: term },
      );
      termTasks.set(term.toLowerCase(), result.tasks);
      queryCount += result.queryCount;
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

  private async getCreatedTaskTimeline(
    start: Date,
    end: Date,
  ): Promise<{ tasks: Record<string, unknown>[]; queryCount: number }> {
    const startTime = start.getTime();
    const endTime = end.getTime();
    const cache = this.createdTaskTimelineCache;
    if (cache && cache.start <= startTime && cache.end >= endTime) {
      return {
        tasks: cache.tasks.filter((task) => {
          if (typeof task.created_at !== "string") return false;
          const createdAt = Date.parse(task.created_at);
          return createdAt >= startTime && createdAt < endTime;
        }),
        queryCount: 0,
      };
    }
    const result = await getTasksCreatedByCursor(
      (arguments_) => this.callAsanaTool("search_tasks", arguments_),
      start,
      end,
      "gid,created_at",
    );
    this.createdTaskTimelineCache = {
      start: startTime,
      end: endTime,
      tasks: result.tasks,
    };
    return result;
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

function asanaRateLimitDelay(result: unknown): number {
  const seconds = Number(extractMcpText(result).match(/wait\s+(\d+)\s+seconds?/i)?.[1] ?? 60);
  return Math.min(Math.max(seconds, 1), 60) * 1000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function mergeTaskCollections(
  collections: Array<{ tasks: Record<string, unknown>[]; queryCount: number }>,
): { tasks: Record<string, unknown>[]; queryCount: number } {
  const tasks = new Map<string, Record<string, unknown>>();
  for (const collection of collections) {
    for (const task of collection.tasks) {
      if (typeof task.gid === "string") tasks.set(task.gid, task);
    }
  }
  return {
    tasks: [...tasks.values()],
    queryCount: 1 + collections.reduce((sum, collection) => sum + collection.queryCount, 0),
  };
}

function calendarMonthInTimeZone(
  timestamp: string,
  timeZone: string,
): { year: number; month: number } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid task creation time: ${timestamp}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

function taskProjects(task: Record<string, unknown>): Array<{ gid: string; name: string }> {
  const direct = projectRecords(task.projects);
  if (direct.length > 0) return direct;
  return isRecord(task.parent) ? projectRecords(task.parent.projects) : [];
}

function projectRecords(value: unknown): Array<{ gid: string; name: string }> {
  if (!Array.isArray(value)) return [];
  const projects = new Map<string, { gid: string; name: string }>();
  for (const project of value) {
    if (
      isRecord(project) &&
      typeof project.gid === "string" &&
      typeof project.name === "string"
    ) {
      projects.set(project.gid, { gid: project.gid, name: project.name.trim() });
    }
  }
  return [...projects.values()];
}

function classifyProjectClient(
  projectName: string,
  allProjectNames: string[],
): { key: string; label: string; classification: "client" | "internal" | "unclassified" } {
  const name = projectName.trim();
  if (/^(?:ontix|pm templates|resources\s*:)/i.test(name)) {
    return { key: `internal:${name.toLowerCase()}`, label: name, classification: "internal" };
  }
  if (/^RP$/i.test(name)) {
    return { key: "unclassified:rp", label: "RP", classification: "unclassified" };
  }

  const code = name.match(/^([A-Za-z]{2,8})-\d{2,3}(?:-\d{2,3})?\b/)?.[1]?.toUpperCase();
  if (code) {
    const exact = allProjectNames.find(
      (candidate) => candidate.trim().toUpperCase() === code,
    );
    const expanded = allProjectNames.find((candidate) => {
      const firstWord = candidate.trim().split(/\s+/)[0] ?? "";
      return (
        !candidate.match(/^([A-Za-z]{2,8})-\d/) &&
        firstWord.length > code.length &&
        firstWord.toUpperCase().startsWith(code)
      );
    });
    const label = exact?.trim() || expanded?.trim() || code;
    return { key: label.toLowerCase(), label, classification: "client" };
  }

  const label = name
    .replace(/\s+\(internal\)\s*$/i, "")
    .replace(/\s+(?:Pharmacy Solutions\s+)?Website\b.*$/i, "")
    .replace(/\s+Support\b.*$/i, "")
    .trim();
  return { key: label.toLowerCase(), label, classification: "client" };
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
  const parsed = parseCalendarDate(date);
  const target = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
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

function parseCalendarDate(date: string): { year: number; month: number; day: number } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  return { year, month, day };
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
