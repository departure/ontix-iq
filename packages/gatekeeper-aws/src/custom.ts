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
import type { CustomSession } from "./types.js";
import TYPES_CODE from "./types-code.js";
import { CostExplorerClient, GetCostAndUsageCommand, GetReservationUtilizationCommand, GetSavingsPlansUtilizationCommand } from "@aws-sdk/client-cost-explorer";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

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
    displayName: "AWS",
    url: "https://aws.amazon.com",
    logo: CUSTOM_ICON,
    color: "#e8f2ff",
    tagline: "Read-only costs, commitments, and infrastructure",
    description:
      "Least-privilege account observations; no AWS mutation methods are exposed.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeCustomAccount(): AccountDescription {
  return {
    displayName: "DEPARTURE AWS (read-only)",
    avatar: CUSTOM_ICON,
    singleton: { tsType: "CustomSession" },
  };
}

@validateRpc()
export class CustomSessionImpl extends RpcTarget implements CustomSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #credentials: { accessKeyId: string; secretAccessKey: string };
  readonly #regions: string[];

  constructor(approvalQueue: ObservationQueue, accessKeyId: string, secretAccessKey: string, regions: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#credentials = { accessKeyId, secretAccessKey };
    this.#regions = regions.split(",").map((value) => value.trim()).filter(Boolean);
  }

  async getIdentity(): Promise<{ account?: string; arn?: string }> {
    await this.#observe("Read AWS identity", "Verify the configured read-only AWS principal.");
    const value = await new STSClient({ credentials: this.#credentials, region: "us-east-1" }).send(new GetCallerIdentityCommand({}));
    return { account: value.Account, arn: value.Arn };
  }

  async getCosts(options: { start: string; end: string; granularity?: "DAILY" | "MONTHLY"; groupByService?: boolean }): Promise<unknown> {
    await this.#observe("Read AWS costs", `Read AWS costs from ${options.start} through ${options.end}.`);
    return await new CostExplorerClient({ credentials: this.#credentials, region: "us-east-1" }).send(new GetCostAndUsageCommand({
      TimePeriod: { Start: options.start, End: options.end }, Granularity: options.granularity ?? "MONTHLY", Metrics: ["UnblendedCost", "AmortizedCost"],
      ...(options.groupByService ? { GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] } : {}),
    }));
  }

  async getCommitmentUtilization(options: { start: string; end: string }): Promise<unknown> {
    await this.#observe("Read AWS commitments", `Read reservation and Savings Plans utilization from ${options.start} through ${options.end}.`);
    const client = new CostExplorerClient({ credentials: this.#credentials, region: "us-east-1" });
    const period = { Start: options.start, End: options.end };
    const [reservations, savingsPlans] = await Promise.all([
      client.send(new GetReservationUtilizationCommand({ TimePeriod: period })),
      client.send(new GetSavingsPlansUtilizationCommand({ TimePeriod: period })),
    ]);
    return { period, reservations: reservations.Total, savingsPlans: savingsPlans.Total };
  }

  async getInventory(): Promise<unknown> {
    await this.#observe("Read AWS inventory", "Inventory EC2, RDS, and S3 resources in configured regions.");
    const regions = this.#regions.length ? this.#regions : ["us-west-2", "us-east-1"];
    const regional = await Promise.all(regions.map(async (region) => {
      const [ec2, rds] = await Promise.all([
        new EC2Client({ credentials: this.#credentials, region }).send(new DescribeInstancesCommand({})),
        new RDSClient({ credentials: this.#credentials, region }).send(new DescribeDBInstancesCommand({})),
      ]);
      return { region, ec2: ec2.Reservations ?? [], rds: rds.DBInstances ?? [] };
    }));
    const s3 = await new S3Client({ credentials: this.#credentials, region: "us-east-1" }).send(new ListBucketsCommand({}));
    return { regions: regional, buckets: s3.Buckets ?? [] };
  }

  async #observe(title: string, description: string): Promise<void> {
    if (!this.#credentials.accessKeyId || !this.#credentials.secretAccessKey) throw new Error("AWS Gatekeeper credentials are not configured");
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
      url: "aws://departure/read-only",
      title: "DEPARTURE AWS account",
      snippet: "Read-only costs, commitments, identity, and inventory.",
      suggestedBindingName: "AWS",
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
    return new CustomSessionImpl(approvalQueue.dup(), this.env.AWS_ACCESS_KEY, this.env.AWS_ACCESS_KEY_SECRET, this.env.AWS_REGIONS ?? "");
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
