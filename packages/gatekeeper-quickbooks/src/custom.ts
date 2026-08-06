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
import type { CustomSession, DateRange } from "./types.js";
import TYPES_CODE from "./types-code.js";
import { SimulatedQuickBooksClient } from "./simulation/client.js";

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
    displayName: "QuickBooks (simulated)",
    url: "https://ontixiq.com",
    logo: CUSTOM_ICON,
    color: "#e8f2ff",
    tagline: "Synthetic financial intelligence for safe demonstrations",
    description:
      "Read-only fixed simulation with customer revenue, service mix, and profit-and-loss analysis.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeCustomAccount(): AccountDescription {
  return {
    displayName: "DEPARTURE QuickBooks Simulation",
    avatar: CUSTOM_ICON,
    singleton: { tsType: "CustomSession" },
  };
}

@validateRpc()
export class CustomSessionImpl extends RpcTarget implements CustomSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #client = new SimulatedQuickBooksClient();

  constructor(approvalQueue: ObservationQueue) {
    super();
    this.#approvalQueue = approvalQueue;
  }

  async getCompanyInfo(): Promise<unknown> {
    await this.#observe("Read simulated company information", "Read the fixed synthetic QuickBooks company profile.");
    return this.#client.companyInfo();
  }

  async analyzeCustomerRevenue(options: DateRange & { limit?: number } = {}): Promise<unknown> {
    await this.#observe("Analyze simulated customer revenue", `Analyze synthetic invoices using ${JSON.stringify(options)}.`);
    return this.#client.analyzeCustomerRevenue(options);
  }

  async analyzeServiceRevenue(options: DateRange = {}): Promise<unknown> {
    await this.#observe("Analyze simulated service revenue", `Analyze synthetic service revenue using ${JSON.stringify(options)}.`);
    return this.#client.analyzeServiceRevenue(options);
  }

  async getProfitAndLoss(options: DateRange & { accountingMethod?: "ACCRUAL" | "CASH" } = {}): Promise<unknown> {
    await this.#observe("Read simulated profit and loss", `Build a synthetic P&L using ${JSON.stringify(options)}.`);
    return this.#client.report({ reportName: "ProfitAndLoss", ...options });
  }

  async #observe(title: string, description: string): Promise<void> {
    await this.#approvalQueue.authorizeObservation({ title, description });
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class CustomGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<CustomSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "quickbooks://simulated/departure",
      title: "DEPARTURE QuickBooks simulation",
      snippet: "Fixed synthetic accounting data; never live financial data.",
      suggestedBindingName: "QUICKBOOKS",
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
    return new CustomSessionImpl(approvalQueue.dup());
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
