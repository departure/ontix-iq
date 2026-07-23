import type { QueryCacheHitMetadata } from "../../../src/core/cache.js";

export type AsanaCacheScope = {
  organizationId: string;
  userId: string;
  credentialFingerprint: string;
};

export type QueryEvidenceMetadata = QueryCacheHitMetadata & {
  queryCount: number;
};

export type CreatedTaskProjection = "timeline" | "term" | "project-parent";

export type CreatedTaskQuerySpec = {
  start: Date;
  end: Date;
  filters?: Record<string, unknown>;
  projection: CreatedTaskProjection;
  term?: string;
};

export type AssignedTaskQuerySpec = {
  assignee: string;
  filters?: Record<string, unknown>;
  projection: string;
};

export type TaskQueryResult = {
  tasks: Record<string, unknown>[];
  queryCount: number;
  cache: QueryEvidenceMetadata;
};
