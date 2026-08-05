import {
  analyzeCustomerRevenue,
  analyzeServiceRevenue,
  type CustomerRevenueAnalysis,
  type CustomerRevenueAnalysisRequest,
  type ServiceRevenueAnalysis,
  type ServiceRevenueAnalysisRequest,
} from "./analytics.js";
import { simulatedFinancialDataset } from "./data/index.js";
import type {
  EntityType,
  FinancialDataset,
  IsoDate,
  QboEntity,
} from "./types.js";
import {
  ENTITY_TYPES,
  SYNTHETIC_NOTICE,
  dateRange,
  entityCustomerId,
  entityVendorId,
  paginate,
  parseIsoDate,
} from "./shared.js";
import {
  buildReport,
  type QboStyleReport,
  type ReportRequest,
} from "./reports.js";

const QUERYABLE_ENTITIES = [
  "Account",
  "Customer",
  "Vendor",
  "Item",
  "Invoice",
  "Payment",
  "Bill",
  "BillPayment",
  "Purchase",
  "JournalEntry",
] as const;

type QueryableEntity = (typeof QUERYABLE_ENTITIES)[number];
type QueryObject = FinancialDataset["accounts"][number]
  | FinancialDataset["customers"][number]
  | FinancialDataset["vendors"][number]
  | FinancialDataset["items"][number]
  | QboEntity;

export type CompanyInfoResponse = {
  syntheticSimulation: true;
  notice: string;
  CompanyInfo: {
    Id: string;
    CompanyName: string;
    LegalName: string;
    Country: "US";
    CompanyAddr: {
      Line1: string;
      City: string;
      CountrySubDivisionCode: string;
      PostalCode: string;
      Country: "US";
    };
    CustomerCommunicationAddr: {
      Line1: string;
      City: string;
      CountrySubDivisionCode: string;
      PostalCode: string;
      Country: "US";
    };
    PrimaryPhone: { FreeFormNumber: string };
    Email: { Address: string };
    WebAddr: { URI: string };
    FiscalYearStartMonth: "January";
    SupportedLanguages: "en";
    NameValue: Array<{ Name: string; Value: string }>;
    domain: "QBO";
    sparse: false;
  };
  dataset: {
    name: string;
    startDate: IsoDate;
    endDate: IsoDate;
    currency: "USD";
  };
};

export type QboQueryResponse = {
  syntheticSimulation: true;
  notice: string;
  QueryResponse: Record<string, QueryObject[] | number>;
  time: string;
};

export type TransactionSearchRequest = {
  startDate?: string;
  endDate?: string;
  transactionTypes?: EntityType[];
  customerId?: string;
  customerName?: string;
  vendorId?: string;
  vendorName?: string;
  startPosition?: number;
  maxResults?: number;
};

export type TransactionSearchResponse = {
  syntheticSimulation: true;
  notice: string;
  QueryResponse: {
    Transaction: QboEntity[];
    startPosition: number;
    maxResults: number;
    totalCount: number;
  };
  filters: Record<string, unknown>;
  time: string;
};

export interface QuickBooksClient {
  companyInfo(): CompanyInfoResponse;
  query(query: string): QboQueryResponse;
  transactions(request: TransactionSearchRequest): TransactionSearchResponse;
  report(request: ReportRequest): QboStyleReport;
  analyzeCustomerRevenue(
    request?: CustomerRevenueAnalysisRequest,
  ): CustomerRevenueAnalysis;
  analyzeServiceRevenue(
    request?: ServiceRevenueAnalysisRequest,
  ): ServiceRevenueAnalysis;
  datasetRange(): { startDate: IsoDate; endDate: IsoDate };
}

export class SimulatedQuickBooksClient implements QuickBooksClient {
  constructor(private readonly dataset: FinancialDataset = simulatedFinancialDataset) {}

