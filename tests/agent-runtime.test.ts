import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import { readConfig } from "../src/config.js";
import { SkillRegistry } from "../src/core/skills.js";
import type {
  DoctorResult,
  Evidence,
  EvidenceSource,
  Skill,
  TenantContext,
} from "../src/core/types.js";
import type {
  LLMProvider,
  ResearchContext,
  ResearchDecision,
} from "../src/providers/llm/types.js";
import { LocalStore } from "../src/storage/local.js";

const created: string[] = [];
const context: TenantContext = {
  organizationId: "departure",
  userId: "art",
  conversationId: "demo",
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ScriptedLLM implements LLMProvider {
  decisions: ResearchDecision[];
  synthesisContext?: ResearchContext;
  constructor(...decisions: ResearchDecision[]) {
    this.decisions = decisions;
  }
  async decide(): Promise<ResearchDecision> {
    return (
      this.decisions.shift() ?? {
        kind: "answer_ready",
        question: "",
        rationale: "done",
        calls: [],
      }
    );
  }
  async synthesize(context: ResearchContext) {
    this.synthesisContext = context;
    return `AWS was $10 [AWS-1]; policy is annual [NOT-1].\nSources: [AWS-1] Costs; [NOT-1] Policy`;
  }
  async doctor() {
    return { status: "ok" as const, message: "mock" };
  }
}

class EvidenceSkill implements Skill {
  constructor(
    readonly name: EvidenceSource,
    private readonly toolName: string,
    private readonly evidence: Evidence,
  ) {}
  async tools() {
    return [
      {
        name: this.toolName,
        skill: this.name,
        description: this.toolName,
        inputSchema: { type: "object" },
      },
    ];
  }
  async execute() {
    return [this.evidence];
  }
  async doctor(): Promise<DoctorResult> {
    return { service: this.name, status: "ok", message: "mock" };
  }
}

async function harness(llm: ScriptedLLM, skills: Skill[]) {
  const directory = await mkdtemp(join(tmpdir(), "ontix-agent-"));
  created.push(directory);
  const config = readConfig({
    NODE_ENV: "test",
    ONTIX_DATA_DIR: directory,
    ONTIX_MAX_TOOL_ROUNDS: "3",
  });
  const store = new LocalStore(directory);
  const registry = new SkillRegistry(skills, store, 1000);
  return {
    agent: new AgentRuntime(config, llm, registry, store, store, store),
    store,
  };
}

describe("AgentRuntime", () => {
  it("asks one clarification before retrieving", async () => {
    const llm = new ScriptedLLM({
      kind: "clarify",
      question: "Which year should I analyze?",
      rationale: "The period changes the result",
      calls: [],
    });
    const { agent, store } = await harness(llm, []);
    const answer = await agent.ask("Who is our biggest client?", context);
    expect(answer.text).toBe("Which year should I analyze?");
    expect(await store.listMessages(context)).toHaveLength(2);
  });

  it("combines multiple skills, citations, and audit evidence", async () => {
    const llm = new ScriptedLLM(
      {
        kind: "research",
        question: "",
        rationale: "Need costs and policy",
        calls: [
          { name: "aws_costs", arguments: { start: "2026-01-01", end: "2026-07-01" } },
          { name: "notion_search", arguments: { query: "AWS contract" } },
        ],
      },
      { kind: "answer_ready", question: "", rationale: "enough", calls: [] },
    );
    const aws: Evidence = {
      id: "AWS-1",
      source: "aws",
      title: "Costs",
      locator: "aws://costs",
      retrievedAt: new Date().toISOString(),
      summary: "$10",
    };
    const notion: Evidence = {
      id: "NOT-1",
      source: "notion",
      title: "Policy",
      locator: "notion://policy",
      retrievedAt: new Date().toISOString(),
      summary: "Annual",
    };
    const { agent, store } = await harness(llm, [
      new EvidenceSkill("aws", "aws_costs", aws),
      new EvidenceSkill("notion", "notion_search", notion),
    ]);
    const answer = await agent.ask("What is our AWS position?", context);
    expect(answer.evidence.map((item) => item.id)).toEqual(["AWS-1", "NOT-1"]);
    expect(answer.text).toContain("[AWS-1]");
    expect(llm.synthesisContext?.evidence).toHaveLength(2);
    expect((await store.listAudit(context, 10)).map((event) => event.type)).toContain("tool");
  });

  it("stores explicit memories as drafts", async () => {
    const { agent, store } = await harness(new ScriptedLLM(), []);
    const answer = await agent.ask("Remember that Art prefers weekly cost summaries", context);
    expect(answer.text).toContain("draft memory");
    expect(await store.listMemories(context)).toMatchObject([
      { state: "draft", kind: "semantic" },
    ]);
  });
});
