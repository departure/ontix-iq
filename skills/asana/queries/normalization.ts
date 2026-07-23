import {
  queryCacheKey,
  type CacheKey,
  type CanonicalValue,
  type QueryFreshness,
} from "../../../src/core/cache.js";
import type {
  AsanaCacheScope,
  AssignedTaskQuerySpec,
  CreatedTaskQuerySpec,
} from "./types.js";

export const ASANA_QUERY_SCHEMA_VERSION = 1;

export function createdTaskCacheKey(
  scope: AsanaCacheScope,
  spec: CreatedTaskQuerySpec,
): CacheKey {
  return queryCacheKey({
    provider: "asana",
    namespace: `created-tasks:${spec.projection}`,
    schemaVersion: ASANA_QUERY_SCHEMA_VERSION,
    scope,
    range: normalizeRange(spec.start, spec.end),
    filters: normalizeFilters(spec.filters),
    projection: spec.projection,
    term: spec.term?.trim().toLocaleLowerCase(),
  });
}

export function assignedTaskCacheKey(
  scope: AsanaCacheScope,
  spec: AssignedTaskQuerySpec,
): CacheKey {
  return queryCacheKey({
    provider: "asana",
    namespace: "assigned-tasks",
    schemaVersion: ASANA_QUERY_SCHEMA_VERSION,
    scope,
    assignee: spec.assignee.trim().toLocaleLowerCase(),
    filters: normalizeFilters(spec.filters),
    projection: normalizeProjection(spec.projection),
  });
}

export function queryFreshness(end: Date, now = new Date()): QueryFreshness {
  return end.getTime() <= now.getTime() ? "closed" : "open";
}

export function normalizeRange(
  start: Date,
  end: Date,
): { start: string; endExclusive: string } {
  const startTime = start.getTime();
  const endTime = end.getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new Error("Asana query requires a valid non-empty range");
  }
  return { start: start.toISOString(), endExclusive: end.toISOString() };
}

export function normalizeProjection(projection: string): string {
  return [
    ...new Set(
      projection
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(",");
}

export function normalizeFilters(
  filters: Record<string, unknown> = {},
): CanonicalValue {
  return normalizeValue(filters) as CanonicalValue;
}

function normalizeValue(value: unknown): CanonicalValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string" ? value.trim() : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Asana query filters require finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeValue)
      .filter((item): item is CanonicalValue => item !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, normalizeValue(item)] as const)
        .filter((entry): entry is readonly [string, CanonicalValue] => entry[1] !== undefined),
    );
  }
  return undefined;
}
