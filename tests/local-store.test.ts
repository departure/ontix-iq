import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "../src/storage/local.js";
import type { TenantContext } from "../src/core/types.js";

const created: string[] = [];
const context: TenantContext = {
  organizationId: "departure",
  userId: "art",
  conversationId: "one",
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "ontix-store-"));
  created.push(directory);
  return new LocalStore(directory);
}

describe("LocalStore", () => {
  it("isolates conversations by tenant context", async () => {
    const local = await store();
    await local.appendMessage(context, {
      role: "user",
      content: "hello",
      createdAt: new Date().toISOString(),
    });
    expect(await local.listMessages(context)).toHaveLength(1);
    expect(
      await local.listMessages({ ...context, organizationId: "another" }),
    ).toHaveLength(0);
  });

  it("keeps likely canonical contradictions as drafts", async () => {
    const local = await store();
    await local.remember({
      organizationId: "departure",
      userId: "art",
      kind: "semantic",
      state: "canonical",
      content: "The primary office is in San Diego California",
      confidence: 1,
      source: "profile",
    });
    const conflicting = await local.remember({
      organizationId: "departure",
      userId: "art",
      kind: "semantic",
      state: "canonical",
      content: "The primary office is in Los Angeles California",
      confidence: 0.8,
      source: "conversation",
    });
    expect(conflicting.state).toBe("draft");
  });

  it("records append-only audit events", async () => {
    const local = await store();
    await local.appendAudit({
      id: "event-1",
      organizationId: "departure",
      userId: "art",
      conversationId: "one",
      type: "tool",
      action: "aws_costs",
      timestamp: new Date().toISOString(),
      detail: { status: "succeeded" },
    });
    expect(await local.listAudit(context, 10)).toMatchObject([
      { id: "event-1", action: "aws_costs" },
    ]);
  });
});
