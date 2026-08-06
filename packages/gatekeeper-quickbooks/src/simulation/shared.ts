import type {
  EntityType,
  FinancialDataset,
  IsoDate,
  QboEntity,
} from "./types.js";

export const SYNTHETIC_NOTICE =
  "Synthetic simulation using a fixed local QuickBooks-style dataset; not live QuickBooks data.";

export const ENTITY_TYPES: readonly EntityType[] = [
  "Invoice",
  "Payment",
  "Bill",
  "BillPayment",
  "Purchase",
  "JournalEntry",
];

export type Pagination = {
  startPosition: number;
  maxResults: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function assertNoUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseIsoDate(value: string, label: string): IsoDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return value as IsoDate;
}

export function dateWithinDataset(
  dataset: FinancialDataset,
  value: string,
  label: string,
): IsoDate {
  const date = parseIsoDate(value, label);
  if (date < dataset.metadata.startDate || date > dataset.metadata.endDate) {
    throw new Error(
      `${label} must be within the synthetic dataset range ${dataset.metadata.startDate} to ${dataset.metadata.endDate}`,
    );
  }
  return date;
}

export function dateRange(
  dataset: FinancialDataset,
  startValue: string | undefined,
  endValue: string | undefined,
): { start: IsoDate; end: IsoDate } {
  const start = startValue === undefined
    ? dataset.metadata.startDate
    : dateWithinDataset(dataset, startValue, "startDate");
  const end = endValue === undefined
    ? dataset.metadata.endDate
    : dateWithinDataset(dataset, endValue, "endDate");
  if (start > end) throw new Error("startDate must be on or before endDate");
  return { start, end };
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function entityCustomerId(entity: QboEntity): string | undefined {
  return entity.entityType === "Invoice" || entity.entityType === "Payment"
    ? entity.CustomerRef.value
    : undefined;
}

export function entityVendorId(entity: QboEntity): string | undefined {
  if (entity.entityType === "Bill" || entity.entityType === "BillPayment") {
    return entity.VendorRef.value;
  }
  if (entity.entityType === "Purchase") return entity.EntityRef?.value;
  return undefined;
}

export function daysBetween(earlier: IsoDate, later: IsoDate): number {
  return Math.floor(
    (Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`))
      / 86_400_000,
  );
}

export function paginate<T>(
  values: readonly T[],
  pagination: Pagination,
): { items: T[]; startPosition: number; maxResults: number; totalCount: number } {
  const offset = pagination.startPosition - 1;
  return {
    items: values.slice(offset, offset + pagination.maxResults),
    startPosition: pagination.startPosition,
    maxResults: pagination.maxResults,
    totalCount: values.length,
  };
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}
