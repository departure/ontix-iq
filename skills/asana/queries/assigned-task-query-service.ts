import type { JsonValue, QueryCache } from "../../../src/core/cache.js";
import { assignedTaskCacheKey } from "./normalization.js";
import type {
  AsanaCacheScope,
  AssignedTaskQuerySpec,
  QueryEvidenceMetadata,
} from "./types.js";

type AssignedTaskLoader = (
  assignee: string,
  projection: string,
) => Promise<{ tasks: Record<string, unknown>[]; pageCount: number }>;

export type AssignedTaskQueryResult = {
  tasks: Record<string, unknown>[];
  pageCount: number;
  cache: QueryEvidenceMetadata;
};

export class AssignedTaskQueryService {
  constructor(
    private readonly cache: QueryCache,
    private readonly scope: () => Promise<AsanaCacheScope>,
    private readonly load: AssignedTaskLoader,
  ) {}

  async query(spec: AssignedTaskQuerySpec): Promise<AssignedTaskQueryResult> {
    const key = assignedTaskCacheKey(await this.scope(), spec);
    const result = await this.cache.getOrLoadWithMetadata<JsonValue>(
      key,
      { freshness: "open" },
      async () => {
        const loaded = await this.load(spec.assignee.trim(), spec.projection);
        return {
          tasks: loaded.tasks,
          sourcePageCount: loaded.pageCount,
        } as JsonValue;
      },
    );
    const value = asCachedAssignedTasks(result.value);
    const queryCount = result.cache.hit ? 0 : value.sourcePageCount;
    return {
      tasks: value.tasks,
      pageCount: value.sourcePageCount,
      cache: { ...result.cache, queryCount },
    };
  }
}

function asCachedAssignedTasks(value: JsonValue): {
  tasks: Record<string, unknown>[];
  sourcePageCount: number;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Invalid cached Asana assigned-task result");
  }
  const object = value as { readonly [key: string]: JsonValue };
  if (!Array.isArray(object.tasks) || typeof object.sourcePageCount !== "number") {
    throw new Error("Invalid cached Asana assigned-task result");
  }
  return {
    tasks: (object.tasks as readonly JsonValue[]).map((task: JsonValue) => {
      if (typeof task !== "object" || task === null || Array.isArray(task)) {
        throw new Error("Invalid cached Asana assigned task");
      }
      return task as Record<string, unknown>;
    }),
    sourcePageCount: object.sourcePageCount as number,
  };
}
