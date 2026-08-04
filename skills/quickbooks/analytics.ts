import type {
  FinancialDataset,
  IsoDate,
  Money,
  QboInvoice,
} from "./types.js";
import { SYNTHETIC_NOTICE, dateRange, parseIsoDate } from "./shared.js";

export const ORGANIZATION_SERVICE_LINES = [
  {
    key: "branding",
    displayName: "Branding",
    itemId: "item-30",
    accountId: "30",
    organizationKeywords: [
      "branding",
      "logo",
      "logotype",
      "style guide",
      "colors",
      "lockup",
      "identity",
    ],
  },
  {
    key: "web",
    displayName: "Web development",
    itemId: "item-31",
    accountId: "31",
    organizationKeywords: [
      "website",
      "WordPress",
      "AWS",
      "Vue",
      "HTML",
      "JavaScript",
      "CSS",
      "UI",
      "UX",
    ],
  },
  {
    key: "video",
    displayName: "Video",
    itemId: "item-32",
    accountId: "32",
    organizationKeywords: ["Video", "YouTube", "TikTok"],
  },
  {
    key: "imaging",
    displayName: "Imaging",
    itemId: "item-33",
    accountId: "33",
    organizationKeywords: ["Photoshop", "ads"],
  },
] as const;

export type OrganizationServiceKey = (typeof ORGANIZATION_SERVICE_LINES)[number]["key"];

export type CustomerRevenueAnalysisRequest = {
  startDate?: string;
  endDate?: string;
  limit?: number;
};

export type CustomerRevenueRank = {
  rank: number;
  customerId: string;
  customerName: string;
  invoicedAmount: Money;
  invoiceCount: number;
  shareOfTotal: number;
};

export type CustomerRevenueAnalysis = {
  syntheticSimulation: true;
  notice: string;
  basis: "accrual_invoiced";
  currency: "USD";
  startDate: IsoDate;
  endDate: IsoDate;
  totalInvoiced: Money;
  invoiceCount: number;
  customerCount: number;
  returnedCustomers: number;
  truncated: boolean;
  ranking: CustomerRevenueRank[];
};

export type ServiceRevenueAnalysisRequest = {
  startDate?: string;
  endDate?: string;
};

export type ServiceRevenueRow = {
  serviceKey: OrganizationServiceKey;
  displayName: string;
  itemId: string;
  accountId: string;
  organizationKeywords: readonly string[];
  invoicedAmount: Money;
  lineCount: number;
  shareOfTotal: number;
};

export type ServiceRevenueAnalysis = {
  syntheticSimulation: true;
  notice: string;
  basis: "accrual_invoiced_line_items";
  currency: "USD";
  startDate: IsoDate;
  endDate: IsoDate;
  totalInvoiced: Money;
  invoiceCount: number;
  services: ServiceRevenueRow[];
  limitations: string[];
};

function roundMoney(value: number): Money {
  return Math.round(value * 100) / 100;
}

function invoicesInRange(
  dataset: FinancialDataset,
  startDate: IsoDate,
  endDate: IsoDate,
): QboInvoice[] {
  return dataset.entities.filter(
    (entity): entity is QboInvoice =>
      entity.entityType === "Invoice"
      && entity.TxnDate >= startDate
      && entity.TxnDate <= endDate,
  );
}

