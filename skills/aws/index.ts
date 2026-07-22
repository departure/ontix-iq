import { randomUUID } from "node:crypto";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetReservationUtilizationCommand,
  GetSavingsPlansUtilizationCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { ListWebACLsCommand, WAFV2Client } from "@aws-sdk/client-wafv2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@smithy/types";
import type { AppConfig } from "../../src/config.js";
import type {
  DoctorResult,
  Evidence,
  Skill,
  SkillToolDefinition,
} from "../../src/core/types.js";
import { redact } from "../../src/core/security.js";

type CostInput = {
  start: string;
  end: string;
  granularity?: "DAILY" | "MONTHLY";
  groupByService?: boolean;
};

export class AwsSkill implements Skill {
  readonly name = "aws" as const;

  constructor(private readonly config: AppConfig) {}

  async tools(): Promise<SkillToolDefinition[]> {
    if (!this.credentials()) return [];
    return [
      {
        name: "aws_costs",
        skill: this.name,
        description:
          "Get actual AWS costs for a date range. End is exclusive. Can group by AWS service.",
        inputSchema: {
          type: "object",
          properties: {
            start: { type: "string", description: "Inclusive YYYY-MM-DD" },
            end: { type: "string", description: "Exclusive YYYY-MM-DD" },
            granularity: { type: "string", enum: ["DAILY", "MONTHLY"] },
            groupByService: { type: "boolean" },
          },
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
      {
        name: "aws_inventory",
        skill: this.name,
        description:
          "Inventory EC2, RDS, S3, CloudFront, and WAF resources across enabled AWS regions.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "aws_commitments",
        skill: this.name,
        description:
          "Summarize Reserved Instance and Savings Plans utilization for a date range.",
        inputSchema: {
          type: "object",
          properties: {
            start: { type: "string", description: "Inclusive YYYY-MM-DD" },
            end: { type: "string", description: "Exclusive YYYY-MM-DD" },
          },
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
    ];
  }

  async execute(
    toolName: string,
    input: unknown,
  ): Promise<Evidence[]> {
    switch (toolName) {
      case "aws_costs":
        return [await this.costs(parseCostInput(input))];
      case "aws_inventory":
        return [await this.inventory()];
      case "aws_commitments":
        return [await this.commitments(parseCostInput(input))];
      default:
        throw new Error(`Unknown AWS tool: ${toolName}`);
    }
  }

  async doctor(): Promise<DoctorResult> {
    const credentials = this.credentials();
    if (!credentials) {
      return { service: "AWS", status: "error", message: "Read-only credentials are missing" };
    }
    try {
      const identity = await new STSClient({ credentials, region: "us-east-1" }).send(
        new GetCallerIdentityCommand({}),
      );
      return {
        service: "AWS",
        status: "ok",
        message: `Authenticated to account ${identity.Account ?? "unknown"}`,
      };
    } catch (error) {
      return {
        service: "AWS",
        status: "error",
        message: redact(error instanceof Error ? error.message : error),
      };
    }
  }

  private credentials(): AwsCredentialIdentity | undefined {
    const { accessKeyId, secretAccessKey } = this.config.aws;
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
  }

  private async costs(input: CostInput): Promise<Evidence> {
    const client = new CostExplorerClient({
      credentials: this.credentials(),
      region: "us-east-1",
    });
    const results = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: input.start, End: input.end },
          Granularity: input.granularity ?? "MONTHLY",
          Metrics: ["UnblendedCost", "AmortizedCost"],
          ...(input.groupByService
            ? { GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] }
            : {}),
          ...(token ? { NextPageToken: token } : {}),
        }),
      );
      results.push(...(page.ResultsByTime ?? []));
      token = page.NextPageToken;
    } while (token);
    return evidence(
      "AWS costs",
      `aws://cost-explorer/${input.start}/${input.end}`,
      { ...input, results },
      input,
    );
  }

  private async commitments(input: CostInput): Promise<Evidence> {
    const client = new CostExplorerClient({
      credentials: this.credentials(),
      region: "us-east-1",
    });
    const period = { Start: input.start, End: input.end };
    const [reservations, savingsPlans] = await Promise.allSettled([
      client.send(new GetReservationUtilizationCommand({ TimePeriod: period })),
      client.send(new GetSavingsPlansUtilizationCommand({ TimePeriod: period })),
    ]);
    return evidence(
      "AWS commitment utilization",
      `aws://cost-explorer/commitments/${input.start}/${input.end}`,
      {
        period,
        reservations:
          reservations.status === "fulfilled"
            ? reservations.value.Total
            : { unavailable: redact(reservations.reason) },
        savingsPlans:
          savingsPlans.status === "fulfilled"
            ? savingsPlans.value.Total
            : { unavailable: redact(savingsPlans.reason) },
      },
      input,
    );
  }

  private async inventory(): Promise<Evidence> {
    const credentials = this.credentials();
    const regions = await this.regions();
    const [regional, buckets, distributions, globalWaf] = await Promise.all([
      mapLimit(regions, 4, (region) => this.regionInventory(region)),
      new S3Client({ credentials, region: "us-east-1" }).send(new ListBucketsCommand({})),
      new CloudFrontClient({ credentials, region: "us-east-1" }).send(
        new ListDistributionsCommand({ MaxItems: 100 }),
      ),
      new WAFV2Client({ credentials, region: "us-east-1" }).send(
        new ListWebACLsCommand({ Scope: "CLOUDFRONT", Limit: 100 }),
      ),
    ]);
    return evidence("AWS infrastructure inventory", "aws://inventory", {
      regions: regional,
      s3: (buckets.Buckets ?? []).map((bucket) => ({
        name: bucket.Name,
        createdAt: bucket.CreationDate,
      })),
      cloudFront: (distributions.DistributionList?.Items ?? []).map((distribution) => ({
        id: distribution.Id,
        domainName: distribution.DomainName,
        enabled: distribution.Enabled,
        status: distribution.Status,
      })),
      globalWaf: globalWaf.WebACLs ?? [],
    });
  }

  private async regions(): Promise<string[]> {
    if (this.config.aws.regions.length > 0) return this.config.aws.regions;
    const response = await new EC2Client({
      credentials: this.credentials(),
      region: "us-east-1",
    }).send(new DescribeRegionsCommand({ AllRegions: false }));
    return (response.Regions ?? [])
      .flatMap((region) => (region.RegionName ? [region.RegionName] : []))
      .slice(0, 30);
  }

  private async regionInventory(region: string) {
    const credentials = this.credentials();
    const [ec2, rds, waf] = await Promise.allSettled([
      collectEc2(credentials, region),
      collectRds(credentials, region),
      new WAFV2Client({ credentials, region }).send(
        new ListWebACLsCommand({ Scope: "REGIONAL", Limit: 100 }),
      ),
    ]);
    return {
      region,
      ec2: ec2.status === "fulfilled" ? ec2.value : { unavailable: redact(ec2.reason) },
      rds: rds.status === "fulfilled" ? rds.value : { unavailable: redact(rds.reason) },
      waf:
        waf.status === "fulfilled"
          ? waf.value.WebACLs ?? []
          : { unavailable: redact(waf.reason) },
    };
  }
}

