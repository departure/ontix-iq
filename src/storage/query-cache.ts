import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  QUERY_CACHE_TTL_MS,
  type CacheKey,
  type JsonValue,
  type QueryCache,
  type QueryCacheResult,
  type QueryCacheOptions,
} from "../core/cache.js";
import {
  decryptJson,
  encryptJson,
  LocalEncryptionKey,
  type EncryptedPayload,
} from "./encryption.js";

type CacheEntry = {
  version: 1;
  createdAt: number;
  expiresAt: number;
  value: JsonValue;
};

type MemoryEntry = {
  createdAt: number;
  expiresAt: number;
  value: JsonValue;
};

export type TwoTierQueryCacheOptions = {
  now?: () => number;
};

export class TwoTierQueryCache implements QueryCache {
  private readonly cacheDir: string;
  private readonly encryptionKey: LocalEncryptionKey;
  private readonly now: () => number;
  private readonly memory = new Map<CacheKey, MemoryEntry>();
  private readonly flights = new Map<CacheKey, Promise<QueryCacheResult<JsonValue>>>();

  constructor(
    dataDir: string,
    configuredKey?: string,
    options: TwoTierQueryCacheOptions = {},
  ) {
    this.cacheDir = join(dataDir, "cache");
    this.encryptionKey = new LocalEncryptionKey(dataDir, configuredKey);
    this.now = options.now ?? Date.now;
  }

  async get<T extends JsonValue>(key: CacheKey): Promise<T | undefined> {
    return (await this.getWithMetadata<T>(key))?.value;
  }

  async getWithMetadata<T extends JsonValue>(
    key: CacheKey,
  ): Promise<QueryCacheResult<T> | undefined> {
    const memoryEntry = this.memory.get(key);
    if (memoryEntry) {
      if (memoryEntry.expiresAt > this.now()) {
        return {
          value: memoryEntry.value as T,
          cache: {
            hit: true,
            tier: "memory",
            ageMs: Math.max(0, this.now() - memoryEntry.createdAt),
          },
        };
      }
      this.memory.delete(key);
    }

    const path = this.pathFor(key);
    let serialized: string;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const encryptionKey = await this.encryptionKey.get(false);
    if (!encryptionKey) return undefined;
    let entry: CacheEntry;
    try {
      const payload = JSON.parse(serialized) as EncryptedPayload;
      const decrypted = decryptJson(payload, encryptionKey, key);
      if (!isCacheEntry(decrypted)) throw new Error("Invalid cache entry");
      entry = decrypted;
    } catch {
      await this.removeFile(path).catch(() => undefined);
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      await this.removeFile(path).catch(() => undefined);
      return undefined;
    }
    this.memory.set(key, entry);
    return {
      value: entry.value as T,
      cache: {
        hit: true,
        tier: "disk",
        ageMs: Math.max(0, this.now() - entry.createdAt),
      },
    };
  }

  async set<T extends JsonValue>(
    key: CacheKey,
    value: T,
    options: QueryCacheOptions,
  ): Promise<void> {
    if (!isJsonValue(value)) throw new TypeError("Query cache values must be JSON-compatible");
    const entry: CacheEntry = {
      version: 1,
      createdAt: this.now(),
      expiresAt: this.now() + QUERY_CACHE_TTL_MS[options.freshness],
      value,
    };
    const encryptionKey = await this.encryptionKey.get(true);
    if (!encryptionKey) throw new Error("Unable to create cache encryption key");
    const payload = encryptJson(entry, encryptionKey, key);
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = this.pathFor(key);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.memory.set(key, entry);
  }

  async getOrLoad<T extends JsonValue>(
    key: CacheKey,
    options: QueryCacheOptions,
    load: () => Promise<T>,
  ): Promise<T> {
    return (await this.getOrLoadWithMetadata(key, options, load)).value;
  }

  async getOrLoadWithMetadata<T extends JsonValue>(
    key: CacheKey,
    options: QueryCacheOptions,
    load: () => Promise<T>,
  ): Promise<QueryCacheResult<T>> {
    const active = this.flights.get(key);
    if (active) return active as Promise<QueryCacheResult<T>>;

    const flight = (async (): Promise<QueryCacheResult<T>> => {
      const cached = await this.getWithMetadata<T>(key);
      if (cached !== undefined) return cached;
      const value = await load();
      await this.set(key, value, options);
      return {
        value,
        cache: { hit: false, tier: "loader", ageMs: 0 },
      };
    })();
    this.flights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    }
  }

  async delete(key: CacheKey): Promise<void> {
    this.memory.delete(key);
    await this.removeFile(this.pathFor(key));
  }

  async close(): Promise<void> {
    this.memory.clear();
    this.flights.clear();
  }

  private pathFor(key: CacheKey): string {
    if (!/^q1-[a-f0-9]{64}$/.test(key)) throw new TypeError("Invalid query cache key");
    return join(this.cacheDir, `${key}.json`);
  }

  private async removeFile(path: string): Promise<void> {
    try {
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    isJsonValue(value.value)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
