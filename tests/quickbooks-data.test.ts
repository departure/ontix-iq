import { describe, expect, it } from "vitest";
import {
  AR_MULTIPLIER,
  generateFinancialDataset,
  MINIMUM_CASH_RESERVE,
  OPENING_CASH,
  SIMULATION_END,
  SIMULATION_START,
  validateFinancialDataset,
} from "../skills/quickbooks/data/index.js";
import type {
  QboBill,
  QboInvoice,
  QboJournalEntry,
  QboPurchase,
} from "../skills/quickbooks/types.js";

describe("simulated QuickBooks dataset", () => {
  it("is deterministic, bounded, dense, and balanced", () => {
    const first = generateFinancialDataset();
    const second = generateFinancialDataset();

    expect(first).toEqual(second);
    expect(first.metadata.startDate).toBe(SIMULATION_START);
    expect(first.metadata.endDate).toBe(SIMULATION_END);
    expect(first.entities.every((entity) => entity.TxnDate >= SIMULATION_START)).toBe(true);
    expect(first.entities.every((entity) => entity.TxnDate <= SIMULATION_END)).toBe(true);
    expect(Math.min(...Object.values(first.metadata.completeMonthPostingCounts))).toBeGreaterThanOrEqual(200);
    expect(validateFinancialDataset(first)).toEqual({
      valid: true,
      errors: [],
      unbalancedTransactionIds: [],
    });
  });

  it("opens with $500,000 and maintains the documented healthy reserve", () => {
    const dataset = generateFinancialDataset();
    const opening = dataset.entities.find(
      (entity): entity is QboJournalEntry =>
        entity.entityType === "JournalEntry" && entity.DocNumber === "OPENING-2023",
    );

    expect(opening?.TotalAmt).toBe(OPENING_CASH);
    expect(AR_MULTIPLIER).toBe(2.5);
    expect(dataset.metadata.minimumObservedCash).toBeGreaterThanOrEqual(MINIMUM_CASH_RESERVE);
    expect(dataset.metadata.endingCash).toBeGreaterThanOrEqual(OPENING_CASH);
  });

  it("honors customer start, stop, gradual decline, and special-payment schedules", () => {
    const invoices = generateFinancialDataset().entities.filter(
      (entity): entity is QboInvoice => entity.entityType === "Invoice",
    );
    const forCustomer = (customerId: string) =>
      invoices.filter((invoice) => invoice.CustomerRef.value === customerId);

    expect(forCustomer("c-exit").at(-1)?.TxnDate).toMatch(/^2024-06-/);
    expect(forCustomer("c-ingenium").at(-1)?.TxnDate).toMatch(/^2026-02-/);
    expect(forCustomer("c-macroair")[0]?.TxnDate).toMatch(/^2025-07-/);
    expect(forCustomer("c-resmed").at(-1)?.TxnDate).toMatch(/^2024-12-/);
    expect(forCustomer("c-mission")).toHaveLength(1);
    expect(forCustomer("c-mission")[0]).toMatchObject({
      TxnDate: "2024-04-01",
      TotalAmt: 55_000 * AR_MULTIPLIER,
    });
    expect(forCustomer("c-silvia").map((invoice) => invoice.TxnDate)).toEqual([
      "2024-02-01",
      "2025-02-01",
    ]);
    expect(forCustomer("c-svc").map((invoice) => invoice.TxnDate)).toEqual([
      "2024-08-15",
      "2025-02-15",
    ]);
  });

  it("honors recurring bills, annual renewals, payroll cadence, and expense caps", () => {
    const dataset = generateFinancialDataset();
    const bills = dataset.entities.filter(
      (entity): entity is QboBill => entity.entityType === "Bill",
    );
    const purchases = dataset.entities.filter(
      (entity): entity is QboPurchase => entity.entityType === "Purchase",
    );
    const payroll = dataset.entities.filter(
      (entity): entity is QboJournalEntry =>
        entity.entityType === "JournalEntry" && entity.DocNumber.startsWith("PAYROLL-"),
    );

    expect(
      bills.filter((bill) => bill.VendorRef.value === "v-avison").every((bill) => bill.TxnDate.endsWith("-01")),
    ).toBe(true);
    expect(
      bills.find((bill) => bill.VendorRef.value === "v-sketch" && bill.TxnDate === "2024-01-08")?.TotalAmt,
    ).toBe(720);
    expect(
      bills.find((bill) => bill.VendorRef.value === "v-dropbox" && bill.TxnDate === "2025-12-30")?.TotalAmt,
    ).toBe(4_032);
    expect(payroll).toHaveLength(79);
    expect(
      payroll.slice(1).every((entry, index) => {
        const previous = payroll[index];
        if (previous === undefined) return false;
        return (
          (Date.parse(`${entry.TxnDate}T00:00:00Z`) -
            Date.parse(`${previous.TxnDate}T00:00:00Z`)) /
            86_400_000 ===
          14
        );
      }),
    ).toBe(true);

    const reimbursementsByPersonMonth = new Map<string, number>();
    for (const purchase of purchases.filter((entity) => entity.EntityRef?.value === "v-reimburse")) {
      const employee = purchase.PrivateNote.replace("Employee expense — ", "");
      const key = `${purchase.TxnDate.slice(0, 7)}:${employee}`;
      reimbursementsByPersonMonth.set(key, (reimbursementsByPersonMonth.get(key) ?? 0) + 1);
      expect(purchase.TotalAmt).toBeGreaterThanOrEqual(20);
      expect(purchase.TotalAmt).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...reimbursementsByPersonMonth.values())).toBe(1);

    const miscByMonth = new Map<string, number>();
    for (const purchase of purchases.filter((entity) => entity.EntityRef?.value === "v-misc")) {
      const month = purchase.TxnDate.slice(0, 7);
      miscByMonth.set(month, (miscByMonth.get(month) ?? 0) + purchase.TotalAmt);
    }
    expect([...miscByMonth.values()].every((total) => total <= 300.01)).toBe(true);
  });

  it("uses QBO-shaped bill payments, valid payment types, items, and payroll liabilities", () => {
    const dataset = generateFinancialDataset();
    const bills = dataset.entities.filter(
      (entity): entity is QboBill => entity.entityType === "Bill",
    );
    const billPayments = dataset.entities.filter(
      (entity) => entity.entityType === "BillPayment",
    );
    const purchases = dataset.entities.filter(
      (entity): entity is QboPurchase => entity.entityType === "Purchase",
    );
    const itemIds = new Set(dataset.items.map((item) => item.Id));
    const invoices = dataset.entities.filter(
      (entity): entity is QboInvoice => entity.entityType === "Invoice",
    );

    expect(billPayments).toHaveLength(bills.filter((bill) => bill.Balance === 0).length);
    expect(
      billPayments.every(
        (payment) =>
          payment.PayType === "Check" &&
          payment.CheckPayment.BankAccountRef.value === "1" &&
          payment.Line[0]?.LinkedTxn[0]?.TxnType === "Bill",
      ),
    ).toBe(true);
    expect(
      purchases.every((purchase) =>
        ["Cash", "Check", "CreditCard"].includes(purchase.PaymentType),
      ),
    ).toBe(true);
    expect(
      invoices.every((invoice) =>
        invoice.Line.every((line) => itemIds.has(line.SalesItemLineDetail.ItemRef.value)),
      ),
    ).toBe(true);
    expect(dataset.accounts.find((account) => account.Id === "12")?.CurrentBalance).toBe(0);
  });

  it("uses only the requested travel destinations", () => {
    const allowed = [
      "St. Louis, MO",
      "Purchase, NY",
      "Bentonville, AR",
      "Neosho, MO",
      "Franklin Lakes, NJ",
      "Allentown, PA",
    ];
    const trips = generateFinancialDataset().entities.filter(
      (entity): entity is QboPurchase =>
        entity.entityType === "Purchase" && entity.EntityRef?.value === "v-travel",
    );

    expect(trips.length).toBeGreaterThanOrEqual(18);
    expect(
      trips.every((trip) => allowed.some((city) => trip.PrivateNote.includes(city))),
    ).toBe(true);
  });
});