async function collectEc2(credentials: AwsCredentialIdentity | undefined, region: string) {
  const client = new EC2Client({ credentials, region });
  const instances = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new DescribeInstancesCommand({ ...(token ? { NextToken: token } : {}) }),
    );
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        instances.push({
          id: instance.InstanceId,
          type: instance.InstanceType,
          state: instance.State?.Name,
          launchedAt: instance.LaunchTime,
          availabilityZone: instance.Placement?.AvailabilityZone,
          name: instance.Tags?.find((tag) => tag.Key === "Name")?.Value,
        });
      }
    }
    token = page.NextToken;
  } while (token);
  return instances;
}

async function collectRds(credentials: AwsCredentialIdentity | undefined, region: string) {
  const client = new RDSClient({ credentials, region });
  const instances = [];
  let marker: string | undefined;
  do {
    const page = await client.send(
      new DescribeDBInstancesCommand({ ...(marker ? { Marker: marker } : {}) }),
    );
    instances.push(
      ...(page.DBInstances ?? []).map((database) => ({
        id: database.DBInstanceIdentifier,
        engine: database.Engine,
        instanceClass: database.DBInstanceClass,
        status: database.DBInstanceStatus,
        multiAz: database.MultiAZ,
      })),
    );
    marker = page.Marker;
  } while (marker);
  return instances;
}

function parseCostInput(input: unknown): CostInput {
  if (!isRecord(input) || typeof input.start !== "string" || typeof input.end !== "string") {
    throw new Error("AWS date range requires start and end in YYYY-MM-DD format");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.end)) {
    throw new Error("AWS dates must use YYYY-MM-DD");
  }
  return {
    start: input.start,
    end: input.end,
    ...(input.granularity === "DAILY" || input.granularity === "MONTHLY"
      ? { granularity: input.granularity }
      : {}),
    ...(typeof input.groupByService === "boolean"
      ? { groupByService: input.groupByService }
      : {}),
  };
}

function evidence(
  title: string,
  locator: string,
  data: unknown,
  query?: Record<string, unknown>,
): Evidence {
  return {
    id: `AWS-${randomUUID().slice(0, 8)}`,
    source: "aws",
    title,
    locator,
    retrievedAt: new Date().toISOString(),
    summary: JSON.stringify(data),
    data,
    ...(query ? { query } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}
