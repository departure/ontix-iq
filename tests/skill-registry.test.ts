import { describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "../src/core/skills.js";
import { readConfig } from "../src/config.js";
import {
  countTasksByCreatedAt,
  getAllAssignedTasks,
  isReadOnlyAsanaTool,
  parseTaskSearchCount,
  taskMatchesCountFilters,
  yearBoundsInTimeZone,
} from "../skills/asana/index.js";
import { AsanaOAuthProvider } from "../skills/asana/auth/provider.js";
import type {
  AuditEvent,
  AuditStore,
  DoctorResult,
  Evidence,
  Skill,
  TenantContext,
} from "../src/core/types.js";

class AuditSpy implements AuditStore {
  events: AuditEvent[] = [];
  async appendAudit(event: AuditEvent) {
    this.events.push(event);
  }
  async listAudit() {
    return this.events;
  }
}

class FakeSkill implements Skill {
  readonly name = "aws" as const;
  async tools() {
    return [
      {
        name: "aws_costs",
        skill: this.name,
        description: "costs",
        inputSchema: { type: "object" },
      },
      {
        name: "aws_failure",
        skill: this.name,
        description: "fails",
        inputSchema: { type: "object" },
      },
    ];
  }
  async execute(toolName: string): Promise<Evidence[]> {
    if (toolName === "aws_failure") throw new Error("token=must-not-leak");
    return [
      {
        id: "AWS-1",
        source: "aws",
        title: "Costs",
        locator: "aws://costs",
        retrievedAt: new Date().toISOString(),
        summary: "$10",
      },
    ];
  }
  async doctor(): Promise<DoctorResult> {
    return { service: "AWS", status: "ok", message: "ready" };
  }
}

const context: TenantContext = {
  organizationId: "departure",
  userId: "art",
  conversationId: "conversation",
};

describe("SkillRegistry", () => {
  it("normalizes success and audits execution", async () => {
    const audit = new AuditSpy();
    const registry = new SkillRegistry([new FakeSkill()], audit, 1000);
    const result = await registry.execute("aws_costs", {}, context);
    expect(result.execution.status).toBe("succeeded");
    expect(result.evidence[0]?.id).toBe("AWS-1");
    expect(audit.events).toHaveLength(1);
  });

  it("returns partial failure metadata without leaking secrets", async () => {
    const audit = new AuditSpy();
    const registry = new SkillRegistry([new FakeSkill()], audit, 1000);
    const result = await registry.execute("aws_failure", {}, context);
    expect(result.evidence).toEqual([]);
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error).toContain("[REDACTED]");
    expect(result.execution.error).not.toContain("must-not-leak");
  });
});

