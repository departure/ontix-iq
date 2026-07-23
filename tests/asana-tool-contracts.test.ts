import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { TwoTierQueryCache } from "../src/storage/query-cache.js";
import * as compatibility from "../skills/asana/index.js";
import {
  analyzeClientTasks,
  calculateMonthlyTaskAverages,
} from "../skills/asana/analytics/index.js";
import {
  getTasksCreatedByCursor,
  parseTaskSearchCount,
} from "../skills/asana/retrieval/index.js";
import {
  dateRangeBoundsInTimeZone,
  monthBoundsInTimeZone,
} from "../skills/asana/time/index.js";
import { AsanaSkill } from "../skills/asana/tools/index.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function testConfig() {
  const dataDir = await mkdtemp(join(tmpdir(), "ontix-asana-tools-"));
  createdDirectories.push(dataDir);
  return readConfig({
    NODE_ENV: "test",
    ASANA_CLIENT_ID: "client-id",
    ASANA_CLIENT_SECRET: "client-secret",
    ONTIX_DATA_DIR: dataDir,
    ONTIX_ORGANIZATION_ID: "org-1",
    ONTIX_USER_ID: "user-1",
    ONTIX_TOKEN_ENCRYPTION_KEY: "test-key",
  });
}

describe("Asana module and tool contracts", () => {
  it("keeps compatibility exports wired to extracted child modules", () => {
    expect(compatibility.AsanaSkill).toBe(AsanaSkill);
    expect(compatibility.analyzeClientTasks).toBe(analyzeClientTasks);
    expect(compatibility.calculateMonthlyTaskAverages).toBe(calculateMonthlyTaskAverages);
    expect(compatibility.getTasksCreatedByCursor).toBe(getTasksCreatedByCursor);
    expect(compatibility.parseTaskSearchCount).toBe(parseTaskSearchCount);
    expect(compatibility.dateRangeBoundsInTimeZone).toBe(dateRangeBoundsInTimeZone);
    expect(compatibility.monthBoundsInTimeZone).toBe(monthBoundsInTimeZone);
  });

  it("preserves analytical tool names and required input fields", async () => {
    const config = await testConfig();
    const skill = new AsanaSkill(
      config,
      new TwoTierQueryCache(config.runtime.dataDir, config.runtime.tokenEncryptionKey),
    );
    Object.defineProperty(skill, "connect", {
      value: async () => ({
        listTools: async () => ({
          tools: [
            {
              name: "search_tasks",
              description: "Search tasks",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "get_tasks",
              description: "Get tasks",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      }),
    });

    const tools = await skill.tools();
    const analytical = Object.fromEntries(
      tools
        .filter((tool) => tool.name.startsWith("asana__") && tool.name !== "asana__search_tasks")
        .map((tool) => [tool.name, tool]),
    );

    expect(Object.keys(analytical).sort()).toEqual([
      "asana__analyze_client_task_counts",
      "asana__analyze_monthly_task_averages",
      "asana__analyze_task_mentions",
      "asana__compare_created_task_counts",
      "asana__compare_created_task_periods",
      "asana__compare_task_counts",
      "asana__forecast_busiest_quarter",
      "asana__forecast_service_growth",
      "asana__get_tasks",
    ]);
    expect(analytical.asana__analyze_monthly_task_averages?.inputSchema.required).toEqual([
      "years",
    ]);
    expect(analytical.asana__forecast_busiest_quarter?.inputSchema.required).toEqual([
      "historical_years",
      "target_year",
    ]);
    expect(analytical.asana__forecast_service_growth?.inputSchema.required).toEqual([
      "services",
      "periods",
    ]);
  });
});

describe("Asana executive dataset cache counters", () => {
  it("retries transient MCP attestation failures instead of dropping evidence", async () => {
    const config = await testConfig();
    const skill = new AsanaSkill(
      config,
      new TwoTierQueryCache(config.runtime.dataDir, config.runtime.tokenEncryptionKey),
    );
    let calls = 0;
    Object.defineProperty(skill, "tools", {
      value: async () => [{ name: "asana__analyze_client_task_counts", skill: "asana" }],
    });
    Object.defineProperty(skill, "connect", {
      value: async () => ({
        callTool: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Unable to verify MCP attestation token - please retry",
                },
              ],
            };
          }
          return {
            structuredContent: {
              data: [
                {
                  gid: "task-1",
                  created_at: "2026-06-01T12:00:00.000Z",
                  projects: [{ gid: "project-1", name: "Acme Website" }],
                },
              ],
            },
          };
        },
      }),
    });

    const [evidence] = await skill.execute("asana__analyze_client_task_counts", {
      year: 2026,
      time_zone: "UTC",
    });

    expect(calls).toBe(2);
    expect(evidence?.data).toMatchObject({
      winner: "Acme",
      totalTaskCount: 1,
      queryCount: 1,
    });
  });

  it("makes zero fake-MCP calls for repeated and covered timeline analyses", async () => {
    const config = await testConfig();
    const cache = new TwoTierQueryCache(
      config.runtime.dataDir,
      config.runtime.tokenEncryptionKey,
    );
    const skill = new AsanaSkill(config, cache);
    let mcpRequestCount = 0;
    const rows = [
      { gid: "2023", created_at: "2023-06-01T12:00:00.000Z" },
      { gid: "2024", created_at: "2024-06-01T12:00:00.000Z" },
      { gid: "2025", created_at: "2025-06-01T12:00:00.000Z" },
      { gid: "2026", created_at: "2026-03-01T12:00:00.000Z" },
    ];
    Object.defineProperty(skill, "tools", {
      value: async () => [
        { name: "asana__analyze_monthly_task_averages", skill: "asana" },
        { name: "asana__forecast_busiest_quarter", skill: "asana" },
      ],
    });
    Object.defineProperty(skill, "callAsanaTool", {
      value: async (_name: string, input: Record<string, unknown>) => {
        mcpRequestCount += 1;
        const after = Date.parse(String(input.created_at_after));
        const before = Date.parse(String(input.created_at_before));
        return {
          structuredContent: {
            data: rows.filter((task) => {
              const timestamp = Date.parse(task.created_at);
              return timestamp > after && timestamp < before;
            }),
          },
        };
      },
    });

    const [monthly] = await skill.execute("asana__analyze_monthly_task_averages", {
      years: [
        { year: 2023 },
        { year: 2024 },
        { year: 2025 },
        { year: 2026, through_month: 6 },
      ],
      time_zone: "UTC",
    });
    const coldRequestCount = mcpRequestCount;
    const [repeated] = await skill.execute("asana__analyze_monthly_task_averages", {
      years: [
        { year: 2023 },
        { year: 2024 },
        { year: 2025 },
        { year: 2026, through_month: 6 },
      ],
      time_zone: "UTC",
    });
    const [forecast] = await skill.execute("asana__forecast_busiest_quarter", {
      historical_years: [2023, 2024, 2025],
      target_year: 2027,
      time_zone: "UTC",
    });

    expect(coldRequestCount).toBe(1);
    expect(mcpRequestCount).toBe(coldRequestCount);
    expect(monthly?.data).toMatchObject({ queryCount: 1, cache: { hit: false } });
    expect(repeated?.data).toMatchObject({ queryCount: 0, cache: { hit: true } });
    expect(forecast?.data).toMatchObject({ queryCount: 0, cache: { hit: true } });
  });

  it("makes zero fake-MCP calls when repeating client ranking", async () => {
    const config = await testConfig();
    const skill = new AsanaSkill(
      config,
      new TwoTierQueryCache(config.runtime.dataDir, config.runtime.tokenEncryptionKey),
    );
    let mcpRequestCount = 0;
    Object.defineProperty(skill, "tools", {
      value: async () => [{ name: "asana__analyze_client_task_counts", skill: "asana" }],
    });
    Object.defineProperty(skill, "callAsanaTool", {
      value: async () => {
        mcpRequestCount += 1;
        return {
          structuredContent: {
            data: [
              {
                gid: "client-task",
                created_at: "2025-06-01T12:00:00.000Z",
                projects: [{ gid: "client-project", name: "Acme Website" }],
              },
            ],
          },
        };
      },
    });
    const request = { year: 2025, time_zone: "UTC" };

    const [cold] = await skill.execute("asana__analyze_client_task_counts", request);
    const coldRequestCount = mcpRequestCount;
    const [warm] = await skill.execute("asana__analyze_client_task_counts", request);

    expect(coldRequestCount).toBe(1);
    expect(mcpRequestCount).toBe(coldRequestCount);
    expect(cold?.data).toMatchObject({ queryCount: 1, cache: { hit: false } });
    expect(warm?.data).toMatchObject({ queryCount: 0, cache: { hit: true } });
  });

  it("makes zero fake-MCP calls when repeating term-heavy growth analysis", async () => {
    const config = await testConfig();
    const skill = new AsanaSkill(
      config,
      new TwoTierQueryCache(config.runtime.dataDir, config.runtime.tokenEncryptionKey),
    );
    let mcpRequestCount = 0;
    const rows = [
      {
        gid: "branding-2024",
        created_at: "2024-06-01T12:00:00.000Z",
        terms: ["branding", "logo"],
      },
      {
        gid: "web-2025",
        created_at: "2025-06-01T12:00:00.000Z",
        terms: ["website", "javascript"],
      },
    ];
    Object.defineProperty(skill, "tools", {
      value: async () => [{ name: "asana__forecast_service_growth", skill: "asana" }],
    });
    Object.defineProperty(skill, "callAsanaTool", {
      value: async (_name: string, input: Record<string, unknown>) => {
        mcpRequestCount += 1;
        const after = Date.parse(String(input.created_at_after));
        const before = Date.parse(String(input.created_at_before));
        const term = String(input.text).toLowerCase();
        return {
          structuredContent: {
            data: rows.filter((task) => {
              const timestamp = Date.parse(task.created_at);
              return task.terms.includes(term) && timestamp > after && timestamp < before;
            }),
          },
        };
      },
    });
    const request = {
      services: [
        { label: "Branding", terms: ["branding", "logo"] },
        { label: "Web", terms: ["website", "JavaScript"] },
      ],
      periods: [
        {
          label: "2024",
          from: "2024-01-01",
          through: "2024-12-31",
          month_count: 12,
        },
        {
          label: "2025",
          from: "2025-01-01",
          through: "2025-12-31",
          month_count: 12,
        },
      ],
      time_zone: "UTC",
    };

    const [cold] = await skill.execute("asana__forecast_service_growth", request);
    const coldRequestCount = mcpRequestCount;
    const [warm] = await skill.execute("asana__forecast_service_growth", request);

    expect(coldRequestCount).toBe(4);
    expect(mcpRequestCount).toBe(coldRequestCount);
    expect(cold?.data).toMatchObject({ queryCount: 4, cache: { hit: false } });
    expect(warm?.data).toMatchObject({ queryCount: 0, cache: { hit: true } });
  });
});
