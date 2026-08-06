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
import {
  AsanaMcpClient,
  extractDataRows,
  type AsanaOAuthTokens,
  type AsanaTokenStore,
} from "./mcp.js";
import { findUsersViaMcp, searchTasksViaMcp } from "./retrieval.js";
import type { AsanaTaskSummary, AsanaUserSummary, CustomSession } from "./types.js";
import TYPES_CODE from "./types-code.js";

const CUSTOM_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><path d='M52 72h152v112H52z'/><path d='m52 88 76 52 76-52'/></svg>",
    ),
};

const TOKEN_STORAGE_KEY = "asanaMcpTokens";

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
      "Searches tasks and projects through Asana MCP without exposing credentials or mutation capabilities.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

function taskSummary(value: unknown): AsanaTaskSummary {
  const task = value as Record<string, unknown>;
  return {
    gid: String(task.gid ?? ""),
    name: String(task.name ?? ""),
    completed: Boolean(task.completed),
    ...(typeof task.created_at === "string" ? { createdAt: task.created_at } : {}),
    ...(typeof task.completed_at === "string" ? { completedAt: task.completed_at } : {}),
    ...(task.assignee ? { assignee: task.assignee as { gid: string; name: string } } : {}),
    projects: Array.isArray(task.projects)
      ? task.projects as Array<{ gid: string; name: string }>
      : [],
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
  readonly #mcp: AsanaMcpClient;
  readonly #workspace: string;

  constructor(approvalQueue: ObservationQueue, mcp: AsanaMcpClient, workspace: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#mcp = mcp;
    this.#workspace = workspace;
  }

  async findUsers(query: string): Promise<AsanaUserSummary[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Find Asana users",
      description: `Find Asana users matching ${JSON.stringify(query)}.`,
    });
    this.#requireWorkspace();
    return findUsersViaMcp(this.#mcp, this.#workspace, query);
  }

  async searchTasks(options: {
    text?: string;
    startDate?: string;
    endDate?: string;
    assigneeGid?: string;
    completed?: boolean;
    limit?: number;
  }): Promise<AsanaTaskSummary[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Search Asana tasks",
      description: `Search DEPARTURE Asana tasks using ${JSON.stringify(options)}.`,
    });
    this.#requireWorkspace();
    const rows = await searchTasksViaMcp(this.#mcp, {
      ...options,
      workspaceGid: this.#workspace,
    });
    return rows.map(taskSummary);
  }

  async getTask(taskGid: string): Promise<AsanaTaskSummary> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read Asana task",
      description: `Read Asana task ${taskGid}.`,
    });
    const rows = extractDataRows(await this.#mcp.getTask(taskGid));
    if (!rows[0]) throw new Error(`Asana task ${taskGid} was not found`);
    return taskSummary(rows[0]);
  }

  async listProjects(limit = 100): Promise<Array<{ gid: string; name: string; archived: boolean }>> {
    await this.#approvalQueue.authorizeObservation({
      title: "List Asana projects",
      description: "List projects in the DEPARTURE workspace.",
    });
    this.#requireWorkspace();
    const result = await this.#mcp.getProjects({
      workspace: this.#workspace,
      limit: Math.min(Math.max(limit, 1), 100),
      archived: false,
    });
    return extractDataRows(result).map((value) => {
      const project = value as Record<string, unknown>;
      return {
        gid: String(project.gid ?? ""),
        name: String(project.name ?? ""),
        archived: Boolean(project.archived),
      };
    });
  }

  #requireWorkspace(): void {
    if (!this.#workspace) {
      throw new Error("Asana Gatekeeper requires ASANA_WORKSPACE_GID");
    }
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
      snippet: "Read-only task and project search via Asana MCP.",
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
    const credentials = {
      clientId: this.env.ASANA_CLIENT_ID ?? "",
      clientSecret: this.env.ASANA_CLIENT_SECRET ?? "",
      refreshToken: this.env.ASANA_REFRESH_TOKEN ?? "",
      accessToken: this.env.ASANA_ACCESS_TOKEN,
    };
    if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
      throw new Error(
        "Asana Gatekeeper requires ASANA_CLIENT_ID, ASANA_CLIENT_SECRET, and ASANA_REFRESH_TOKEN",
      );
    }
    const store = this.#tokenStore();
    // Seed DO storage from env bootstrap tokens when empty so the first call can refresh.
    if (!(await store.read()) && credentials.refreshToken) {
      await store.write({
        accessToken: credentials.accessToken ?? "",
        refreshToken: credentials.refreshToken,
      });
    }
    const mcp = new AsanaMcpClient(credentials, store);
    return new CustomSessionImpl(approvalQueue.dup(), mcp, this.env.ASANA_WORKSPACE_GID ?? "");
  }

  #tokenStore(): AsanaTokenStore {
    const storage = this.ctx.storage;
    return {
      async read(): Promise<AsanaOAuthTokens | null> {
        const value = await storage.get<AsanaOAuthTokens>(TOKEN_STORAGE_KEY);
        return value ?? null;
      },
      async write(tokens: AsanaOAuthTokens): Promise<void> {
        await storage.put(TOKEN_STORAGE_KEY, tokens);
      },
    };
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
