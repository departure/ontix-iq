import { randomUUID } from "node:crypto";
import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { Application } from "../app.js";
import type { Answer, TenantContext } from "../core/types.js";
import { redact } from "../core/security.js";

export async function runChat(app: Application): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
  });
  let context: TenantContext = {
    organizationId: app.config.runtime.organizationId,
    userId: app.config.runtime.userId,
    conversationId: randomUUID(),
  };
  let busy = false;
  let lastAnswer: Answer | undefined;

  const shell = new BoxRenderable(renderer, {
    id: "shell",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0b1020",
  });
  const header = new TextRenderable(renderer, {
    id: "header",
    height: 3,
    content: "  ONTIX IQ  /  Executive Intelligence\n  DEPARTURE · Read-only analytical prototype",
    fg: "#7dd3fc",
    paddingTop: 0,
    paddingLeft: 1,
  });
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    width: "100%",
    border: ["top", "bottom"],
    borderColor: "#334155",
    padding: 1,
    flexDirection: "column",
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
  });
  const status = new TextRenderable(renderer, {
    id: "status",
    height: 1,
    content: "Ready · /help for commands",
    fg: "#94a3b8",
    paddingLeft: 1,
  });
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: "#0ea5e9",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "question",
    width: "100%",
    placeholder: "Ask Ontix IQ a business question…",
    textColor: "#f8fafc",
    cursorColor: "#38bdf8",
    focusedBackgroundColor: "#111827",
    maxLength: 4000,
  });

  inputBox.add(input);
  shell.add(header);
  shell.add(transcript);
  shell.add(status);
  shell.add(inputBox);
  renderer.root.add(shell);

  addMessage(
    "Ontix IQ",
    "Ask about projects, clients, AWS spend and infrastructure, subscriptions, policies, or internal knowledge. I’ll ask a focused follow-up when the question is materially ambiguous.",
    "#bae6fd",
  );
  input.focus();

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    void submit(value);
  });

  async function submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value || busy) return;
    input.value = "";
    if (value.startsWith("/")) {
      await command(value);
      return;
    }
    busy = true;
    input.blur();
    addMessage("You", value, "#f8fafc");
    try {
      const answer = await app.agent.ask(value, context, (progress) => {
        status.content = `${capitalize(progress.stage)} · ${progress.message}`;
      });
      lastAnswer = answer;
      addMessage("Ontix IQ", answer.text, "#bae6fd");
      status.content = sourceStatus(answer);
    } catch (error) {
      addMessage(
        "Ontix IQ",
        `I couldn't complete that request: ${redact(error instanceof Error ? error.message : error)}`,
        "#fca5a5",
      );
      status.content = "Request failed · check /status";
    } finally {
      busy = false;
      input.focus();
    }
  }

  async function command(value: string): Promise<void> {
    const name = value.toLowerCase().split(/\s+/)[0];
    if (name === "/help") {
      addMessage(
        "Commands",
        "/new  start a fresh conversation\n/status  test connections\n/sources  show evidence from the last answer\n/audit  show recent tool activity\n/exit  close Ontix IQ",
        "#cbd5e1",
      );
    } else if (name === "/new") {
      context = { ...context, conversationId: randomUUID() };
      lastAnswer = undefined;
      addMessage("Ontix IQ", "Started a new conversation.", "#bae6fd");
    } else if (name === "/status") {
      status.content = "Checking connections…";
      const [llm, providers] = await Promise.all([app.llm.doctor(), app.skills.doctors()]);
      addMessage(
        "Connections",
        [
          `OpenAI: ${llm.status} — ${llm.message}`,
          ...providers.map((item) => `${item.service}: ${item.status} — ${item.message}`),
        ].join("\n"),
        "#cbd5e1",
      );
      status.content = "Connection check complete";
    } else if (name === "/sources") {
      addMessage(
        "Sources",
        lastAnswer?.evidence.length
          ? lastAnswer.evidence
              .map((item) => `${item.id} · ${item.title}\n${item.locator}`)
              .join("\n\n")
          : "No source evidence is available for the last answer.",
        "#cbd5e1",
      );
    } else if (name === "/audit") {
      const events = await app.store.listAudit(context, 10);
      addMessage(
        "Audit",
        events.length
          ? events.map((event) => `${event.timestamp} · ${event.type}/${event.action}`).join("\n")
          : "No audit events in this conversation.",
        "#cbd5e1",
      );
    } else if (name === "/exit" || name === "/quit") {
      await app.skills.close();
      renderer.destroy();
      return;
    } else {
      addMessage("Ontix IQ", `Unknown command: ${name}. Use /help.`, "#fca5a5");
    }
    input.focus();
  }

  function addMessage(author: string, body: string, color: string): void {
    transcript.add(
      new TextRenderable(renderer, {
        content: `${author}\n${body}\n`,
        fg: color,
        width: "100%",
        marginBottom: 1,
      }),
    );
    transcript.scrollTo({ y: transcript.scrollHeight, x: 0 });
  }
}

function sourceStatus(answer: Answer): string {
  const succeeded = answer.executions.filter((item) => item.status === "succeeded").length;
  const failed = answer.executions.filter((item) => item.status === "failed").length;
  return `Ready · ${answer.evidence.length} sources · ${succeeded} tools${failed ? ` · ${failed} unavailable` : ""}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
