import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type {
  Answer,
  AuditStore,
  ConversationStore,
  Evidence,
  MemoryStore,
  TenantContext,
  ToolExecution,
} from "../core/types.js";
import type { SkillRegistry } from "../core/skills.js";
import { truncate } from "../core/security.js";
import type { LLMProvider, ResearchContext } from "../providers/llm/types.js";

export type AgentProgress = {
  stage: "planning" | "retrieving" | "synthesizing" | "remembering";
  message: string;
};

export class AgentRuntime {
  constructor(
    private readonly config: AppConfig,
    private readonly llm: LLMProvider,
    private readonly skills: SkillRegistry,
    private readonly conversations: ConversationStore,
    private readonly memories: MemoryStore,
    private readonly audit: AuditStore,
  ) {}

  async ask(
    question: string,
    context: TenantContext,
    onProgress: (progress: AgentProgress) => void = () => {},
  ): Promise<Answer> {
    const cleanQuestion = question.trim();
    if (!cleanQuestion) throw new Error("Question cannot be empty");
    await this.conversations.appendMessage(context, {
      role: "user",
      content: cleanQuestion,
      createdAt: new Date().toISOString(),
    });

    const remembered = extractRememberRequest(cleanQuestion);
    if (remembered) {
      onProgress({ stage: "remembering", message: "Recording a draft memory" });
      const memory = await this.memories.remember({
        organizationId: context.organizationId,
        userId: context.userId,
        kind: "semantic",
        state: "draft",
        content: remembered,
        confidence: 0.7,
        source: `conversation:${context.conversationId}`,
      });
      const text = `I saved that as draft memory (${memory.id.slice(0, 8)}). It will not replace canonical knowledge without confirmation.`;
      await this.finishConversation(context, cleanQuestion, text, [], []);
      return { text, evidence: [], executions: [] };
    }

    onProgress({ stage: "planning", message: "Understanding the question" });
    const [organizationProfile, history, relevantMemories, tools] = await Promise.all([
      readFile("ORGANIZATION.md", "utf8"),
      this.conversations.listMessages(context, 20),
      this.memories.search(context, cleanQuestion),
      this.skills.tools(),
    ]);

    const research: ResearchContext = {
      question: cleanQuestion,
      organizationProfile,
      history,
      memories: relevantMemories,
      tools,
      evidence: [],
      executions: [],
    };
    const called = new Set<string>();

    for (let round = 0; round < this.config.runtime.maxToolRounds; round++) {
      const decision = await this.llm.decide(research);
      if (decision.kind === "clarify") {
        await this.finishConversation(context, cleanQuestion, decision.question, [], []);
        return { text: decision.question, evidence: [], executions: [] };
      }
      if (decision.kind === "answer_ready") break;
      const calls = decision.calls.filter((call) => {
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        if (called.has(key)) return false;
        called.add(key);
        return true;
      });
      if (calls.length === 0) break;

      onProgress({
        stage: "retrieving",
        message: `Checking ${[...new Set(calls.map((call) => call.name.split("__")[0]))].join(", ")}`,
      });
      const results = await Promise.all(
        calls.map((call) => this.skills.execute(call.name, call.arguments, context)),
      );
      for (const result of results) {
        research.executions.push(result.execution);
        research.evidence.push(...result.evidence);
      }
      research.evidence = fitEvidence(
        research.evidence,
        this.config.runtime.maxEvidenceChars,
      );
    }

    onProgress({ stage: "synthesizing", message: "Combining the evidence" });
    const text = await this.llm.synthesize(research);
    await this.finishConversation(
      context,
      cleanQuestion,
      text,
      research.evidence,
      research.executions,
    );
    return { text, evidence: research.evidence, executions: research.executions };
  }

  private async finishConversation(
    context: TenantContext,
    question: string,
    text: string,
    evidence: Evidence[],
    executions: ToolExecution[],
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await Promise.all([
      this.conversations.appendMessage(context, {
        role: "assistant",
        content: text,
        createdAt: timestamp,
      }),
      this.audit.appendAudit({
        id: randomUUID(),
        organizationId: context.organizationId,
        userId: context.userId,
        conversationId: context.conversationId,
        type: "conversation",
        action: "answer",
        timestamp,
        detail: {
          question,
          evidence: evidence.map((item) => item.id),
          tools: executions.map((item) => ({
            tool: item.tool,
            status: item.status,
          })),
        },
      }),
    ]);
  }
}

function fitEvidence(evidence: Evidence[], budget: number): Evidence[] {
  let remaining = budget;
  return evidence.map((item) => {
    const summary = truncate(item.summary, Math.max(500, remaining));
    remaining = Math.max(0, remaining - summary.length);
    return { ...item, summary };
  });
}

function extractRememberRequest(question: string): string | undefined {
  const match = question.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)/i);
  return match?.[1]?.trim();
}
