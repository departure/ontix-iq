import { randomUUID } from "node:crypto";
import type {
  DoctorResult,
  Evidence,
  Skill,
  SkillToolDefinition,
} from "../../src/core/types.js";
import {
  SimulatedQuickBooksClient,
  type QuickBooksClient,
  type TransactionSearchRequest,
} from "./client.js";
import {
  REPORT_NAMES,
  type AccountingMethod,
  type ReportName,
  type ReportRequest,
} from "./reports.js";
import type { EntityType } from "./types.js";
import {
  ENTITY_TYPES,
  SYNTHETIC_NOTICE,
  assertNoUnknownKeys,
  assertObject,
  compactJson,
  optionalInteger,
  optionalString,
} from "./shared.js";

export * from "./client.js";
export * from "./data/index.js";
export * from "./reports.js";
export type * from "./types.js";

const DATE_SCHEMA = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Date in YYYY-MM-DD format within the simulated dataset range.",
} as const;

export class QuickBooksSkill implements Skill {
  readonly name = "quickbooks" as const;

  constructor(
    private readonly client: QuickBooksClient = new SimulatedQuickBooksClient(),
  ) {}

  async tools(): Promise<SkillToolDefinition[]> {
    return [
      {
        name: "quickbooks_company_info",
        skill: this.name,
        description:
          "Return QBO-style company information for the fixed synthetic simulation. This never accesses a live QuickBooks company.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "quickbooks_query",
        skill: this.name,
        description:
          "Run a read-only QBO-style SELECT * query against synthetic Account, Customer, Vendor, Item, Invoice, Payment, Bill, BillPayment, Purchase, or JournalEntry records. Supports AND-combined TxnDate bounds and Id/name/reference equality, plus STARTPOSITION and MAXRESULTS (maximum 1000).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              description:
                "QBO-style query, for example: SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' AND CustomerRef = 'c-disd' STARTPOSITION 1 MAXRESULTS 100",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "quickbooks_transactions",
        skill: this.name,
        description:
          "Search synthetic transactions with structured date, type, customer, vendor, and 1-based pagination filters. Customer/vendor filters accept an exact ID or exact display name.",
        inputSchema: {
          type: "object",
          properties: {
            startDate: DATE_SCHEMA,
            endDate: DATE_SCHEMA,
            transactionTypes: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", enum: ENTITY_TYPES },
            },
            customerId: { type: "string", minLength: 1 },
            customerName: { type: "string", minLength: 1 },
            vendorId: { type: "string", minLength: 1 },
            vendorName: { type: "string", minLength: 1 },
            startPosition: { type: "integer", minimum: 1 },
            maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "quickbooks_report",
        skill: this.name,
        description:
          "Build a structured QBO-style synthetic financial report. ProfitAndLoss supports meaningful ACCRUAL or CASH basis. Historical aging derives open balances as of endDate. GeneralLedger is row-limited.",
        inputSchema: {
          type: "object",
          properties: {
            reportName: { type: "string", enum: REPORT_NAMES },
            startDate: DATE_SCHEMA,
            endDate: DATE_SCHEMA,
            accountingMethod: {
              type: "string",
              enum: ["ACCRUAL", "CASH"],
              default: "ACCRUAL",
              description: "Applicable to ProfitAndLoss; other reports use their natural basis.",
            },
            maxRows: {
              type: "integer",
              minimum: 1,
              maximum: 5000,
              default: 500,
              description: "GeneralLedger output row cap.",
            },
          },
          required: ["reportName"],
          additionalProperties: false,
        },
      },
    ];
  }

  async execute(toolName: string, input: unknown): Promise<Evidence[]> {
    switch (toolName) {
      case "quickbooks_company_info":
        return [this.companyInfoEvidence(input)];
      case "quickbooks_query":
        return [this.queryEvidence(input)];
      case "quickbooks_transactions":
        return [this.transactionsEvidence(input)];
      case "quickbooks_report":
        return [this.reportEvidence(input)];
      default:
        throw new Error(`Unknown QuickBooks tool: ${toolName}`);
    }
  }

  async doctor(): Promise<DoctorResult> {
    const range = this.client.datasetRange();
    return {
      service: "QuickBooks (synthetic simulation)",
      status: "ok",
      message:
        `Read-only simulated fixed dataset is available for ${range.startDate} through ${range.endDate}; no network, OAuth, credentials, or live QuickBooks connection is used.`,
    };
  }

  private companyInfoEvidence(input: unknown): Evidence {
    const value = assertObject(input, "quickbooks_company_info input");
    assertNoUnknownKeys(value, [], "quickbooks_company_info input");
    const result = this.client.companyInfo();
    return evidence(
      "Synthetic QuickBooks company information",
      "quickbooks://simulated/company-info",
      compactJson({
        syntheticSimulation: true,
        companyName: result.CompanyInfo.CompanyName,
        datasetRange: result.dataset,
      }),
      result,
    );
  }

  private queryEvidence(input: unknown): Evidence {
    const value = assertObject(input, "quickbooks_query input");
    assertNoUnknownKeys(value, ["query"], "quickbooks_query input");
    const query = optionalString(value, "query");
    if (query === undefined) throw new Error("quickbooks_query requires query");
    const result = this.client.query(query);
    const entityKey = Object.keys(result.QueryResponse).find(
      (key) => !["startPosition", "maxResults", "totalCount"].includes(key),
    ) ?? "records";
    return evidence(
      `Synthetic QuickBooks ${entityKey} query`,
      `quickbooks://simulated/query/${encodeURIComponent(entityKey)}`,
      compactJson({
        syntheticSimulation: true,
        entity: entityKey,
        returned: Array.isArray(result.QueryResponse[entityKey])
          ? result.QueryResponse[entityKey].length
          : 0,
        totalCount: result.QueryResponse.totalCount,
        startPosition: result.QueryResponse.startPosition,
        maxResults: result.QueryResponse.maxResults,
      }),
      result,
      { query },
    );
  }

  private transactionsEvidence(input: unknown): Evidence {
    const value = assertObject(input, "quickbooks_transactions input");
    const allowed = [
      "startDate",
      "endDate",
      "transactionTypes",
      "customerId",
      "customerName",
      "vendorId",
      "vendorName",
      "startPosition",
      "maxResults",
    ];
    assertNoUnknownKeys(value, allowed, "quickbooks_transactions input");
    const transactionTypes = parseEntityTypes(value.transactionTypes);
    const request: TransactionSearchRequest = {
      ...(optionalString(value, "startDate") === undefined
        ? {}
        : { startDate: optionalString(value, "startDate") }),
      ...(optionalString(value, "endDate") === undefined
        ? {}
        : { endDate: optionalString(value, "endDate") }),
      ...(transactionTypes === undefined ? {} : { transactionTypes }),
      ...(optionalString(value, "customerId") === undefined
        ? {}
        : { customerId: optionalString(value, "customerId") }),
      ...(optionalString(value, "customerName") === undefined
        ? {}
        : { customerName: optionalString(value, "customerName") }),
      ...(optionalString(value, "vendorId") === undefined
        ? {}
        : { vendorId: optionalString(value, "vendorId") }),
      ...(optionalString(value, "vendorName") === undefined
        ? {}
        : { vendorName: optionalString(value, "vendorName") }),
      startPosition: optionalInteger(
        value,
        "startPosition",
        1,
        Number.MAX_SAFE_INTEGER,
        1,
      ),
      maxResults: optionalInteger(value, "maxResults", 1, 1000, 100),
    };
    const result = this.client.transactions(request);
    return evidence(
      "Synthetic QuickBooks transaction search",
      "quickbooks://simulated/transactions",
      compactJson({
        syntheticSimulation: true,
        returned: result.QueryResponse.Transaction.length,
        totalCount: result.QueryResponse.totalCount,
        startPosition: result.QueryResponse.startPosition,
        maxResults: result.QueryResponse.maxResults,
        filters: result.filters,
      }),
      result,
      { ...request },
    );
  }

  private reportEvidence(input: unknown): Evidence {
    const value = assertObject(input, "quickbooks_report input");
    assertNoUnknownKeys(
      value,
      ["reportName", "startDate", "endDate", "accountingMethod", "maxRows"],
      "quickbooks_report input",
    );
    const reportNameValue = optionalString(value, "reportName");
    if (
      reportNameValue === undefined
      || !REPORT_NAMES.includes(reportNameValue as ReportName)
    ) {
      throw new Error(`reportName must be one of: ${REPORT_NAMES.join(", ")}`);
    }
    const methodValue = optionalString(value, "accountingMethod");
    if (methodValue !== undefined && methodValue !== "ACCRUAL" && methodValue !== "CASH") {
      throw new Error("accountingMethod must be ACCRUAL or CASH");
    }
    if (methodValue !== undefined && reportNameValue !== "ProfitAndLoss") {
      throw new Error("accountingMethod may only be supplied for ProfitAndLoss");
    }
    if (value.maxRows !== undefined && reportNameValue !== "GeneralLedger") {
      throw new Error("maxRows may only be supplied for GeneralLedger");
    }
    const request: ReportRequest = {
      reportName: reportNameValue as ReportName,
      ...(optionalString(value, "startDate") === undefined
        ? {}
        : { startDate: optionalString(value, "startDate") }),
      ...(optionalString(value, "endDate") === undefined
        ? {}
        : { endDate: optionalString(value, "endDate") }),
      ...(methodValue === undefined
        ? {}
        : { accountingMethod: methodValue as AccountingMethod }),
      ...(value.maxRows === undefined
        ? {}
        : { maxRows: optionalInteger(value, "maxRows", 1, 5000, 500) }),
    };
    const result = this.client.report(request);
    return evidence(
      `Synthetic QuickBooks ${request.reportName} report`,
      `quickbooks://simulated/reports/${request.reportName}`,
      compactJson({
        syntheticSimulation: true,
        reportName: request.reportName,
        basis: result.Header.ReportBasis,
        startDate: result.Header.StartPeriod,
        endDate: result.Header.EndPeriod,
        totals: result.totals,
        metadata: result.metadata,
      }),
      result,
      { ...request },
    );
  }
}

function evidence(
  title: string,
  locator: string,
  summary: string,
  data: unknown,
  query?: Record<string, unknown>,
): Evidence {
  return {
    id: `QB-${randomUUID().slice(0, 8)}`,
    source: "quickbooks",
    title,
    locator,
    retrievedAt: new Date().toISOString(),
    summary: `${SYNTHETIC_NOTICE} ${summary}`,
    data,
    ...(query === undefined ? {} : { query }),
  };
}

function parseEntityTypes(value: unknown): EntityType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("transactionTypes must be a non-empty array");
  }
  const invalid = value.filter(
    (item) => typeof item !== "string" || !ENTITY_TYPES.includes(item as EntityType),
  );
  if (invalid.length > 0) {
    throw new Error(`Unsupported transactionTypes: ${invalid.map(String).join(", ")}`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error("transactionTypes must not contain duplicates");
  }
  return value as EntityType[];
}
