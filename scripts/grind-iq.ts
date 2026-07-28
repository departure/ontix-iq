/**
 * Batch grinder for Ontix IQ.
 * Uses the same Application + AgentRuntime path as the TUI (src/tui/chat.ts),
 * so answers/follow-ups match interactive use while we can wait, reply, and CSV-log.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "../src/app.js";
import type { Answer, TenantContext } from "../src/core/types.js";

type GrindQuestion = {
  id: number;
  seed: string;
  relatedness: string;
  question: string;
  missing_source?: string;
};

type CsvRow = {
  iteration: number;
  relatedness: string;
  seed: string;
  missing_source: string;
  turn: number;
  role: "user" | "assistant" | "system";
  content: string;
  is_clarification: boolean;
  evidence_count: number;
  tool_successes: number;
  tool_failures: number;
  duration_ms: number;
  conversation_id: string;
  error: string;
};

const ROOT = process.cwd();
const QUESTIONS_PATH = path.join(
  ROOT,
  process.env.GRIND_QUESTIONS ?? "scripts/grind-questions.json",
);
const OUT_DIR = path.join(ROOT, "grind-results");
const MAX_FOLLOW_UPS = 3;
const START_FROM = Number(process.env.GRIND_START_FROM ?? "1");
const LIMIT = Number(process.env.GRIND_LIMIT ?? "50");

function csvEscape(value: string | number | boolean): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function rowToCsv(row: CsvRow): string {
  return [
    row.iteration,
    row.relatedness,
    row.seed,
    row.missing_source,
    row.turn,
    row.role,
    row.content,
    row.is_clarification,
    row.evidence_count,
    row.tool_successes,
    row.tool_failures,
    row.duration_ms,
    row.conversation_id,
    row.error,
  ]
    .map(csvEscape)
    .join(",");
}

const CSV_HEADER = [
  "iteration",
  "relatedness",
  "seed",
  "missing_source",
  "turn",
  "role",
  "content",
  "is_clarification",
  "evidence_count",
  "tool_successes",
  "tool_failures",
  "duration_ms",
  "conversation_id",
  "error",
].join(",");

function looksLikeClarification(answer: Answer): boolean {
  if (answer.evidence.length > 0 || answer.executions.length > 0) return false;
  const text = answer.text.trim();
  if (!text) return false;
  if (text.includes("?")) return true;
  return /^(which|what|when|where|who|how|do you|should i|can you|are you|is that|did you)\b/i.test(
    text,
  );
}

function followUpReply(clarification: string, original: string): string {
  const q = clarification.toLowerCase();
  const originalLower = original.toLowerCase();

  // Prefer answering "which system?" before date-range heuristics.
  if (/where (?:are|is|do)|which system|tracked|crm|salesforce|hubspot|pipedrive/.test(q)) {
    if (/pipeline|opportunit|deal|proposal|lead|win rate|close/.test(originalLower + " " + q)) {
      return "Opportunities and deal values are not in Asana/Notion as a source of truth—we need a connected CRM. If none is connected, say that plainly and stop clarifying.";
    }
    if (/invoice|revenue|billed|receivable|cash|margin|profit|payroll/.test(originalLower + " " + q)) {
      return "Those live in billing/accounting, which is not connected. State the gap and stop clarifying.";
    }
    return "If the system named in my question is not connected, say so explicitly and stop asking which connected tool to misuse as a proxy.";
  }

  // Data-gap grind: insist on the CEO metric. Do not substitute Asana proxies.
  if (/revenue|billed|billing|dollar|\$|invoice|ar\b|receivable|cash|payroll|margin|profit|rate|utilization|pipeline|crm|sow|msa|lease|tax|insurance|github|deploy|dropbox|slack|email response|analytics|core web vitals|retention|candidate|hire cost|break-even/.test(
    originalLower,
  )) {
    if (/project|task|count|volume|proxy|asana|instead|available/.test(q)) {
      return "I need the real financial/CRM/ops metric from the question—not Asana task counts as a proxy. If that system is not connected, say exactly what is missing and what connecting it would unlock.";
    }
  }
  if (/revenue|billed|invoice|receivable|cash|profit|margin|payroll|rate/.test(q)) {
    return "Yes—use actual dollars / financial records. If billing or accounting is not connected, state that gap clearly and do not invent numbers.";
  }
  if (/pipeline|opportunity|crm|proposal|win rate|lead/.test(q)) {
    return "Use CRM or proposal-dollar data if available; otherwise say we lack a connected CRM/proposal system and list what would be required. Do not keep asking which system—answer with the gap.";
  }
  if (/utilization|billable hour|time track|allocated|capacity/.test(q)) {
    return "Use time-tracking / capacity data. If we only have Asana assignments, say that is insufficient for true utilization.";
  }
  if (/msa|sow|contract|lease|insurance|dropbox|document/.test(q)) {
    return "Look in Notion/Dropbox/document stores if connected; otherwise name the missing document source.";
  }
  if (/slack|email|response time|escalat/.test(q)) {
    return "Use Slack/email if connected; otherwise say communication systems are not connected.";
  }
  if (/github|deploy|hotfix|commit|repo/.test(q)) {
    return "Use GitHub if connected; otherwise say engineering telemetry is not connected.";
  }
  if (/\b(created|started|opened)\b/.test(q) && /\btask/.test(q)) {
    return "Only use tasks-created if the original question was about operational volume—not money.";
  }
  if (/assigned|assignee|project manager|pm\b/.test(q)) {
    return "Focus on Leslie Ribbler and Kelly Henning as project managers when the question is about PM workload.";
  }
  if (/time.?range|period|year|month|quarter|date|through|from/.test(q)) {
    if (/2026/.test(originalLower) && /2025/.test(originalLower)) {
      return "Compare calendar H1 2025 vs H1 2026 in America/Los_Angeles.";
    }
    if (/q1|this quarter|next quarter/.test(originalLower)) {
      return "Use calendar quarters in America/Los_Angeles.";
    }
    if (/2026/.test(originalLower)) return "Use calendar year 2026 to date in America/Los_Angeles.";
    if (/3 years|three years|past 3|12 months|last year/.test(originalLower)) {
      return "Use the periods named in the question, America/Los_Angeles.";
    }
    return "Use America/Los_Angeles calendar periods; prefer year-to-date 2026 unless the question names another range.";
  }
  if (/tax|corporation|s-corp|c-corp|llc/.test(q)) {
    return "Give only what our systems support; for entity/tax advice note CPA input is required and current revenue/comp figures are unavailable without financial systems.";
  }
  if (/metaphor|joke|bonkers|hypothetical|ipo|banker/.test(q)) {
    return "Answer briefly, then state the real trailing-revenue / data prerequisite we cannot currently pull.";
  }
  if (/clarif|mean by|which metric|confirm/.test(q)) {
    return "Prefer the literal CEO metric in the question. If unavailable, name the missing source instead of substituting a weak proxy.";
  }
  return "Answer with connected evidence when it helps, but explicitly call out any missing system required for a High Confidence answer.";
}

async function appendRow(csvPath: string, row: CsvRow): Promise<void> {
  await appendFile(csvPath, `${rowToCsv(row)}\n`, "utf8");
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const csvPath = path.join(OUT_DIR, `grind-${stamp}.csv`);
  const logPath = path.join(OUT_DIR, `grind-${stamp}.log`);
  await writeFile(csvPath, `${CSV_HEADER}\n`, "utf8");
  await writeFile(logPath, `Ontix IQ grind started ${new Date().toISOString()}\n`, "utf8");

  const questions = JSON.parse(await readFile(QUESTIONS_PATH, "utf8")) as GrindQuestion[];
  const selected = questions
    .filter((item) => item.id >= START_FROM)
    .slice(0, LIMIT);

  const app = createApplication();
  const baseContext: Omit<TenantContext, "conversationId"> = {
    organizationId: app.config.runtime.organizationId,
    userId: app.config.runtime.userId,
  };

  console.log(`Writing spreadsheet to ${csvPath}`);
  console.log(`Running ${selected.length} iterations (start=${START_FROM})`);

  for (const item of selected) {
    const conversationId = randomUUID();
    const context: TenantContext = { ...baseContext, conversationId };
    let turn = 0;
    let pending = item.question;
    let followUps = 0;

    await appendFile(
      logPath,
      `\n=== Iteration ${item.id} (${item.relatedness} · ${item.missing_source ?? "n/a"}) ===\nQ: ${item.question}\n`,
      "utf8",
    );
    console.log(
      `\n[${item.id}/50] ${item.relatedness} · ${item.missing_source ?? "?"}: ${item.question}`,
    );

    try {
      while (true) {
        turn += 1;
        await appendRow(csvPath, {
          iteration: item.id,
          relatedness: item.relatedness,
          seed: item.seed,
          missing_source: item.missing_source ?? "",
          turn,
          role: "user",
          content: pending,
          is_clarification: false,
          evidence_count: 0,
          tool_successes: 0,
          tool_failures: 0,
          duration_ms: 0,
          conversation_id: conversationId,
          error: "",
        });

        const started = Date.now();
        const answer = await app.agent.ask(pending, context, (progress) => {
          process.stdout.write(`\r  ${progress.stage}: ${progress.message}`.padEnd(80));
        });
        const durationMs = Date.now() - started;
        process.stdout.write("\n");

        const clarification = looksLikeClarification(answer);
        const successes = answer.executions.filter((e) => e.status === "succeeded").length;
        const failures = answer.executions.filter((e) => e.status === "failed").length;

        await appendRow(csvPath, {
          iteration: item.id,
          relatedness: item.relatedness,
          seed: item.seed,
          missing_source: item.missing_source ?? "",
          turn,
          role: "assistant",
          content: answer.text,
          is_clarification: clarification,
          evidence_count: answer.evidence.length,
          tool_successes: successes,
          tool_failures: failures,
          duration_ms: durationMs,
          conversation_id: conversationId,
          error: "",
        });
        await appendFile(
          logPath,
          `Turn ${turn} (${durationMs}ms, clarify=${clarification}, evidence=${answer.evidence.length}):\n${answer.text}\n\n`,
          "utf8",
        );
        console.log(
          `  -> ${clarification ? "clarification" : "answer"} · ${answer.evidence.length} sources · ${durationMs}ms`,
        );

        if (!clarification) break;
        if (followUps >= MAX_FOLLOW_UPS) {
          await appendRow(csvPath, {
            iteration: item.id,
            relatedness: item.relatedness,
            seed: item.seed,
            missing_source: item.missing_source ?? "",
            turn: turn + 1,
            role: "system",
            content: "Stopped after max follow-ups without a final answer.",
            is_clarification: false,
            evidence_count: 0,
            tool_successes: 0,
            tool_failures: 0,
            duration_ms: 0,
            conversation_id: conversationId,
            error: "max_follow_ups",
          });
          console.log("  -> hit max follow-ups; moving on");
          break;
        }

        followUps += 1;
        pending = followUpReply(answer.text, item.question);
        console.log(`  <- reply: ${pending}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendRow(csvPath, {
        iteration: item.id,
        relatedness: item.relatedness,
        seed: item.seed,
        missing_source: item.missing_source ?? "",
        turn: turn + 1,
        role: "system",
        content: message,
        is_clarification: false,
        evidence_count: 0,
        tool_successes: 0,
        tool_failures: 0,
        duration_ms: 0,
        conversation_id: conversationId,
        error: message,
      });
      await appendFile(logPath, `ERROR: ${message}\n`, "utf8");
      console.error(`  !! ${message}`);
    }
  }

  await app.skills.close();
  await appendFile(logPath, `\nFinished ${new Date().toISOString()}\n`, "utf8");
  console.log(`\nDone. Spreadsheet: ${csvPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
