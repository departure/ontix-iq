import { randomUUID } from "node:crypto";
import type {
  AuditStore,
  Evidence,
  Skill,
  SkillToolDefinition,
  TenantContext,
  ToolExecution,
} from "./types.js";
import { redact, withTimeout } from "./security.js";

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  constructor(
    skills: Skill[],
    private readonly audit: AuditStore,
    private readonly timeoutMs: number,
  ) {
    for (const skill of skills) this.skills.set(skill.name, skill);
  }

  async tools(): Promise<SkillToolDefinition[]> {
    const settled = await Promise.allSettled(
      [...this.skills.values()].map((skill) => skill.tools()),
    );
    return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }

  async execute(
    toolName: string,
    input: unknown,
    context: TenantContext,
  ): Promise<{ evidence: Evidence[]; execution: ToolExecution }> {
    const definitions = await this.tools();
    const definition = definitions.find((tool) => tool.name === toolName);
    if (!definition) throw new Error(`Unknown or unavailable tool: ${toolName}`);
    const skill = this.skills.get(definition.skill);
    if (!skill) throw new Error(`Skill is unavailable: ${definition.skill}`);
    const startedAt = new Date().toISOString();
    try {
      const evidence = await withTimeout(
        skill.execute(toolName, input, context),
        this.timeoutMs,
        toolName,
      );
      const execution: ToolExecution = {
        tool: toolName,
        skill: definition.skill,
        startedAt,
        completedAt: new Date().toISOString(),
        evidenceCount: evidence.length,
        status: "succeeded",
      };
      await this.audit.appendAudit({
        id: randomUUID(),
        organizationId: context.organizationId,
        userId: context.userId,
        conversationId: context.conversationId,
        type: "tool",
        action: toolName,
        timestamp: execution.completedAt,
        detail: { status: execution.status, evidenceCount: evidence.length },
      });
      return { evidence, execution };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : error);
      const execution: ToolExecution = {
        tool: toolName,
        skill: definition.skill,
        startedAt,
        completedAt: new Date().toISOString(),
        evidenceCount: 0,
        status: "failed",
        error: message,
      };
      await this.audit.appendAudit({
        id: randomUUID(),
        organizationId: context.organizationId,
        userId: context.userId,
        conversationId: context.conversationId,
        type: "tool",
        action: toolName,
        timestamp: execution.completedAt,
        detail: { status: execution.status, error: message },
      });
      return { evidence: [], execution };
    }
  }

  async doctors() {
    return Promise.all([...this.skills.values()].map((skill) => skill.doctor()));
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.skills.values()].map((skill) => skill.close?.() ?? Promise.resolve()),
    );
  }
}
