import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../src/core/skills.js";
import { isReadOnlyAsanaTool } from "../skills/asana/index.js";
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
});
