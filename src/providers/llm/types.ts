import type {
  ConversationMessage,
  Evidence,
  MemoryRecord,
  SkillToolDefinition,
  ToolExecution,
} from "../../core/types.js";

export type PlannedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ResearchDecision =
  | {
      kind: "clarify";
      question: string;
      rationale: string;
      calls: [];
    }
  | {
      kind: "research";
      question: "";
      rationale: string;
      calls: PlannedToolCall[];
    }
  | {
      kind: "answer_ready";
      question: "";
      rationale: string;
      calls: [];
    };

export type ResearchContext = {
  question: string;
  organizationProfile: string;
  history: ConversationMessage[];
  memories: MemoryRecord[];
  tools: SkillToolDefinition[];
  evidence: Evidence[];
  executions: ToolExecution[];
};

export interface LLMProvider {
  decide(context: ResearchContext): Promise<ResearchDecision>;
  synthesize(context: ResearchContext): Promise<string>;
  doctor(): Promise<{ status: "ok" | "error"; message: string }>;
}
