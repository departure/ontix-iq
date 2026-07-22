import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { redact, truncate } from "../../core/security.js";
import type {
  LLMProvider,
  ResearchContext,
  ResearchDecision,
} from "./types.js";

const decisionSchema = z.object({
  kind: z.enum(["clarify", "research", "answer_ready"]),
  question: z.string().default(""),
  rationale: z.string(),
  calls: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
});

export class OpenAILLMProvider implements LLMProvider {
  private readonly client?: OpenAI;

  constructor(private readonly config: AppConfig) {
    if (config.openai.apiKey) this.client = new OpenAI({ apiKey: config.openai.apiKey });
  }

  async decide(context: ResearchContext): Promise<ResearchDecision> {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    const response = await this.client.responses.create({
      model: this.config.openai.model,
      store: false,
      instructions: plannerInstructions(),
      input: plannerInput(context),
    });
    const raw = parseJson(response.output_text);
    const decision = decisionSchema.parse(raw);
    const available = new Set(context.tools.map((tool) => tool.name));
    const calls = decision.calls
      .filter((call) => available.has(call.name))
      .slice(0, 6);
    if (decision.kind === "clarify") {
      return {
        kind: "clarify",
        question: decision.question || "What specifically would you like me to compare?",
        rationale: decision.rationale,
        calls: [],
      };
    }
    if (decision.kind === "answer_ready" || calls.length === 0) {
      return {
        kind: "answer_ready",
        question: "",
        rationale: decision.rationale,
        calls: [],
      };
    }
    return {
      kind: "research",
      question: "",
      rationale: decision.rationale,
      calls,
    };
  }

  async synthesize(context: ResearchContext): Promise<string> {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    const response = await this.client.responses.create({
      model: this.config.openai.model,
      store: false,
      instructions: answerInstructions(),
      input: synthesisInput(context),
    });
    return response.output_text.trim();
  }

  async doctor(): Promise<{ status: "ok" | "error"; message: string }> {
    if (!this.client) return { status: "error", message: "API key is missing" };
    try {
      const response = await this.client.responses.create({
        model: this.config.openai.model,
        input: "Reply with exactly: ok",
        max_output_tokens: 16,
        store: false,
      });
      return response.output_text.trim().toLowerCase().includes("ok")
        ? { status: "ok", message: `Model ${this.config.openai.model} responded` }
        : { status: "error", message: "Model returned an unexpected health response" };
    } catch (error) {
      return {
        status: "error",
        message: redact(error instanceof Error ? error.message : error),
      };
    }
  }
}

function plannerInstructions(): string {
  return `You are the research planner for Ontix IQ, an executive intelligence system.
Decide whether the user's question needs one concise clarifying question, more tool retrieval, or is ready to answer.
Use organization context to resolve known names and terminology. Ask only when ambiguity materially changes the answer.
Use multiple sources when the question crosses systems, but do not call irrelevant tools.
Never invent tool names or facts. Do not repeat a successful call unless its arguments need to change.
Respond with JSON only:
{"kind":"clarify|research|answer_ready","question":"only for clarify","rationale":"brief","calls":[{"name":"exact tool name","arguments":{}}]}
If evidence is sufficient, use answer_ready. If a provider failed, use other evidence when possible.`;
}

function answerInstructions(): string {
  return `You are Ontix IQ speaking to Art Bradshaw, CEO of DEPARTURE.
Be direct, concise, factual, and useful. Answer the actual business question first.
Use only supplied evidence and organization context; never fabricate missing values.
Every factual claim from retrieved systems must cite one or more exact evidence IDs in square brackets, such as [AWS-ab12cd34].
Separate facts from recommendations. Distinguish historical results from forecasts and explain forecast confidence.
State important data gaps or partial provider failures plainly.
Finish with a short "Sources" line listing the evidence IDs and titles actually used.`;
}

function plannerInput(context: ResearchContext): string {
  return truncate(
    JSON.stringify({
      currentDate: new Date().toISOString().slice(0, 10),
      question: context.question,
      organizationProfile: context.organizationProfile,
      recentConversation: context.history.slice(-12),
      relevantMemories: context.memories,
      tools: context.tools,
      evidence: context.evidence.map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        summary: item.summary,
      })),
      executions: context.executions,
    }),
    100_000,
  );
}

function synthesisInput(context: ResearchContext): string {
  return truncate(
    JSON.stringify({
      currentDate: new Date().toISOString().slice(0, 10),
      question: context.question,
      organizationProfile: context.organizationProfile,
      recentConversation: context.history.slice(-12),
      relevantMemories: context.memories,
      evidence: context.evidence,
      toolExecutions: context.executions,
    }),
    120_000,
  );
}

function parseJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return a valid research decision");
  }
}
