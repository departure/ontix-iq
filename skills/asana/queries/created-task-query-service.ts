import {
  QUERY_CACHE_TTL_MS,
  queryCacheKey,
  type CacheKey,
  type JsonValue,
  type QueryCache,
} from "../../../src/core/cache.js";
import {
  createdTaskCacheKey,
  normalizeFilters,
  queryFreshness,
} from "./normalization.js";
import type {
  AsanaCacheScope,
  CreatedTaskQuerySpec,
  TaskQueryResult,
} from "./types.js";

type CreatedTaskLoader = (
  spec: CreatedTaskQuerySpec,
) => Promise<{ tasks: Record<string, unknown>[]; queryCount: number }>;

type CachedTasks = {
  tasks: Record<string, unknown>[];
  sourceQueryCount: number;
};

type CoveringEntry = CachedTasks & {
  start: number;
  end: number;
  storedAt: number;
  expiresAt: number;
};

export class CreatedTaskQueryService {
  private readonly covering = new Map<string, CoveringEntry[]>();

  constructor(
    private readonly cache: QueryCache,
    private readonly scope: () => Promise<AsanaCacheScope>,
    private readonly load: CreatedTaskLoader,
    private readonly now: () => number = Date.now,
  ) {}

  async query(spec: CreatedTaskQuerySpec): Promise<TaskQueryResult> {
    const scope = await this.scope();
    const key = createdTaskCacheKey(scope, spec);
    const exact = await this.cache.getWithMetadata<JsonValue>(key);
    if (exact) {
      const value = asCachedTasks(exact.value);
      this.remember(scope, spec, value, this.now() - exact.cache.ageMs);
      return {
        tasks: value.tasks,
        queryCount: 0,
        cache: { ...exact.cache, queryCount: 0 },
      };
    }

    const covering = this.findCovering(scope, spec);
    if (covering) {
      const tasks = sliceTasks(covering.tasks, spec.start.getTime(), spec.end.getTime());
      return {
        tasks,
        queryCount: 0,
        cache: {
          hit: true,
          tier: "memory",
          ageMs: Math.max(0, this.now() - covering.storedAt),
          queryCount: 0,
        },
      };
    }
    const persistedCovering = await this.cache.getWithMetadata<JsonValue>(
      this.coveringKey(scope, spec),
    );
    if (persistedCovering) {
      const entry = asCoveringEntry(persistedCovering.value);
      if (entry.start <= spec.start.getTime() && entry.end >= spec.end.getTime()) {
        return {
          tasks: sliceTasks(entry.tasks, spec.start.getTime(), spec.end.getTime()),
          queryCount: 0,
          cache: { ...persistedCovering.cache, queryCount: 0 },
        };
      }
    }

    const loaded = await this.cache.getOrLoadWithMetadata<JsonValue>(
      key,
      { freshness: queryFreshness(spec.end, new Date(this.now())) },
      async () => {
        const result = await this.load(spec);
        return {
          tasks: result.tasks,
          sourceQueryCount: result.queryCount,
        } as JsonValue;
      },
    );
    const value = asCachedTasks(loaded.value);
    this.remember(scope, spec, value, this.now() - loaded.cache.ageMs);
    if (!loaded.cache.hit) {
      await this.cache.set(
        this.coveringKey(scope, spec),
        {
          ...value,
          start: spec.start.getTime(),
          end: spec.end.getTime(),
        } as JsonValue,
        { freshness: queryFreshness(spec.end, new Date(this.now())) },
      );
    }
    const queryCount = loaded.cache.hit ? 0 : value.sourceQueryCount;
    return {
      tasks: value.tasks,
      queryCount,
      cache: { ...loaded.cache, queryCount },
    };
  }

  timeline(start: Date, end: Date): Promise<TaskQueryResult> {
    return this.query({ start, end, projection: "timeline" });
  }

  term(start: Date, end: Date, term: string): Promise<TaskQueryResult> {
    const normalizedTerm = term.trim().toLocaleLowerCase();
    return this.query({
      start,
      end,
      projection: "term",
      term: normalizedTerm,
      filters: { text: normalizedTerm },
    });
  }

  projectParent(start: Date, end: Date): Promise<TaskQueryResult> {
    return this.query({ start, end, projection: "project-parent" });
  }

  private coveringKey(scope: AsanaCacheScope, spec: CreatedTaskQuerySpec): CacheKey {
    return queryCacheKey({
      provider: "asana",
      namespace: `created-tasks-covering:${spec.projection}`,
      schemaVersion: 1,
      scope,
      filters: normalizeFilters(spec.filters),
      projection: spec.projection,
      term: spec.term?.trim().toLocaleLowerCase(),
    });
  }

  private findCovering(
    scope: AsanaCacheScope,
    spec: CreatedTaskQuerySpec,
  ): CoveringEntry | undefined {
    const start = spec.start.getTime();
    const end = spec.end.getTime();
    const key = this.coveringKey(scope, spec);
    const fresh = (this.covering.get(key) ?? []).filter(
      (entry) => entry.expiresAt > this.now(),
    );
    if (fresh.length === 0) {
      this.covering.delete(key);
      return undefined;
    }
    this.covering.set(key, fresh);
    return fresh
      .filter((entry) => entry.start <= start && entry.end >= end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
  }

  private remember(
    scope: AsanaCacheScope,
    spec: CreatedTaskQuerySpec,
    value: CachedTasks,
    storedAt: number,
  ): void {
    const key = this.coveringKey(scope, spec);
    const entries = this.covering.get(key) ?? [];
    const next = entries.filter(
      (entry) => entry.start !== spec.start.getTime() || entry.end !== spec.end.getTime(),
    );
    next.push({
      ...value,
      start: spec.start.getTime(),
      end: spec.end.getTime(),
      storedAt,
      expiresAt:
        storedAt +
        QUERY_CACHE_TTL_MS[queryFreshness(spec.end, new Date(storedAt))],
    });
    this.covering.set(key, next);
  }
}

function asCachedTasks(value: JsonValue): CachedTasks {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Invalid cached Asana task result");
  }
  const object = value as { readonly [key: string]: JsonValue };
  if (!Array.isArray(object.tasks) || typeof object.sourceQueryCount !== "number") {
    throw new Error("Invalid cached Asana task result");
  }
  return {
    tasks: (object.tasks as readonly JsonValue[]).map((task: JsonValue) => {
      if (typeof task !== "object" || task === null || Array.isArray(task)) {
        throw new Error("Invalid cached Asana task");
      }
      return task as Record<string, unknown>;
    }),
    sourceQueryCount: object.sourceQueryCount as number,
  };
}

function asCoveringEntry(value: JsonValue): CoveringEntry {
  const cached = asCachedTasks(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid cached Asana covering range");
  }
  const object = value as { readonly [key: string]: JsonValue };
  if (typeof object.start !== "number" || typeof object.end !== "number") {
    throw new Error("Invalid cached Asana covering range");
  }
  return {
    ...cached,
    start: object.start,
    end: object.end,
    storedAt: 0,
    expiresAt: 0,
  };
}

function sliceTasks(
  tasks: Record<string, unknown>[],
  start: number,
  end: number,
): Record<string, unknown>[] {
  return tasks.filter((task) => {
    if (typeof task.created_at !== "string") return false;
    const createdAt = Date.parse(task.created_at);
    return createdAt >= start && createdAt < end;
  });
}
