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
};

type CsvRow = {
  iteration: number;
  relatedness: string;
  seed: string;
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
const QUESTIONS_PATH = path.join(ROOT, "scripts/grind-questions.json");
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

  if (/project|task|count|volume|biggest|client|customer/.test(q) && /revenue|dollar|profit|bill/.test(q)) {
    return "Use project/task count, not revenue. DEPARTURE does not have financial software connected yet.";
  }
  if (/\b(created|started|opened)\b/.test(q) && /\btask/.test(q)) {
    return "Interpret started as tasks created in Asana.";
  }
  if (/assigned|assignee|project manager|pm\b/.test(q)) {
    return "Focus on Leslie Ribbler and Kelly Henning as project managers.";
  }
  if (/time.?range|period|year|month|quarter|date|through|from/.test(q)) {
    if (/2026/.test(originalLower) && /2025/.test(originalLower)) {
      return "Compare calendar H1 2025 vs H1 2026 in America/Los_Angeles.";
    }
    if (/q1/.test(originalLower)) return "Use calendar Q1 in America/Los_Angeles.";
    if (/2026/.test(originalLower) && /year to date|ytd|to date|this year/.test(originalLower)) {
      return "Use calendar year 2026 to date in America/Los_Angeles.";
    }
    if (/2026/.test(originalLower)) return "Use calendar year 2026 in America/Los_Angeles.";
    if (/3 years|three years|past 3/.test(originalLower)) {
      return "Use the trailing three full calendar years plus YTD where relevant, America/Los_Angeles.";
    }
    return "Use America/Los_Angeles calendar periods; prefer year-to-date 2026 unless the question names another range.";
  }
  if (/video|web|brand|design|creative|service/.test(q)) {
    return "Use organization-approved service keywords from ORGANIZATION.md (video/YouTube/TikTok; website/WordPress/AWS/Vue; branding/logo/style guide/design).";
  }
  if (/aws|cloud|cost|spend|subscription/.test(q)) {
    if (/break|cancel|contract|egress|migration/.test(q) || /break|alternative/.test(originalLower)) {
      return "Use current AWS inventory and Cost Explorer evidence; if contract termination fees are not in our systems, say so plainly and estimate migration effort from inventory only.";
    }
    return "Use actual AWS Cost Explorer / inventory data we have connected. Monthly view is fine if YTD is unavailable.";
  }
  if (/rfp|proposal/.test(q)) {
    return "Search Asana/Notion for RFP or proposal language; if the data is thin, say so and give what you can find.";
  }
  if (/profit|margin|hourly rate|billing/.test(q)) {
    return "We do not have financial software connected. Say what is knowable from projects/tasks and call out the profitability gap.";
  }
  if (/tax|corporation|s-corp|c-corp|llc/.test(q)) {
    return "This is advisory only — give a high-level comparison for a CA creative/tech services firm and note we need a CPA for anything actionable.";
  }
  if (/metaphor|joke|bonkers|hypothetical|twilight|burrito|mole|raspberry/.test(q)) {
    return "Answer the playful framing briefly, then ground the useful part in real DEPARTURE data where possible.";
  }
  if (/clarif|mean by|which metric|confirm/.test(q)) {
    return "Use the most operational metric available in Asana/AWS/Notion; state assumptions.";
  }
  return "Use the best available evidence from Asana, AWS, and Notion. State assumptions and confidence. Prefer calendar 2026 YTD in America/Los_Angeles when the period is ambiguous.";
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
      `\n=== Iteration ${item.id} (${item.relatedness}) ===\nQ: ${item.question}\n`,
      "utf8",
    );
    console.log(`\n[${item.id}/50] ${item.relatedness}: ${item.question}`);

    try {
      while (true) {
        turn += 1;
        await appendRow(csvPath, {
          iteration: item.id,
          relatedness: item.relatedness,
          seed: item.seed,
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