  companyInfo(): CompanyInfoResponse {
    return {
      syntheticSimulation: true,
      notice: SYNTHETIC_NOTICE,
      CompanyInfo: {
        Id: "simulated-ontix-iq",
        CompanyName: "DEPARTURE (Synthetic Simulation)",
        LegalName: "DEPARTURE Synthetic Financial Dataset",
        Country: "US",
        CompanyAddr: {
          Line1: "100 Simulation Way",
          City: "San Diego",
          CountrySubDivisionCode: "CA",
          PostalCode: "92101",
          Country: "US",
        },
        CustomerCommunicationAddr: {
          Line1: "100 Simulation Way",
          City: "San Diego",
          CountrySubDivisionCode: "CA",
          PostalCode: "92101",
          Country: "US",
        },
        PrimaryPhone: { FreeFormNumber: "(000) 000-0000" },
        Email: { Address: "synthetic@example.invalid" },
        WebAddr: { URI: "https://example.invalid/synthetic-quickbooks" },
        FiscalYearStartMonth: "January",
        SupportedLanguages: "en",
        NameValue: [
          { Name: "Currency", Value: this.dataset.metadata.currency },
          { Name: "SimulationStart", Value: this.dataset.metadata.startDate },
          { Name: "SimulationEnd", Value: this.dataset.metadata.endDate },
          { Name: "DataClassification", Value: "SYNTHETIC_SIMULATION" },
        ],
        domain: "QBO",
        sparse: false,
      },
      dataset: {
        name: this.dataset.metadata.name,
        startDate: this.dataset.metadata.startDate,
        endDate: this.dataset.metadata.endDate,
        currency: this.dataset.metadata.currency,
      },
    };
  }

  query(query: string): QboQueryResponse {
    const parsed = parseQuery(query);
    const source = this.querySource(parsed.entity);
    const filtered = source.filter((value) =>
      parsed.conditions.every((condition) => conditionMatches(value, condition)),
    );
    const page = paginate(filtered, parsed.pagination);
    return {
      syntheticSimulation: true,
      notice: SYNTHETIC_NOTICE,
      QueryResponse: {
        [parsed.entity]: page.items,
        startPosition: page.startPosition,
        maxResults: page.maxResults,
        totalCount: page.totalCount,
      },
      time: new Date().toISOString(),
    };
  }

