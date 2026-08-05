import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AsanaTaskSummary, CustomSession } from "./types.js";
import TYPES_CODE from "./types-code.js";

const CUSTOM_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><path d='M52 72h152v112H52z'/><path d='m52 88 76 52 76-52'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeCustomVendor(): VendorDescription {
  return {
    displayName: "Asana",
    url: "https://asana.com",
    logo: CUSTOM_ICON,
    color: "#e8f2ff",
    tagline: "Read-only DEPARTURE project intelligence",
    description:
      "Searches tasks and projects without exposing credentials or mutation capabilities.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

function taskSummary(value: unknown): AsanaTaskSummary {
  const task = value as Record<string, unknown>;
  return {
    gid: String(task.gid ?? ""), name: String(task.name ?? ""), completed: Boolean(task.completed),
    ...(typeof task.created_at === "string" ? { createdAt: task.created_at } : {}),
    ...(typeof task.completed_at === "string" ? { completedAt: task.completed_at } : {}),
    ...(task.assignee ? { assignee: task.assignee as { gid: string; name: string } } : {}),
    projects: Array.isArray(task.projects) ? task.projects as Array<{ gid: string; name: string }> : [],
    ...(typeof task.permalink_url === "string" ? { permalinkUrl: task.permalink_url } : {}),
  };
}

export function describeCustomAccount(): AccountDescription {
  return {
    displayName: "DEPARTURE Asana",
    avatar: CUSTOM_ICON,
    singleton: { tsType: "CustomSession" },
  };
}

@validateRpc()
export class CustomSessionImpl extends RpcTarget implements CustomSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #token: string;
  readonly #workspace: string;

  constructor(approvalQueue: ObservationQueue, token: string, workspace: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#token = token;
    this.#workspace = workspace;
  }

  async searchTasks(options: { text?: string; startDate?: string; endDate?: string; assigneeGid?: string; completed?: boolean; limit?: number }): Promise<AsanaTaskSummary[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Search Asana tasks",
      description: `Search DEPARTURE Asana tasks using ${JSON.stringify(options)}.`,
    });
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 100, 1), 100)), opt_fields: "gid,name,completed,created_at,completed_at,assignee.gid,assignee.name,projects.gid,projects.name,permalink_url" });
    if (options.text) params.set("text", options.text);
    if (options.startDate) params.set("created_at.after", `${options.startDate}T00:00:00.000Z`);
    if (options.endDate) params.set("created_at.before", `${options.endDate}T23:59:59.999Z`);
    if (options.assigneeGid) params.set("assignee.any", options.assigneeGid);
    if (options.completed !== undefined) params.set("completed", String(options.completed));
    const response = await this.#request(`/workspaces/${encodeURIComponent(this.#workspace)}/tasks/search?${params}`);
    return (response.data as unknown[]).map(taskSummary);
  }

  async getTask(taskGid: string): Promise<AsanaTaskSummary> {
    await this.#approvalQueue.authorizeObservation({ title: "Read Asana task", description: `Read Asana task ${taskGid}.` });
    const response = await this.#request(`/tasks/${encodeURIComponent(taskGid)}?opt_fields=gid,name,completed,created_at,completed_at,assignee.gid,assignee.name,projects.gid,projects.name,permalink_url`);
    return taskSummary(response.data);
  }

  async listProjects(limit = 100): Promise<Array<{ gid: string; name: string; archived: boolean }>> {
    await this.#approvalQueue.authorizeObservation({ title: "List Asana projects", description: "List projects in the DEPARTURE workspace." });
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)), opt_fields: "gid,name,archived" });
    const response = await this.#request(`/workspaces/${encodeURIComponent(this.#workspace)}/projects?${params}`);
    return response.data as Array<{ gid: string; name: string; archived: boolean }>;
  }

  async #request(path: string): Promise<{ data: unknown }> {
    if (!this.#token || !this.#workspace) throw new Error("Asana Gatekeeper requires ASANA_ACCESS_TOKEN and ASANA_WORKSPACE_GID secrets");
    const response = await fetch(`https://app.asana.com/api/1.0${path}`, { headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" } });
    if (!response.ok) throw new Error(`Asana request failed with HTTP ${response.status}`);
    return await response.json() as { data: unknown };
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class CustomGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<CustomSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://app.asana.com/0/search",
      title: "DEPARTURE Asana workspace",
      snippet: "Read-only task and project search.",
      suggestedBindingName: "ASANA",
      tsType: "CustomSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CustomSession> {
    return new CustomSessionImpl(approvalQueue.dup(), this.env.ASANA_ACCESS_TOKEN, this.env.ASANA_WORKSPACE_GID);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`Custom Gatekeeper has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("Custom Gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class CustomAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeCustomAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<CustomSession>>> {
    return this.ctx.exports.CustomGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Custom Gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Custom Gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Custom Gatekeeper has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CustomVerifier({});
  }
}

@validateRpc()
export class CustomVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeCustomVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.CustomAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Custom Gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
