export type TenantContext = {
  organizationId: string;
  userId: string;
  conversationId: string;
};

export type EvidenceSource = "asana" | "aws" | "notion" | "organization" | "memory";

export type Evidence = {
  id: string;
  source: EvidenceSource;
  title: string;
  locator: string;
  retrievedAt: string;
  summary: string;
  data?: unknown;
  query?: Record<string, unknown>;
};

export type SkillToolDefinition = {
  name: string;
  skill: EvidenceSource;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolExecution = {
  tool: string;
  skill: EvidenceSource;
  startedAt: string;
  completedAt: string;
  evidenceCount: number;
  status: "succeeded" | "failed" | "denied";
  error?: string;
};

export type Answer = {
  text: string;
  evidence: Evidence[];
  executions: ToolExecution[];
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type MemoryState = "canonical" | "draft" | "deprecated";
export type MemoryKind = "semantic" | "episodic";

export type MemoryRecord = {
  id: string;
  organizationId: string;
  userId: string;
  kind: MemoryKind;
  state: MemoryState;
  content: string;
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  supersedes?: string;
};

export type AuditEvent = {
  id: string;
  organizationId: string;
  userId: string;
  conversationId?: string;
  type: "conversation" | "tool" | "memory" | "authentication" | "system";
  action: string;
  timestamp: string;
  detail: Record<string, unknown>;
};

export type DoctorResult = {
  service: string;
  status: "ok" | "warning" | "error";
  message: string;
};

export interface Skill {
  readonly name: EvidenceSource;
  tools(): Promise<SkillToolDefinition[]>;
  execute(toolName: string, input: unknown, context: TenantContext): Promise<Evidence[]>;
  doctor(): Promise<DoctorResult>;
  close?(): Promise<void>;
}

export interface AuditStore {
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(context: TenantContext, limit?: number): Promise<AuditEvent[]>;
}

export interface MemoryStore {
  remember(record: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryRecord>;
  search(context: TenantContext, query: string, limit?: number): Promise<MemoryRecord[]>;
  listMemories(context: TenantContext): Promise<MemoryRecord[]>;
}

export interface ConversationStore {
  appendMessage(context: TenantContext, message: ConversationMessage): Promise<void>;
  listMessages(context: TenantContext, limit?: number): Promise<ConversationMessage[]>;
  clearConversation(context: TenantContext): Promise<void>;
}
