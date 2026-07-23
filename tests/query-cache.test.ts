import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUERY_CACHE_TTL_MS,
  canonicalJson,
  queryCacheKey,
} from "../src/core/cache.js";
import { TwoTierQueryCache } from "../src/storage/query-cache.js";
import { EncryptedTokenStore } from "../skills/asana/auth/token-store.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ontix-cache-"));
  created.push(path);
  return path;
}

describe("query cache keys", () => {
  it("canonicalizes object order before hashing without exposing query data", () => {
    const left = queryCacheKey({
      provider: "asana",
      query: { completed: false, projects: ["2", "1"] },
    });
    const right = queryCacheKey({
      query: { projects: ["2", "1"], completed: false },
      provider: "asana",
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^q1-[a-f0-9]{64}$/);
    expect(left).not.toContain("asana");
    expect(
      queryCacheKey({ provider: "asana", query: { projects: ["1", "2"] } }),
    ).not.toBe(left);
    expect(canonicalJson({ omitted: undefined, retained: null })).toBe('{"retained":null}');
  });
});

describe("TwoTierQueryCache", () => {
  it("reports an L1 hit after loading once", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    const key = queryCacheKey({ operation: "l1-hit" });
    const load = vi.fn(async () => ({ answer: 42 }));

    const cold = await cache.getOrLoadWithMetadata(key, { freshness: "open" }, load);
    const warm = await cache.getOrLoadWithMetadata(key, { freshness: "open" }, load);

    expect(cold.cache).toMatchObject({ hit: false, tier: "loader" });
    expect(warm.cache).toMatchObject({ hit: true, tier: "memory" });
    expect(load).toHaveBeenCalledOnce();
  });

  it("uses one loader for concurrent misses and caches the result in memory", async () => {
    const dataDir = await directory();
    const cache = new TwoTierQueryCache(dataDir, "test-key");
    const key = queryCacheKey({ operation: "singleflight" });
    const load = vi.fn(async () => {
      await Promise.resolve();
      return { answer: 42 };
    });

    const results = await Promise.all([
      cache.getOrLoad(key, { freshness: "open" }, load),
      cache.getOrLoad(key, { freshness: "open" }, load),
      cache.getOrLoad(key, { freshness: "open" }, load),
    ]);

    expect(results).toEqual([{ answer: 42 }, { answer: 42 }, { answer: 42 }]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get(key)).toEqual({ answer: 42 });
  });

  it("supports 15-minute open and 24-hour closed TTLs", async () => {
    const dataDir = await directory();
    let now = 1_000;
    const cache = new TwoTierQueryCache(dataDir, "test-key", { now: () => now });
    const openKey = queryCacheKey({ state: "open" });
    const closedKey = queryCacheKey({ state: "closed" });
    await cache.set(openKey, "open-value", { freshness: "open" });
    await cache.set(closedKey, "closed-value", { freshness: "closed" });

    now += QUERY_CACHE_TTL_MS.open;
    expect(await cache.get(openKey)).toBeUndefined();
    expect(await cache.get(closedKey)).toBe("closed-value");

    now = 1_000 + QUERY_CACHE_TTL_MS.closed;
    expect(await cache.get(closedKey)).toBeUndefined();
  });

  it("persists encrypted L2 entries with private file modes", async () => {
    const dataDir = await directory();
    const key = queryCacheKey({ operation: "persist" });
    const cache = new TwoTierQueryCache(dataDir);
    await cache.set(key, { secret: "plaintext-must-not-appear" }, { freshness: "closed" });

    const cachePath = join(dataDir, "cache", `${key}.json`);
    const keyPath = join(dataDir, "secrets", "local-token.key");
    expect(await readFile(cachePath, "utf8")).not.toContain("plaintext-must-not-appear");
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const restarted = new TwoTierQueryCache(dataDir);
    expect(await restarted.getWithMetadata(key)).toMatchObject({
      value: { secret: "plaintext-must-not-appear" },
      cache: { hit: true, tier: "disk" },
    });
    expect(await restarted.getWithMetadata(key)).toMatchObject({
      value: { secret: "plaintext-must-not-appear" },
      cache: { hit: true, tier: "memory" },
    });
  });

  it("treats malformed or unauthenticated disk entries as misses", async () => {
    const dataDir = await directory();
    const key = queryCacheKey({ operation: "corruption" });
    const cache = new TwoTierQueryCache(dataDir, "test-key");
    await cache.set(key, { valid: true }, { freshness: "closed" });
    await writeFile(join(dataDir, "cache", `${key}.json`), '{"version":1,"ciphertext":"bad"}');

    const restarted = new TwoTierQueryCache(dataDir, "test-key");
    expect(await restarted.get(key)).toBeUndefined();
  });

  it("keeps Asana token encryption compatible with the shared local key", async () => {
    const dataDir = await directory();
    const tokens = new EncryptedTokenStore(dataDir);
    await tokens.write({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "bearer",
    });

    expect(await tokens.read()).toMatchObject({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    });
    const cache = new TwoTierQueryCache(dataDir);
    const key = queryCacheKey({ operation: "shared-key" });
    await cache.set(key, "cached", { freshness: "open" });
    expect(await new TwoTierQueryCache(dataDir).get(key)).toBe("cached");
  });

  it("does not cache loader failures", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    const key = queryCacheKey({ operation: "failure" });
    const load = vi
      .fn<() => Promise<{ recovered: boolean }>>()
      .mockRejectedValueOnce(new Error("temporary MCP failure"))
      .mockResolvedValueOnce({ recovered: true });

    await expect(cache.getOrLoad(key, { freshness: "open" }, load)).rejects.toThrow(
      "temporary MCP failure",
    );
    await expect(cache.getOrLoad(key, { freshness: "open" }, load)).resolves.toEqual({
      recovered: true,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clears L1 on close while leaving encrypted L2 reusable", async () => {
    const dataDir = await directory();
    const cache = new TwoTierQueryCache(dataDir, "test-key");
    const key = queryCacheKey({ operation: "close" });
    await cache.set(key, "cached", { freshness: "open" });
    expect((await cache.getWithMetadata(key))?.cache.tier).toBe("memory");

    await cache.close();

    expect(await cache.getWithMetadata(key)).toMatchObject({
      value: "cached",
      cache: { hit: true, tier: "disk" },
    });
  });
});
