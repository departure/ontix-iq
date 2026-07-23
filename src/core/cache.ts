import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type CanonicalValue =
  | JsonPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

declare const cacheKeyBrand: unique symbol;
export type CacheKey = string & { readonly [cacheKeyBrand]: true };

export type QueryFreshness = "open" | "closed";

export const QUERY_CACHE_TTL_MS: Readonly<Record<QueryFreshness, number>> = {
  open: 15 * 60 * 1000,
  closed: 24 * 60 * 60 * 1000,
};

export type QueryCacheOptions = {
  freshness: QueryFreshness;
};

export type QueryCacheHitMetadata = {
  hit: boolean;
  tier: "memory" | "disk" | "loader";
  ageMs: number;
};

export type QueryCacheResult<T extends JsonValue> = {
  value: T;
  cache: QueryCacheHitMetadata;
};

export interface QueryCache {
  get<T extends JsonValue>(key: CacheKey): Promise<T | undefined>;
  getWithMetadata<T extends JsonValue>(
    key: CacheKey,
  ): Promise<QueryCacheResult<T> | undefined>;
  set<T extends JsonValue>(
    key: CacheKey,
    value: T,
    options: QueryCacheOptions,
  ): Promise<void>;
  getOrLoad<T extends JsonValue>(
    key: CacheKey,
    options: QueryCacheOptions,
    load: () => Promise<T>,
  ): Promise<T>;
  getOrLoadWithMetadata<T extends JsonValue>(
    key: CacheKey,
    options: QueryCacheOptions,
    load: () => Promise<T>,
  ): Promise<QueryCacheResult<T>>;
  delete(key: CacheKey): Promise<void>;
  close?(): Promise<void>;
}

export function queryCacheKey(input: CanonicalValue): CacheKey {
  const canonical = canonicalJson(input);
  return `q1-${createHash("sha256").update(canonical).digest("hex")}` as CacheKey;
}

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cache keys require finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, CanonicalValue] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
