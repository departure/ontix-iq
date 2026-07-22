import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditStore,
  ConversationMessage,
  ConversationStore,
  MemoryRecord,
  MemoryStore,
  TenantContext,
} from "../core/types.js";

type LocalData = {
  version: 1;
  conversations: Record<string, ConversationMessage[]>;
  memories: MemoryRecord[];
  audit: AuditEvent[];
};

const emptyData = (): LocalData => ({
  version: 1,
  conversations: {},
  memories: [],
  audit: [],
});

export class LocalStore implements AuditStore, MemoryStore, ConversationStore {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "ontix.json");
  }

  private async load(): Promise<LocalData> {
    try {
      const content = await readFile(this.path, "utf8");
      return JSON.parse(content) as LocalData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async save(data: LocalData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async mutate<T>(operation: (data: LocalData) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.queue = this.queue.catch(() => undefined).then(async () => {
      try {
        const data = await this.load();
        const value = await operation(data);
        await this.save(data);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.mutate((data) => {
      data.audit.push(event);
      data.audit = data.audit.slice(-5000);
    });
  }

  async appendMessage(context: TenantContext, message: ConversationMessage): Promise<void> {
    await this.mutate((data) => {
      const key = conversationKey(context);
      data.conversations[key] ??= [];
      data.conversations[key].push(message);
      data.conversations[key] = data.conversations[key].slice(-200);
    });
  }

  async listMessages(context: TenantContext, limit = 200): Promise<ConversationMessage[]> {
    const data = await this.load();
    return [...(data.conversations[conversationKey(context)] ?? [])].slice(-limit);
  }

  async listAudit(context: TenantContext, limit = 100): Promise<AuditEvent[]> {
    const data = await this.load();
    return data.audit
      .filter(
        (event) =>
          event.organizationId === context.organizationId &&
          event.userId === context.userId &&
          (!event.conversationId || event.conversationId === context.conversationId),
      )
      .slice(-limit);
  }

  async clearConversation(context: TenantContext): Promise<void> {
    await this.mutate((data) => {
      delete data.conversations[conversationKey(context)];
    });
  }

  async remember(
    input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<MemoryRecord> {
    return this.mutate((data) => {
      const now = new Date().toISOString();
      const normalized = normalize(input.content);
      const canonicalConflict = data.memories.find(
        (memory) =>
          memory.organizationId === input.organizationId &&
          memory.userId === input.userId &&
          memory.state === "canonical" &&
          normalize(memory.content) !== normalized &&
          tokenOverlap(memory.content, input.content) >= 0.6,
      );
      const record: MemoryRecord = {
        ...input,
        id: randomUUID(),
        state: canonicalConflict && input.state === "canonical" ? "draft" : input.state,
        createdAt: now,
        updatedAt: now,
      };
      data.memories.push(record);
      return record;
    });
  }

  async search(
    context: TenantContext,
    query: string,
    limit = 8,
  ): Promise<MemoryRecord[]> {
    const data = await this.load();
    return data.memories
      .filter(
        (memory) =>
          memory.organizationId === context.organizationId &&
          memory.userId === context.userId &&
          memory.state !== "deprecated",
      )
      .map((memory) => ({ memory, score: tokenOverlap(memory.content, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory }) => memory);
  }

  async listMemories(context: TenantContext): Promise<MemoryRecord[]> {
    const data = await this.load();
    return data.memories.filter(
      (memory) =>
        memory.organizationId === context.organizationId &&
        memory.userId === context.userId,
    );
  }
}

function conversationKey(context: TenantContext): string {
  return `${context.organizationId}:${context.userId}:${context.conversationId}`;
}

function normalize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function tokenOverlap(left: string, right: string): number {
  const a = normalize(left);
  const b = new Set(normalize(right));
  if (a.length === 0 || b.size === 0) return 0;
  return a.filter((token) => b.has(token)).length / Math.min(a.length, b.size);
}
