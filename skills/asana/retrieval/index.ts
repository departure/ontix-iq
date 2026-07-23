const taskSearchLimit = 100;

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

export function assignedTaskOptFields(filters: Record<string, unknown>): string {
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