  transactions(request: TransactionSearchRequest): TransactionSearchResponse {
    const range = dateRange(this.dataset, request.startDate, request.endDate);
    const types = request.transactionTypes;
    if (types !== undefined) {
      if (!Array.isArray(types) || types.length === 0) {
        throw new Error("transactionTypes must be a non-empty array");
      }
      const invalid = types.filter((type) => !ENTITY_TYPES.includes(type));
      if (invalid.length > 0) {
        throw new Error(`Unsupported transactionTypes: ${invalid.join(", ")}`);
      }
    }
    const customerId = resolveParty(
      this.dataset.customers,
      request.customerId,
      request.customerName,
      "customer",
    );
    const vendorId = resolveParty(
      this.dataset.vendors,
      request.vendorId,
      request.vendorName,
      "vendor",
    );
    const startPosition = validatePagination(
      request.startPosition ?? 1,
      "startPosition",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const maxResults = validatePagination(request.maxResults ?? 100, "maxResults", 1, 1000);
    const matches = this.dataset.entities
      .filter((entity) => entity.TxnDate >= range.start && entity.TxnDate <= range.end)
      .filter((entity) => types === undefined || types.includes(entity.entityType))
      .filter((entity) => customerId === undefined || entityCustomerId(entity) === customerId)
      .filter((entity) => vendorId === undefined || entityVendorId(entity) === vendorId)
      .sort((left, right) =>
        right.TxnDate.localeCompare(left.TxnDate) || left.Id.localeCompare(right.Id),
      );
    const page = paginate(matches, { startPosition, maxResults });
    return {
      syntheticSimulation: true,
      notice: SYNTHETIC_NOTICE,
      QueryResponse: {
        Transaction: page.items,
        startPosition: page.startPosition,
        maxResults: page.maxResults,
        totalCount: page.totalCount,
      },
      filters: {
        startDate: range.start,
        endDate: range.end,
        ...(types === undefined ? {} : { transactionTypes: types }),
        ...(customerId === undefined ? {} : { customerId }),
        ...(vendorId === undefined ? {} : { vendorId }),
      },
      time: new Date().toISOString(),
    };
  }

  report(request: ReportRequest): QboStyleReport {
    return buildReport(this.dataset, request);
  }

  analyzeCustomerRevenue(
    request: CustomerRevenueAnalysisRequest = {},
  ): CustomerRevenueAnalysis {
    return analyzeCustomerRevenue(this.dataset, request);
  }

  analyzeServiceRevenue(
    request: ServiceRevenueAnalysisRequest = {},
  ): ServiceRevenueAnalysis {
    return analyzeServiceRevenue(this.dataset, request);
  }

  datasetRange(): { startDate: IsoDate; endDate: IsoDate } {
    return {
      startDate: this.dataset.metadata.startDate,
      endDate: this.dataset.metadata.endDate,
    };
  }

  private querySource(entity: QueryableEntity): QueryObject[] {
    if (entity === "Account") return this.dataset.accounts;
    if (entity === "Customer") return this.dataset.customers;
    if (entity === "Vendor") return this.dataset.vendors;
    if (entity === "Item") return this.dataset.items;
    return this.dataset.entities.filter((value) => value.entityType === entity);
  }
}

type QueryCondition = {
  field: string;
  operator: "=" | ">=" | "<=" | ">" | "<";
  value: string;
};

type ParsedQuery = {
  entity: QueryableEntity;
  conditions: QueryCondition[];
  pagination: { startPosition: number; maxResults: number };
};

function parseQuery(value: string): ParsedQuery {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("query must be a non-empty string");
  }
  const match = value.match(
    /^\s*SELECT\s+\*\s+FROM\s+([A-Za-z]+)(?:\s+WHERE\s+(.+?))?(?:\s+STARTPOSITION\s+(\d+))?(?:\s+MAXRESULTS\s+(\d+))?\s*$/i,
  );
  if (match === null) {
    throw new Error(
      "Invalid QBO query. Use SELECT * FROM <entity> [WHERE field op 'value' [AND ...]] [STARTPOSITION n] [MAXRESULTS n]",
    );
  }
  const requestedEntity = match[1] ?? "";
  const entity = QUERYABLE_ENTITIES.find(
    (candidate) => candidate.toLowerCase() === requestedEntity.toLowerCase(),
  );
  if (entity === undefined) {
    throw new Error(
      `Unsupported query entity ${requestedEntity}; supported entities: ${QUERYABLE_ENTITIES.join(", ")}`,
    );
  }
  const startPosition = validatePagination(
    match[3] === undefined ? 1 : Number(match[3]),
    "STARTPOSITION",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxResults = validatePagination(
    match[4] === undefined ? 100 : Number(match[4]),
    "MAXRESULTS",
    1,
    1000,
  );
  return {
    entity,
    conditions: parseConditions(match[2], entity),
    pagination: { startPosition, maxResults },
  };
}

function parseConditions(where: string | undefined, entity: QueryableEntity): QueryCondition[] {
  if (where === undefined) return [];
  const allowedEquality = new Set([
    "id",
    "name",
    "displayname",
    "fullyqualifiedname",
    "companyname",
    "docnumber",
    "customerref",
    "customerref.value",
    "vendorref",
    "vendorref.value",
    "entityref",
    "entityref.value",
    "accountref",
    "accountref.value",
    "accounttype",
  ]);
  return where.split(/\s+AND\s+/i).map((fragment) => {
    const match = fragment.trim().match(
      /^([A-Za-z][A-Za-z0-9.]*)\s*(=|>=|<=|>|<)\s*'((?:''|[^'])*)'$/,
    );
    if (match === null) {
      throw new Error(
        `Invalid WHERE condition "${fragment.trim()}"; use quoted values and join conditions with AND`,
      );
    }
    const field = match[1] ?? "";
    const operator = match[2] as QueryCondition["operator"];
    const conditionValue = (match[3] ?? "").replaceAll("''", "'");
    const normalized = field.toLowerCase();
    if (normalized === "txndate") {
      if (
        !["Invoice", "Payment", "Bill", "BillPayment", "Purchase", "JournalEntry"].includes(
          entity,
        )
      ) {
        throw new Error(`TxnDate filtering is not supported for ${entity}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(conditionValue)) {
        throw new Error("TxnDate filter values must use YYYY-MM-DD format");
      }
      parseIsoDate(conditionValue, "TxnDate filter");
    } else {
      if (!allowedEquality.has(normalized)) {
        throw new Error(`Unsupported WHERE field ${field}`);
      }
      if (operator !== "=") {
        throw new Error(`${field} supports equality only`);
      }
    }
    return { field, operator, value: conditionValue };
  });
}

function conditionMatches(value: QueryObject, condition: QueryCondition): boolean {
  const field = condition.field.toLowerCase();
  const actual = field === "txndate"
    ? propertyString(value, "TxnDate")
    : referenceOrProperty(value, field);
  if (actual === undefined) return false;
  if (condition.operator === "=") {
    const candidates = Array.isArray(actual) ? actual : [actual];
    return candidates.some(
      (candidate) =>
        candidate.localeCompare(condition.value, undefined, { sensitivity: "accent" }) === 0,
    );
  }
  if (Array.isArray(actual)) return false;
  if (condition.operator === ">=") return actual >= condition.value;
  if (condition.operator === "<=") return actual <= condition.value;
  if (condition.operator === ">") return actual > condition.value;
  return actual < condition.value;
}

function referenceOrProperty(value: QueryObject, field: string): string | string[] | undefined {
  if (field === "name") {
    return propertyString(value, "Name") ?? propertyString(value, "DisplayName");
  }
  const directNames: Record<string, string> = {
    id: "Id",
    displayname: "DisplayName",
    fullyqualifiedname: "FullyQualifiedName",
    companyname: "CompanyName",
    docnumber: "DocNumber",
    accounttype: "AccountType",
  };
  const direct = directNames[field];
  if (direct !== undefined) return propertyString(value, direct);
  const root = field.split(".")[0] ?? "";
  const canonical: Record<string, string> = {
    customerref: "CustomerRef",
    vendorref: "VendorRef",
    entityref: "EntityRef",
    accountref: "AccountRef",
  };
  const key = canonical[root];
  if (key === undefined) return undefined;
  const reference = (value as unknown as Record<string, unknown>)[key];
  if (typeof reference !== "object" || reference === null) return undefined;
  const candidate = reference as Record<string, unknown>;
  const refValue = typeof candidate.value === "string" ? candidate.value : undefined;
  const refName = typeof candidate.name === "string" ? candidate.name : undefined;
  if (field.endsWith(".value")) return refValue;
  const values = [refValue, refName].filter((item): item is string => item !== undefined);
  return values.length === 0 ? undefined : values;
}

function propertyString(value: QueryObject, key: string): string | undefined {
  const candidate = (value as unknown as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function validatePagination(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function resolveParty(
  parties: Array<{ Id: string; DisplayName: string }>,
  id: string | undefined,
  name: string | undefined,
  label: "customer" | "vendor",
): string | undefined {
  if (id !== undefined && (typeof id !== "string" || id.trim() === "")) {
    throw new Error(`${label}Id must be a non-empty string`);
  }
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    throw new Error(`${label}Name must be a non-empty string`);
  }
  const byId = id === undefined
    ? undefined
    : parties.find((party) => party.Id.toLowerCase() === id.trim().toLowerCase());
  if (id !== undefined && byId === undefined) throw new Error(`Unknown ${label}Id ${id}`);
  const byName = name === undefined
    ? undefined
    : parties.find(
      (party) => party.DisplayName.toLowerCase() === name.trim().toLowerCase(),
    );
  if (name !== undefined && byName === undefined) throw new Error(`Unknown ${label}Name ${name}`);
  if (byId !== undefined && byName !== undefined && byId.Id !== byName.Id) {
    throw new Error(`${label}Id and ${label}Name identify different records`);
  }
  return byId?.Id ?? byName?.Id;
}
