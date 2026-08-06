import { AsanaMcpClient, extractDataRows, extractMcpText, isRecord } from "./mcp.js";

export const TASK_SEARCH_LIMIT = 100;
/** Hard ceiling so a runaway partition cannot exhaust the Worker. */
export const MAX_EXHAUSTIVE_TASKS = 5000;

type ToolCall = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Collect created tasks across a date range by recursively partitioning when MCP's
 * search_tasks page is full (100).
 */
export async function getTasksCreatedBetween(
  search: ToolCall,
  filters: Record<string, unknown>,
  start: Date,
  end: Date,
): Promise<Record<string, unknown>[]> {
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
  ): Promise<Record<string, unknown>[]> => {
    const result = await search({
      ...windowFilters,
      created_at_after: new Date(windowStart.getTime() - 1).toISOString(),
      created_at_before: windowEnd.toISOString(),
      sort_by: "created_at",
      sort_ascending: true,
      limit: TASK_SEARCH_LIMIT,
    });
    const tasks = extractDataRows(result).map((task) => {
      if (!isRecord(task) || typeof task.gid !== "string") {
        throw new Error("Asana created-task search returned a task without a GID");
      }
      return task;
    });
    if (tasks.length < TASK_SEARCH_LIMIT) return tasks;

    const duration = windowEnd.getTime() - windowStart.getTime();
    if (duration > 1) {
      const midpoint = new Date(windowStart.getTime() + Math.floor(duration / 2));
      const [left, right] = await Promise.all([
        collectWindow(windowStart, midpoint, windowFilters),
        collectWindow(midpoint, windowEnd, windowFilters),
      ]);
      return mergeByGid([left, right]);
    }

    for (const field of ["completed", "is_subtask"] as const) {
      if (windowFilters[field] === undefined) {
        const partitions = await Promise.all([
          collectWindow(windowStart, windowEnd, { ...windowFilters, [field]: false }),
          collectWindow(windowStart, windowEnd, { ...windowFilters, [field]: true }),
        ]);
        return mergeByGid(partitions);
      }
    }

    if (windowFilters.resource_subtype === undefined) {
      const partitions = await Promise.all(
        ["default_task", "milestone", "approval"].map((resource_subtype) =>
          collectWindow(windowStart, windowEnd, { ...windowFilters, resource_subtype }),
        ),
      );
      return mergeByGid(partitions);
    }

    throw new Error("More than 100 tasks share the same creation millisecond and task type");
  };

  const tasks = await collectWindow(start, end, filters);
  if (tasks.length > MAX_EXHAUSTIVE_TASKS) {
    throw new Error(
      `Asana exhaustive search exceeded ${MAX_EXHAUSTIVE_TASKS} tasks; narrow the date range`,
    );
  }
  return tasks;
}

/** Follow get_tasks offset pagination until exhaustion. */
export async function getAllAssignedTasks(
  getTasks: ToolCall,
  assignee: string,
  filters: { completed?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const tasks = new Map<string, Record<string, unknown>>();
  const seenOffsets = new Set<string>();
  let offset: string | undefined;
  let pageCount = 0;
  do {
    const result = await getTasks({
      assignee,
      limit: TASK_SEARCH_LIMIT,
      ...(filters.completed !== undefined ? { completed: filters.completed } : {}),
      ...(offset ? { offset } : {}),
    });
    if (isRecord(result) && result.isError === true) {
      throw new Error(`Asana assigned-task retrieval failed: ${extractMcpText(result)}`);
    }
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

  if (tasks.size > MAX_EXHAUSTIVE_TASKS) {
    throw new Error(
      `Asana assigned-task retrieval exceeded ${MAX_EXHAUSTIVE_TASKS} tasks; narrow the filters`,
    );
  }
  return [...tasks.values()];
}

function extractTaskPage(result: unknown): { tasks: Record<string, unknown>[]; offset?: string } {
  let payload: unknown =
    isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : undefined;
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

function mergeByGid(collections: Record<string, unknown>[][]): Record<string, unknown>[] {
  const tasks = new Map<string, Record<string, unknown>>();
  for (const collection of collections) {
    for (const task of collection) {
      if (typeof task.gid === "string") tasks.set(task.gid, task);
    }
  }
  return [...tasks.values()];
}

export function endOfDayUtc(dateYmd: string): Date {
  return new Date(`${dateYmd}T23:59:59.999Z`);
}

export function startOfDayUtc(dateYmd: string): Date {
  return new Date(`${dateYmd}T00:00:00.000Z`);
}

export async function searchTasksViaMcp(
  client: AsanaMcpClient,
  options: {
    text?: string;
    startDate?: string;
    endDate?: string;
    assigneeGid?: string;
    completed?: boolean;
    limit?: number;
    workspaceGid: string;
  },
): Promise<Record<string, unknown>[]> {
  // Assignee queries must use get_tasks + offset pagination. search_tasks is capped and incomplete
  // for "how many tasks are assigned to X".
  if (options.assigneeGid) {
    return getAllAssignedTasks(
      (args) => client.getTasks(args),
      options.assigneeGid,
      { completed: options.completed },
    );
  }

  const filters: Record<string, unknown> = {};
  if (options.text) filters.text = options.text;
  if (options.completed !== undefined) filters.completed = options.completed;
  if (options.workspaceGid) filters.workspace = options.workspaceGid;

  const search = (args: Record<string, unknown>) => client.searchTasks({ ...filters, ...args });

  if (options.startDate && options.endDate) {
    return getTasksCreatedBetween(
      search,
      filters,
      startOfDayUtc(options.startDate),
      endOfDayUtc(options.endDate),
    );
  }

  const limit = Math.min(Math.max(options.limit ?? TASK_SEARCH_LIMIT, 1), TASK_SEARCH_LIMIT);
  const args: Record<string, unknown> = { limit };
  if (options.startDate) args.created_at_after = `${options.startDate}T00:00:00.000Z`;
  if (options.endDate) args.created_at_before = `${options.endDate}T23:59:59.999Z`;
  return extractDataRows(await search(args)).filter(isRecord);
}

export async function findUsersViaMcp(
  client: AsanaMcpClient,
  workspaceGid: string,
  query: string,
): Promise<Array<{ gid: string; name: string; email?: string }>> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  // Prefer workspace user list; fall back to search_objects.
  try {
    const result = await client.callTool("get_users", {
      workspace: workspaceGid,
      opt_fields: "gid,name,email",
    });
    const rows = extractDataRows(result);
    return rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.gid !== "string") return [];
      const name = String(row.name ?? "");
      const email = typeof row.email === "string" ? row.email : undefined;
      const haystack = `${name} ${email ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return [];
      return [{ gid: row.gid, name, ...(email ? { email } : {}) }];
    });
  } catch {
    const result = await client.callTool("search_objects", {
      query,
      resource_type: "user",
      workspace: workspaceGid,
    });
    return extractDataRows(result).flatMap((row) => {
      if (!isRecord(row) || typeof row.gid !== "string") return [];
      return [{
        gid: row.gid,
        name: String(row.name ?? ""),
        ...(typeof row.email === "string" ? { email: row.email } : {}),
      }];
    });
  }
}
