import { describe, expect, it } from "vitest";
import {
  QuickBooksSkill,
  SimulatedQuickBooksClient,
} from "../skills/quickbooks/index.js";

describe("simulated QuickBooks client", () => {
  it("returns QBO query envelopes with filters and pagination", () => {
    const client = new SimulatedQuickBooksClient();
    const first = client.query(
      "SELECT * FROM Invoice WHERE TxnDate >= '2025-01-01' AND CustomerRef = 'c-xifin' STARTPOSITION 1 MAXRESULTS 5",
    );
    const second = client.query(
      "select * from invoice where txndate >= '2025-01-01' and customerref = 'c-xifin' startposition 6 maxresults 5",
    );

    expect(first.syntheticSimulation).toBe(true);
    expect(first.QueryResponse.Invoice).toHaveLength(5);
    expect(first.QueryResponse.startPosition).toBe(1);
    expect(first.QueryResponse.totalCount).toBeGreaterThan(5);
    expect(second.QueryResponse.startPosition).toBe(6);
    expect(second.QueryResponse.Invoice).not.toEqual(first.QueryResponse.Invoice);
  });

  it("queries QBO reference entities and proper bill payments", () => {
    const client = new SimulatedQuickBooksClient();
    const items = client.query("SELECT * FROM Item MAXRESULTS 10");
    const billPayments = client.query(
      "SELECT * FROM BillPayment WHERE TxnDate >= '2026-01-01' MAXRESULTS 10",
    );

    expect(items.QueryResponse.Item).toHaveLength(4);
    expect(billPayments.QueryResponse.BillPayment).toHaveLength(10);
  });

  it("validates QBO query syntax and bounds", () => {
    const client = new SimulatedQuickBooksClient();

    expect(() => client.query("DELETE FROM Invoice")).toThrow("Invalid QBO query");
    expect(() => client.query("SELECT * FROM Invoice MAXRESULTS 1001")).toThrow(
      "MAXRESULTS",
    );
    expect(() =>
      client.transactions({ startDate: "2026-02-30" }),
    ).toThrow("valid calendar date");
    expect(() =>
      client.transactions({ startDate: "2026-05-01", endDate: "2026-04-01" }),
    ).toThrow("on or before");
  });

  it("supports structured customer and vendor transaction searches", () => {
    const client = new SimulatedQuickBooksClient();
    const customer = client.transactions({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      customerName: "XiFin, Inc.",
      maxResults: 1_000,
    });
    const vendor = client.transactions({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      vendorName: "Avison Young",
      maxResults: 1_000,
    });

    expect(customer.QueryResponse.totalCount).toBe(24);
    expect(
      customer.QueryResponse.Transaction.every(
        (entity) =>
          (entity.entityType === "Invoice" || entity.entityType === "Payment") &&
          entity.CustomerRef.value === "c-xifin",
      ),
    ).toBe(true);
    expect(vendor.QueryResponse.totalCount).toBe(24);
    expect(
      vendor.QueryResponse.Transaction.every(
        (entity) =>
          (entity.entityType === "Bill" || entity.entityType === "BillPayment") &&
          entity.VendorRef.value === "v-avison",
      ),
    ).toBe(true);
  });

  it("produces balanced statements and meaningful cash/accrual reports", () => {
    const client = new SimulatedQuickBooksClient();
    const accrual = client.report({
      reportName: "ProfitAndLoss",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      accountingMethod: "ACCRUAL",
    });
    const cash = client.report({
      reportName: "ProfitAndLoss",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      accountingMethod: "CASH",
    });
    const balance = client.report({
      reportName: "BalanceSheet",
      endDate: "2025-12-31",
    });
    const flow = client.report({
      reportName: "CashFlow",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(accrual.totals.netIncome).not.toBe(cash.totals.netIncome);
    expect(balance.totals.totalAssets).toBeCloseTo(
      balance.totals.totalLiabilitiesAndEquity ?? 0,
      2,
    );
    expect(flow.totals.endingCash).toBeGreaterThan(0);
  });

  it("derives historical aging and caps general-ledger output", () => {
    const client = new SimulatedQuickBooksClient();
    const receivables = client.report({
      reportName: "AgedReceivables",
      endDate: "2025-06-20",
    });
    const payables = client.report({
      reportName: "AgedPayables",
      endDate: "2025-06-05",
    });
    const ledger = client.report({
      reportName: "GeneralLedger",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      maxRows: 25,
    });

    expect(receivables.totals.total).toBeGreaterThan(0);
    expect(payables.totals.total).toBeGreaterThan(0);
    expect(ledger.Rows.Row).toHaveLength(25);
    expect(ledger.metadata).toMatchObject({ returnedRows: 25, truncated: true });
  });
  it("produces exact customer and service revenue analytics without invoice paging", () => {
    const client = new SimulatedQuickBooksClient();
    const customers = client.analyzeCustomerRevenue({
      startDate: "2026-01-01",
      endDate: "2026-08-04",
      limit: 10,
    });
    const services = client.analyzeServiceRevenue({
      startDate: "2026-01-01",
      endDate: "2026-08-04",
    });
    const paged = client.query(
      "SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-08-04' STARTPOSITION 1 MAXRESULTS 25",
    );

    expect(customers.invoiceCount).toBeGreaterThan(
      (paged.QueryResponse.Invoice as unknown[]).length,
    );
    expect(customers.ranking).toHaveLength(10);
    expect(customers.ranking[0]?.invoicedAmount).toBeGreaterThan(0);
    expect(
      customers.ranking.reduce((sum, row) => sum + row.invoicedAmount, 0),
    ).toBeLessThanOrEqual(customers.totalInvoiced + 0.001);
    expect(customers.truncated).toBe(customers.customerCount > 10);
    expect(services.services.map((row) => row.serviceKey)).toEqual([
      "branding",
      "web",
      "video",
      "imaging",
    ]);
    expect(services.services.every((row) => row.invoicedAmount > 0)).toBe(true);
    expect(
      services.services.reduce((sum, row) => sum + row.invoicedAmount, 0),
    ).toBeCloseTo(services.totalInvoiced, 2);
    expect(services.limitations[0]).toContain("ORGANIZATION.md");
  });
});

describe("QuickBooks skill", () => {
  it("advertises analytical tools and clearly labels synthetic evidence", async () => {
    const skill = new QuickBooksSkill();
    const tools = await skill.tools();
    const evidence = await skill.execute("quickbooks_analyze_customer_revenue", {
      startDate: "2026-01-01",
      endDate: "2026-08-04",
      limit: 5,
    });
    const serviceEvidence = await skill.execute("quickbooks_analyze_service_revenue", {
      startDate: "2026-01-01",
      endDate: "2026-08-04",
    });
    const doctor = await skill.doctor();

    expect(tools.map((tool) => tool.name)).toEqual([
      "quickbooks_company_info",
      "quickbooks_query",
      "quickbooks_transactions",
      "quickbooks_report",
      "quickbooks_analyze_customer_revenue",
      "quickbooks_analyze_service_revenue",
    ]);
    expect(evidence[0]).toMatchObject({
      source: "quickbooks",
      locator: "quickbooks://simulated/analytics/customer-revenue",
    });
    expect(evidence[0]?.summary).toContain("Synthetic simulation");
    expect(serviceEvidence[0]?.locator).toBe(
      "quickbooks://simulated/analytics/service-revenue",
    );
    expect(doctor).toMatchObject({ status: "ok" });
    expect(doctor.message).toContain("no network");
  });
});
