import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssignedTaskQueryService,
  CreatedTaskQueryService,
} from "../skills/asana/queries/index.js";
import { AsanaOAuthProvider } from "../skills/asana/auth/provider.js";
import { EncryptedTokenStore } from "../skills/asana/auth/token-store.js";
import { readConfig } from "../src/config.js";
import { QUERY_CACHE_TTL_MS } from "../src/core/cache.js";
import { TwoTierQueryCache } from "../src/storage/query-cache.js";

const createdDirectories: string[] = [];
const scope = async () => ({
  organizationId: "org-1",
  userId: "user-1",
  credentialFingerprint: "authorization-1",
});

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ontix-asana-query-"));
  createdDirectories.push(path);
  return path;
}

describe("CreatedTaskQueryService", () => {
  it("slices a fresh covering timeline without another MCP retrieval", async () => {
    const dataDir = await directory();
    const cache = new TwoTierQueryCache(dataDir, "test-key");
    const load = vi.fn(async () => ({
      tasks: [
        { gid: "1", created_at: "2025-01-01T00:00:00.000Z" },
        { gid: "2", created_at: "2025-06-01T00:00:00.000Z" },
        { gid: "3", created_at: "2026-01-01T00:00:00.000Z" },
      ],
      queryCount: 3,
    }));
    const service = new CreatedTaskQueryService(cache, scope, load);

    const broad = await service.timeline(
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );
    const restarted = new CreatedTaskQueryService(
      new TwoTierQueryCache(dataDir, "test-key"),
      scope,
      load,
    );
    const narrow = await restarted.timeline(
      new Date("2025-05-01T00:00:00.000Z"),
      new Date("2025-12-01T00:00:00.000Z"),
    );

    expect(broad.cache).toMatchObject({ hit: false, tier: "loader", queryCount: 3 });
    expect(narrow.tasks.map((task) => task.gid)).toEqual(["2"]);
    expect(narrow.cache).toMatchObject({ hit: true, tier: "disk", queryCount: 0 });
    expect(load).toHaveBeenCalledOnce();
  });

  it("caches full-text terms independently", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    const load = vi.fn(async (spec: { term?: string }) => ({
      tasks: [{ gid: spec.term, created_at: "2025-06-01T00:00:00.000Z" }],
      queryCount: 1,
    }));
    const service = new CreatedTaskQueryService(cache, scope, load);
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = new Date("2026-01-01T00:00:00.000Z");

    await service.term(start, end, "Video");
    const warm = await service.term(start, end, "video");
    await service.term(start, end, "YouTube");

    expect(warm.cache.hit).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("isolates organization, user, and credential scopes", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    let activeScope = await scope();
    const load = vi.fn(async () => ({
      tasks: [{ gid: activeScope.organizationId }],
      queryCount: 1,
    }));
    const service = new CreatedTaskQueryService(cache, async () => activeScope, load);
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = new Date("2026-01-01T00:00:00.000Z");

    await service.timeline(start, end);
    await service.timeline(start, end);
    activeScope = { ...activeScope, organizationId: "org-2" };
    await service.timeline(start, end);
    activeScope = { ...activeScope, userId: "user-2" };
    await service.timeline(start, end);
    activeScope = { ...activeScope, credentialFingerprint: "authorization-2" };
    await service.timeline(start, end);

    expect(load).toHaveBeenCalledTimes(4);
  });

  it("reuses a broad executive timeline for repeated and overlapping datasets", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    let mcpRequestCount = 0;
    const tasks = [
      { gid: "2023", created_at: "2023-06-01T00:00:00.000Z" },
      { gid: "2024", created_at: "2024-06-01T00:00:00.000Z" },
      { gid: "2025", created_at: "2025-06-01T00:00:00.000Z" },
      { gid: "2026", created_at: "2026-03-01T00:00:00.000Z" },
    ];
    const load = vi.fn(async (spec: { start: Date; end: Date }) => {
      mcpRequestCount += 1;
      return {
        tasks: tasks.filter((task) => {
          const timestamp = Date.parse(task.created_at);
          return timestamp >= spec.start.getTime() && timestamp < spec.end.getTime();
        }),
        queryCount: 1,
      };
    });
    const service = new CreatedTaskQueryService(cache, scope, load);
    const broadStart = new Date("2023-01-01T00:00:00.000Z");
    const broadEnd = new Date("2026-07-01T00:00:00.000Z");

    const monthlyAverageDataset = await service.timeline(broadStart, broadEnd);
    const coldRequests = mcpRequestCount;
    const repeatedMonthlyDataset = await service.timeline(broadStart, broadEnd);
    const quarterForecastDataset = await service.timeline(
      new Date("2023-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(monthlyAverageDataset.tasks).toHaveLength(4);
    expect(repeatedMonthlyDataset.cache).toMatchObject({ hit: true, queryCount: 0 });
    expect(quarterForecastDataset.tasks.map((task) => task.gid)).toEqual([
      "2023",
      "2024",
      "2025",
    ]);
    expect(quarterForecastDataset.cache).toMatchObject({ hit: true, queryCount: 0 });
    expect(coldRequests).toBe(1);
    expect(mcpRequestCount).toBe(coldRequests);
  });

  it("does not serve an expired in-memory covering range", async () => {
    const dataDir = await directory();
    let now = Date.parse("2026-07-01T00:00:00.000Z");
    const cache = new TwoTierQueryCache(dataDir, "test-key", { now: () => now });
    const load = vi.fn(async () => ({
      tasks: [{ gid: String(now), created_at: "2026-06-01T00:00:00.000Z" }],
      queryCount: 1,
    }));
    const service = new CreatedTaskQueryService(cache, scope, load, () => now);

    await service.timeline(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2027-01-01T00:00:00.000Z"),
    );
    now += QUERY_CACHE_TTL_MS.open;
    const narrow = await service.timeline(
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
    );

    expect(narrow.cache).toMatchObject({ hit: false, tier: "loader" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("AssignedTaskQueryService", () => {
  it("reuses a complete paginated assignee projection", async () => {
    const cache = new TwoTierQueryCache(await directory(), "test-key");
    const load = vi.fn(async () => ({
      tasks: [{ gid: "1" }, { gid: "2" }],
      pageCount: 2,
    }));
    const service = new AssignedTaskQueryService(cache, scope, load);
    const spec = { assignee: "person@example.com", projection: "gid" };

    const cold = await service.query(spec);
    const warm = await service.query(spec);

    expect(cold.pageCount).toBe(2);
    expect(warm.pageCount).toBe(2);
    expect(warm.cache).toMatchObject({ hit: true, queryCount: 0 });
    expect(load).toHaveBeenCalledOnce();
  });
});

describe("Asana credential cache scope", () => {
  it("removes stale tokens when the OAuth client invalidates credentials", async () => {
    const dataDir = await directory();
    const provider = new AsanaOAuthProvider(
      readConfig({
        NODE_ENV: "test",
        ASANA_CLIENT_ID: "client-id",
        ASANA_CLIENT_SECRET: "client-secret",
        ONTIX_DATA_DIR: dataDir,
        ONTIX_TOKEN_ENCRYPTION_KEY: "test-key",
      }),
    );
    await provider.tokenStore.write({
      access_token: "expired",
      refresh_token: "invalid",
      token_type: "bearer",
    });

    await provider.invalidateCredentials("tokens");

    await expect(provider.tokens()).resolves.toBeUndefined();
    await expect(provider.credentialFingerprint()).resolves.toBe("unauthorized");
  });

  it("survives refresh writes and changes on reauthorization", async () => {
    const store = new EncryptedTokenStore(await directory(), "test-key");
    await store.write({ access_token: "first", refresh_token: "refresh", token_type: "bearer" });
    const authorized = await store.credentialFingerprint();

    await store.write(
      { access_token: "rotated", refresh_token: "refresh-2", token_type: "bearer" },
      true,
    );
    expect(await store.credentialFingerprint()).toBe(authorized);

    await store.write({ access_token: "new-auth", refresh_token: "new", token_type: "bearer" });
    expect(await store.credentialFingerprint()).not.toBe(authorized);
  });

  it("keeps warm data after refresh and misses after reauthorization", async () => {
    const dataDir = await directory();
    const store = new EncryptedTokenStore(dataDir, "test-key");
    const cache = new TwoTierQueryCache(dataDir, "test-key");
    const load = vi.fn(async () => ({
      tasks: [{ gid: "1", created_at: "2025-06-01T00:00:00.000Z" }],
      queryCount: 1,
    }));
    const service = new CreatedTaskQueryService(
      cache,
      async () => ({
        organizationId: "org-1",
        userId: "user-1",
        credentialFingerprint: await store.credentialFingerprint(),
      }),
      load,
    );
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = new Date("2026-01-01T00:00:00.000Z");

    await store.write({ access_token: "first", refresh_token: "refresh", token_type: "bearer" });
    await service.timeline(start, end);
    await store.write(
      { access_token: "rotated", refresh_token: "refresh-2", token_type: "bearer" },
      true,
    );
    expect((await service.timeline(start, end)).cache.hit).toBe(true);

    await store.write({ access_token: "new-auth", refresh_token: "new", token_type: "bearer" });
    expect((await service.timeline(start, end)).cache.hit).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