export function analyzeCustomerRevenue(
  dataset: FinancialDataset,
  request: CustomerRevenueAnalysisRequest = {},
): CustomerRevenueAnalysis {
  const range = dateRange(dataset, request.startDate, request.endDate);
  const limit = request.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  if (request.startDate !== undefined) parseIsoDate(request.startDate, "startDate");
  if (request.endDate !== undefined) parseIsoDate(request.endDate, "endDate");

  const invoices = invoicesInRange(dataset, range.start, range.end);
  const byCustomer = new Map<
    string,
    { customerId: string; customerName: string; invoicedAmount: number; invoiceCount: number }
  >();

  for (const invoice of invoices) {
    const existing = byCustomer.get(invoice.CustomerRef.value) ?? {
      customerId: invoice.CustomerRef.value,
      customerName: invoice.CustomerRef.name ?? invoice.CustomerRef.value,
      invoicedAmount: 0,
      invoiceCount: 0,
    };
    existing.invoicedAmount = roundMoney(existing.invoicedAmount + invoice.TotalAmt);
    existing.invoiceCount += 1;
    byCustomer.set(invoice.CustomerRef.value, existing);
  }

  const totalInvoiced = roundMoney(
    [...byCustomer.values()].reduce((sum, row) => sum + row.invoicedAmount, 0),
  );
  const sorted = [...byCustomer.values()].sort(
    (left, right) =>
      right.invoicedAmount - left.invoicedAmount
      || left.customerName.localeCompare(right.customerName),
  );
  const ranking = sorted.slice(0, limit).map((row, index) => ({
    rank: index + 1,
    customerId: row.customerId,
    customerName: row.customerName,
    invoicedAmount: row.invoicedAmount,
    invoiceCount: row.invoiceCount,
    shareOfTotal: totalInvoiced === 0
      ? 0
      : roundMoney((row.invoicedAmount / totalInvoiced) * 100),
  }));

  return {
    syntheticSimulation: true,
    notice: SYNTHETIC_NOTICE,
    basis: "accrual_invoiced",
    currency: "USD",
    startDate: range.start,
    endDate: range.end,
    totalInvoiced,
    invoiceCount: invoices.length,
    customerCount: byCustomer.size,
    returnedCustomers: ranking.length,
    truncated: sorted.length > ranking.length,
    ranking,
  };
}

export function analyzeServiceRevenue(
  dataset: FinancialDataset,
  request: ServiceRevenueAnalysisRequest = {},
): ServiceRevenueAnalysis {
  const range = dateRange(dataset, request.startDate, request.endDate);
  if (request.startDate !== undefined) parseIsoDate(request.startDate, "startDate");
  if (request.endDate !== undefined) parseIsoDate(request.endDate, "endDate");

  const invoices = invoicesInRange(dataset, range.start, range.end);
  const totals = new Map<string, { amount: number; lineCount: number }>();
  for (const service of ORGANIZATION_SERVICE_LINES) {
    totals.set(service.itemId, { amount: 0, lineCount: 0 });
  }

  let totalInvoiced = 0;
  for (const invoice of invoices) {
    totalInvoiced = roundMoney(totalInvoiced + invoice.TotalAmt);
    for (const line of invoice.Line) {
      const itemId = line.SalesItemLineDetail.ItemRef.value;
      const bucket = totals.get(itemId);
      if (bucket === undefined) continue;
      bucket.amount = roundMoney(bucket.amount + line.Amount);
      bucket.lineCount += 1;
    }
  }

  const services: ServiceRevenueRow[] = ORGANIZATION_SERVICE_LINES.map((service) => {
    const bucket = totals.get(service.itemId) ?? { amount: 0, lineCount: 0 };
    return {
      serviceKey: service.key,
      displayName: service.displayName,
      itemId: service.itemId,
      accountId: service.accountId,
      organizationKeywords: service.organizationKeywords,
      invoicedAmount: bucket.amount,
      lineCount: bucket.lineCount,
      shareOfTotal: totalInvoiced === 0
        ? 0
        : roundMoney((bucket.amount / totalInvoiced) * 100),
    };
  });

  return {
    syntheticSimulation: true,
    notice: SYNTHETIC_NOTICE,
    basis: "accrual_invoiced_line_items",
    currency: "USD",
    startDate: range.start,
    endDate: range.end,
    totalInvoiced,
    invoiceCount: invoices.length,
    services,
    limitations: [
      "Service lines are aligned to ORGANIZATION.md Brand / Web / Video / Imaging keywords.",
      "Project Costs (COGS) are not allocated by service line, so service-level gross margin cannot be computed from this analysis.",
      "Use ProfitAndLoss for company-wide margins; use this tool for service-mix and service-revenue questions.",
    ],
  };
}