describe("Asana capability policy", () => {
  it("allows retrieval and rejects mutation-like tools", () => {
    expect(isReadOnlyAsanaTool("search_tasks")).toBe(true);
    expect(isReadOnlyAsanaTool("get_project")).toBe(true);
    expect(isReadOnlyAsanaTool("get_assets")).toBe(true);
    expect(isReadOnlyAsanaTool("create_task")).toBe(false);
    expect(isReadOnlyAsanaTool("add_comment")).toBe(false);
    expect(isReadOnlyAsanaTool("delete_project")).toBe(false);
  });

  it("extracts analytical counts from Asana task search responses", () => {
    expect(parseTaskSearchCount("Task search completed: Found 13 tasks.")).toBe(13);
    expect(parseTaskSearchCount("Found 1 task")).toBe(1);
    expect(parseTaskSearchCount("Found 1,234 tasks")).toBe(1234);
    expect(parseTaskSearchCount("Showing up to 99 tasks. Results may not represent the total."))
      .toBeUndefined();
    expect(parseTaskSearchCount("No count was returned")).toBeUndefined();
  });

  it("uses the organization time zone for calendar-year boundaries", () => {
    const bounds = yearBoundsInTimeZone(2026, "America/Los_Angeles");
    expect(bounds.start.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2027-01-01T08:00:00.000Z");
  });

  it("recursively partitions capped timestamp searches without boundary gaps", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-01T00:00:01.000Z");
    const rows = Array.from({ length: 250 }, (_, index) => ({
      gid: String(index),
      created_at: new Date(start.getTime() + index * 4).toISOString(),
    }));
    const result = await countTasksByCreatedAt(
      async (arguments_) => {
        const after = Date.parse(String(arguments_.created_at_after));
        const before = Date.parse(String(arguments_.created_at_before));
        return {
          structuredContent: {
            data: rows
              .filter((row) => {
                const timestamp = Date.parse(row.created_at);
                return timestamp > after && timestamp < before;
              })
              .slice(0, 100),
          },
        };
      },
      { created_by_any: "user-1" },
      start,
      end,
    );
    expect(result.count).toBe(250);
    expect(result.queryCount).toBeGreaterThan(1);
  });

  it("partitions same-millisecond caps by disjoint task properties", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-01T00:00:00.001Z");
    const rows = Array.from({ length: 150 }, (_, index) => ({
      gid: String(index),
      created_at: start.toISOString(),
      completed: index % 2 === 0,
    }));
    const result = await countTasksByCreatedAt(
      async (arguments_) => ({
        structuredContent: {
          data: rows
            .filter(
              (row) =>
                arguments_.completed === undefined || row.completed === arguments_.completed,
            )
            .slice(0, 100),
        },
      }),
      { created_by_any: "user-1" },
      start,
      end,
    );
    expect(result.count).toBe(150);
  });

  it("paginates and deduplicates all currently assigned tasks", async () => {
    const offsets: Array<unknown> = [];
    const result = await getAllAssignedTasks(async (arguments_) => {
      offsets.push(arguments_.offset);
      if (!arguments_.offset) {
        return {
          structuredContent: {
            data: [{ gid: "task-1" }, { gid: "task-2" }],
            next_page: { offset: "page-2" },
          },
        };
      }
      return {
        structuredContent: {
          data: [{ gid: "task-2" }, { gid: "task-3" }],
          next_page: null,
        },
      };
    }, "user-1");
    expect(offsets).toEqual([undefined, "page-2"]);
    expect(result.pageCount).toBe(2);
    expect(result.tasks.map((task) => task.gid)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("rejects repeated assigned-task pagination offsets", async () => {
    await expect(
      getAllAssignedTasks(
        async () => ({
          structuredContent: {
            data: [{ gid: "task-1" }],
            next_page: { offset: "repeated" },
          },
        }),
        "user-1",
      ),
    ).rejects.toThrow("repeated");
  });

  it("applies assigned-task date, completion, and project filters locally", () => {
    const task = {
      gid: "task-1",
      completed: false,
      start_at: "2026-07-22T17:00:00.000Z",
      due_on: "2026-07-30",
      created_at: "2025-12-15T10:00:00.000Z",
      memberships: [{ project: { gid: "project-1" } }],
    };
    expect(
      taskMatchesCountFilters(task, {
        completed: false,
        start_on_after: "2025-12-31",
        start_on_before: "2027-01-01",
        projects_any: "project-1,project-2",
      }),
    ).toBe(true);
    expect(taskMatchesCountFilters(task, { completed: true })).toBe(false);
    expect(taskMatchesCountFilters(task, { start_on_before: "2026-01-01" })).toBe(false);
    expect(taskMatchesCountFilters(task, { projects_any: "project-2" })).toBe(false);
  });

  it("refreshes expired MCP authorization while preserving rotated-token fallback", async () => {
    const provider = new AsanaOAuthProvider(
      readConfig({
        ASANA_CLIENT_ID: "client-id",
        ASANA_CLIENT_SECRET: "client-secret",
      }),
    );
    vi.spyOn(provider, "tokens").mockResolvedValue({
      access_token: "expired",
      token_type: "Bearer",
      refresh_token: "existing-refresh",
    });
    const save = vi.spyOn(provider, "saveTokens").mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await provider.refreshTokens();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: "new-access",
        refresh_token: "existing-refresh",
      }),
    );
  });
});
