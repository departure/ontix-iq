import type {
  FinancialDataset,
  IsoDate,
  PostingRecord,
  QboBill,
  QboInvoice,
} from "./types.js";
import {
  SYNTHETIC_NOTICE,
  dateRange,
  dateWithinDataset,
  daysBetween,
  roundMoney,
} from "./shared.js";

export const REPORT_NAMES = [
  "ProfitAndLoss",
  "BalanceSheet",
  "CashFlow",
  "GeneralLedger",
  "AgedReceivables",
  "AgedPayables",
] as const;

export type ReportName = (typeof REPORT_NAMES)[number];
export type AccountingMethod = "ACCRUAL" | "CASH";

export type ReportColumn = {
  ColTitle: string;
  ColType: "String" | "Date" | "Money";
};

export type ReportRow = {
  type: "Section" | "Data" | "Summary";
  group?: string;
  ColData?: Array<{ value: string | number }>;
  Rows?: { Row: ReportRow[] };
  Summary?: { ColData: Array<{ value: string | number }> };
};

export type QboStyleReport = {
  syntheticSimulation: true;
  notice: string;
  Header: {
    ReportName: ReportName;
    ReportBasis: AccountingMethod;
    StartPeriod?: IsoDate;
    EndPeriod: IsoDate;
    Currency: "USD";
    Time: string;
  };
  Columns: { Column: ReportColumn[] };
  Rows: { Row: ReportRow[] };
  totals: Record<string, number>;
  metadata: Record<string, unknown>;
};

export type ReportRequest = {
  reportName: ReportName;
  startDate?: string;
  endDate?: string;
  accountingMethod?: AccountingMethod;
  maxRows?: number;
};

type AmountByAccount = Map<string, number>;

export function buildReport(
  dataset: FinancialDataset,
  request: ReportRequest,
): QboStyleReport {
  switch (request.reportName) {
    case "ProfitAndLoss":
      return profitAndLoss(dataset, request);
    case "BalanceSheet":
      return balanceSheet(dataset, request);
    case "CashFlow":
      return cashFlow(dataset, request);
    case "GeneralLedger":
      return generalLedger(dataset, request);
    case "AgedReceivables":
      return agingReport(dataset, request, "receivable");
    case "AgedPayables":
      return agingReport(dataset, request, "payable");
  }
}

function reportBase(
  name: ReportName,
  method: AccountingMethod,
  end: IsoDate,
  start?: IsoDate,
): Pick<QboStyleReport, "syntheticSimulation" | "notice" | "Header"> {
  return {
    syntheticSimulation: true,
    notice: SYNTHETIC_NOTICE,
    Header: {
      ReportName: name,
      ReportBasis: method,
      ...(start === undefined ? {} : { StartPeriod: start }),
      EndPeriod: end,
      Currency: "USD",
      Time: new Date().toISOString(),
    },
  };
}

function profitAndLoss(
  dataset: FinancialDataset,
  request: ReportRequest,
): QboStyleReport {
  const { start, end } = dateRange(dataset, request.startDate, request.endDate);
  const method = request.accountingMethod ?? "ACCRUAL";
  const amounts = method === "CASH"
    ? cashBasisProfitAndLoss(dataset, start, end)
    : postingAmounts(dataset, start, end, ["Revenue", "Expense"]);
  const income = accountRows(dataset, amounts, (classification) => classification === "Revenue");
  const costOfGoods = accountRows(
    dataset,
    amounts,
    (_classification, type) => type === "Cost of Goods Sold",
  );
  const expenses = accountRows(
    dataset,
    amounts,
    (classification, type) => classification === "Expense" && type !== "Cost of Goods Sold",
  );
  const totalIncome = rowTotal(income);
  const totalCostOfGoods = rowTotal(costOfGoods);
  const grossProfit = roundMoney(totalIncome - totalCostOfGoods);
  const totalExpenses = rowTotal(expenses);
  const netIncome = roundMoney(grossProfit - totalExpenses);
  return {
    ...reportBase("ProfitAndLoss", method, end, start),
    Columns: moneyColumns("Account"),
    Rows: {
      Row: [
        section("Income", income, totalIncome),
        section("Cost of Goods Sold", costOfGoods, totalCostOfGoods),
        summaryRow("Gross Profit", grossProfit),
        section("Expenses", expenses, totalExpenses),
        summaryRow("Net Income", netIncome),
      ],
    },
    totals: { totalIncome, totalCostOfGoods, grossProfit, totalExpenses, netIncome },
    metadata: {
      accountingMethod: method,
      basisExplanation: method === "CASH"
        ? "Invoice income and bill expenses are recognized on linked settlement dates; direct cash purchases and journal entries retain their transaction dates."
        : "Income and expenses are recognized from ledger postings on transaction dates.",
    },
  };
}

function cashBasisProfitAndLoss(
  dataset: FinancialDataset,
  start: IsoDate,
  end: IsoDate,
): AmountByAccount {
  const accountById = new Map(dataset.accounts.map((account) => [account.Id, account]));
  const entityById = new Map(dataset.entities.map((entity) => [entity.Id, entity]));
  const result: AmountByAccount = new Map();
  for (const posting of dataset.postings) {
    const account = accountById.get(posting.accountId);
    if (account?.Classification !== "Revenue" && account?.Classification !== "Expense") continue;
    const entity = entityById.get(posting.transactionId);
    if (entity === undefined) continue;
    let recognitionDate = posting.transactionDate;
    if (entity.entityType === "Invoice") {
      const settlement = entity.LinkedTxn
        .map((link) => entityById.get(link.TxnId))
        .find((linked) => linked?.entityType === "Payment");
      if (settlement === undefined) continue;
      recognitionDate = settlement.TxnDate;
    } else if (entity.entityType === "Bill") {
      const settlement = entity.LinkedTxn
        .map((link) => entityById.get(link.TxnId))
        .find((linked) => linked?.entityType === "BillPayment");
      if (settlement === undefined) continue;
      recognitionDate = settlement.TxnDate;
    }
    if (recognitionDate < start || recognitionDate > end) continue;
    const normalAmount = account.Classification === "Revenue"
      ? (posting.side === "Credit" ? posting.amount : -posting.amount)
      : (posting.side === "Debit" ? posting.amount : -posting.amount);
    result.set(posting.accountId, roundMoney((result.get(posting.accountId) ?? 0) + normalAmount));
  }
  return result;
}

function balanceSheet(
  dataset: FinancialDataset,
  request: ReportRequest,
): QboStyleReport {
  if (request.startDate !== undefined) {
    throw new Error("BalanceSheet accepts endDate only; startDate is not applicable");
  }
  const end = request.endDate === undefined
    ? dataset.metadata.endDate
    : dateWithinDataset(dataset, request.endDate, "endDate");
  const balances = balancesThrough(dataset, end);
  const assets = accountRows(dataset, balances, (classification) => classification === "Asset");
  const liabilities = accountRows(dataset, balances, (classification) => classification === "Liability");
  const equity = accountRows(dataset, balances, (classification) => classification === "Equity");
  const cumulativeProfit = postingAmounts(
    dataset,
    dataset.metadata.startDate,
    end,
    ["Revenue", "Expense"],
  );
  const revenue = accountRows(dataset, cumulativeProfit, (classification) => classification === "Revenue");
  const expense = accountRows(dataset, cumulativeProfit, (classification) => classification === "Expense");
  const netIncome = roundMoney(rowTotal(revenue) - rowTotal(expense));
  equity.push(dataRow("Retained Earnings (simulated current earnings)", netIncome));
  const totalAssets = rowTotal(assets);
  const totalLiabilities = rowTotal(liabilities);
  const totalEquity = rowTotal(equity);
  return {
    ...reportBase("BalanceSheet", "ACCRUAL", end),
    Columns: moneyColumns("Account"),
    Rows: {
      Row: [
        section("Assets", assets, totalAssets),
        section("Liabilities", liabilities, totalLiabilities),
        section("Equity", equity, totalEquity),
        summaryRow("Total Liabilities and Equity", roundMoney(totalLiabilities + totalEquity)),
      ],
    },
    totals: {
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity),
    },
    metadata: { asOfDate: end },
  };
}

function cashFlow(
  dataset: FinancialDataset,
  request: ReportRequest,
): QboStyleReport {
  const { start, end } = dateRange(dataset, request.startDate, request.endDate);
  const accountById = new Map(dataset.accounts.map((account) => [account.Id, account]));
  const postingsByTransaction = groupPostings(dataset.postings);
  const categories = new Map<string, number>([
    ["Operating Activities", 0],
    ["Investing Activities", 0],
    ["Financing Activities", 0],
  ]);
  for (const entity of dataset.entities) {
    if (entity.TxnDate < start || entity.TxnDate > end) continue;
    const postings = postingsByTransaction.get(entity.Id) ?? [];
    const cashChange = postings
      .filter((posting) => accountById.get(posting.accountId)?.AccountType === "Bank")
      .reduce(
        (sum, posting) => sum + (posting.side === "Debit" ? posting.amount : -posting.amount),
        0,
      );
    if (cashChange === 0) continue;
    const counterparts = postings
      .map((posting) => accountById.get(posting.accountId))
      .filter((account) => account?.AccountType !== "Bank");
    const category = counterparts.some((account) => account?.Classification === "Equity")
      ? "Financing Activities"
      : counterparts.some((account) => account?.AccountType === "Fixed Asset")
        ? "Investing Activities"
        : "Operating Activities";
    categories.set(category, roundMoney((categories.get(category) ?? 0) + cashChange));
  }
  const operating = categories.get("Operating Activities") ?? 0;
  const investing = categories.get("Investing Activities") ?? 0;
  const financing = categories.get("Financing Activities") ?? 0;
  const netCashChange = roundMoney(operating + investing + financing);
  const beginningCash = roundMoney(
    [...balancesBefore(dataset, start).entries()]
      .filter(([id]) => accountById.get(id)?.AccountType === "Bank")
      .reduce((sum, [, amount]) => sum + amount, 0),
  );
  const endingCash = roundMoney(beginningCash + netCashChange);
  return {
    ...reportBase("CashFlow", "CASH", end, start),
    Columns: moneyColumns("Activity"),
    Rows: {
      Row: [
        section("Operating Activities", [dataRow("Net cash from operations", operating)], operating),
        section("Investing Activities", [dataRow("Net cash from investing", investing)], investing),
        section("Financing Activities", [dataRow("Net cash from financing", financing)], financing),
        summaryRow("Net Change in Cash", netCashChange),
      ],
    },
    totals: { operating, investing, financing, netCashChange, beginningCash, endingCash },
    metadata: { classification: "Cash ledger postings classified by non-cash counterpart account." },
  };
}

function generalLedger(
  dataset: FinancialDataset,
  request: ReportRequest,
): QboStyleReport {
  const { start, end } = dateRange(dataset, request.startDate, request.endDate);
  const maxRows = request.maxRows ?? 500;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) {
    throw new Error("maxRows must be an integer between 1 and 5000");
  }
  const accountById = new Map(dataset.accounts.map((account) => [account.Id, account]));
  const openings = balancesBefore(dataset, start);
  const postings = dataset.postings
    .filter((posting) => posting.transactionDate >= start && posting.transactionDate <= end)
    .sort((left, right) =>
      left.transactionDate.localeCompare(right.transactionDate) || left.id.localeCompare(right.id),
    );
  const availableRows = postings.length;
  const selected = postings.slice(0, maxRows);
  const running = new Map(openings);
  const rows = selected.map((posting) => {
    const account = accountById.get(posting.accountId);
    const normalDebit = account?.Classification === "Asset" || account?.Classification === "Expense";
    const delta = normalDebit
      ? (posting.side === "Debit" ? posting.amount : -posting.amount)
      : (posting.side === "Credit" ? posting.amount : -posting.amount);
    const balance = roundMoney((running.get(posting.accountId) ?? 0) + delta);
    running.set(posting.accountId, balance);
    return {
      type: "Data" as const,
      ColData: [
        { value: posting.transactionDate },
        { value: posting.accountName },
        { value: posting.transactionType },
        { value: posting.transactionId },
        { value: posting.memo },
        { value: posting.side === "Debit" ? posting.amount : 0 },
        { value: posting.side === "Credit" ? posting.amount : 0 },
        { value: balance },
      ],
    };
  });
  const debitTotal = roundMoney(selected.reduce(
    (sum, posting) => sum + (posting.side === "Debit" ? posting.amount : 0),
    0,
  ));
  const creditTotal = roundMoney(selected.reduce(
    (sum, posting) => sum + (posting.side === "Credit" ? posting.amount : 0),
    0,
  ));
  return {
    ...reportBase("GeneralLedger", "ACCRUAL", end, start),
    Columns: {
      Column: [
        { ColTitle: "Date", ColType: "Date" },
        { ColTitle: "Account", ColType: "String" },
        { ColTitle: "Transaction Type", ColType: "String" },
        { ColTitle: "Transaction ID", ColType: "String" },
        { ColTitle: "Memo", ColType: "String" },
        { ColTitle: "Debit", ColType: "Money" },
        { ColTitle: "Credit", ColType: "Money" },
        { ColTitle: "Running Account Balance", ColType: "Money" },
      ],
    },
    Rows: { Row: rows },
    totals: { debitTotal, creditTotal },
    metadata: {
      maxRows,
      availableRows,
      returnedRows: rows.length,
      truncated: availableRows > rows.length,
      ordering: "transactionDate, postingId",
    },
  };
}

function agingReport(
  dataset: FinancialDataset,
  request: ReportRequest,
  kind: "receivable" | "payable",
): QboStyleReport {
  if (request.startDate !== undefined) {
    throw new Error(`${kind === "receivable" ? "AgedReceivables" : "AgedPayables"} accepts endDate only`);
  }
  const end = request.endDate === undefined
    ? dataset.metadata.endDate
    : dateWithinDataset(dataset, request.endDate, "endDate");
  const entityById = new Map(dataset.entities.map((entity) => [entity.Id, entity]));
  const source = dataset.entities.filter(
    (entity): entity is QboInvoice | QboBill =>
      kind === "receivable" ? entity.entityType === "Invoice" : entity.entityType === "Bill",
  );
  const buckets = ["Current", "1-30", "31-60", "61-90", "91+"] as const;
  const totals = new Map<string, number>(buckets.map((bucket) => [bucket, 0]));
  const rows: ReportRow[] = [];
  for (const entity of source) {
    if (entity.TxnDate > end) continue;
    const paid = entity.LinkedTxn
      .map((link) => entityById.get(link.TxnId))
      .filter((linked) =>
        linked !== undefined
        && linked.TxnDate <= end
        && (kind === "receivable"
          ? linked.entityType === "Payment"
          : linked.entityType === "BillPayment"),
      )
      .reduce((sum, linked) => sum + (linked?.TotalAmt ?? 0), 0);
    const outstanding = roundMoney(Math.max(0, entity.TotalAmt - paid));
    if (outstanding === 0) continue;
    const age = daysBetween(entity.DueDate, end);
    const bucket = age <= 0
      ? "Current"
      : age <= 30
        ? "1-30"
        : age <= 60
          ? "31-60"
          : age <= 90
            ? "61-90"
            : "91+";
    totals.set(bucket, roundMoney((totals.get(bucket) ?? 0) + outstanding));
    const reference = entity.entityType === "Invoice" ? entity.CustomerRef : entity.VendorRef;
    rows.push({
      type: "Data",
      ColData: [
        { value: reference.name ?? reference.value },
        { value: entity.DocNumber },
        { value: entity.TxnDate },
        { value: entity.DueDate },
        { value: bucket },
        { value: outstanding },
      ],
    });
  }
  const compactTotals = Object.fromEntries(
    buckets.map((bucket) => [bucket, totals.get(bucket) ?? 0]),
  ) as Record<string, number>;
  compactTotals.total = roundMoney(Object.values(compactTotals).reduce((sum, value) => sum + value, 0));
  const name = kind === "receivable" ? "AgedReceivables" : "AgedPayables";
  return {
    ...reportBase(name, "ACCRUAL", end),
    Columns: {
      Column: [
        { ColTitle: kind === "receivable" ? "Customer" : "Vendor", ColType: "String" },
        { ColTitle: "Document", ColType: "String" },
        { ColTitle: "Transaction Date", ColType: "Date" },
        { ColTitle: "Due Date", ColType: "Date" },
        { ColTitle: "Aging Bucket", ColType: "String" },
        { ColTitle: "Open Balance", ColType: "Money" },
      ],
    },
    Rows: { Row: rows },
    totals: compactTotals,
    metadata: {
      asOfDate: end,
      openItemCount: rows.length,
      historicalMethod: "Original amount less linked settlements dated on or before the report date.",
    },
  };
}

function postingAmounts(
  dataset: FinancialDataset,
  start: IsoDate,
  end: IsoDate,
  classifications: Array<"Revenue" | "Expense">,
): AmountByAccount {
  const accounts = new Map(dataset.accounts.map((account) => [account.Id, account]));
  const result: AmountByAccount = new Map();
  dataset.postings.forEach((posting) => {
    if (posting.transactionDate < start || posting.transactionDate > end) return;
    const account = accounts.get(posting.accountId);
    if (account === undefined || !classifications.includes(account.Classification as "Revenue" | "Expense")) return;
    const value = account.Classification === "Revenue"
      ? (posting.side === "Credit" ? posting.amount : -posting.amount)
      : (posting.side === "Debit" ? posting.amount : -posting.amount);
    result.set(account.Id, roundMoney((result.get(account.Id) ?? 0) + value));
  });
  return result;
}

function balancesThrough(dataset: FinancialDataset, end: IsoDate): AmountByAccount {
  return balancesForPostings(
    dataset,
    dataset.postings.filter((posting) => posting.transactionDate <= end),
  );
}

function balancesBefore(dataset: FinancialDataset, start: IsoDate): AmountByAccount {
  return balancesForPostings(
    dataset,
    dataset.postings.filter((posting) => posting.transactionDate < start),
  );
}

function balancesForPostings(
  dataset: FinancialDataset,
  postings: PostingRecord[],
): AmountByAccount {
  const accountById = new Map(dataset.accounts.map((account) => [account.Id, account]));
  const result: AmountByAccount = new Map();
  postings.forEach((posting) => {
    const account = accountById.get(posting.accountId);
    if (account === undefined) return;
    const normalDebit = account.Classification === "Asset" || account.Classification === "Expense";
    const value = normalDebit
      ? (posting.side === "Debit" ? posting.amount : -posting.amount)
      : (posting.side === "Credit" ? posting.amount : -posting.amount);
    result.set(posting.accountId, roundMoney((result.get(posting.accountId) ?? 0) + value));
  });
  return result;
}

function accountRows(
  dataset: FinancialDataset,
  amounts: AmountByAccount,
  predicate: (
    classification: FinancialDataset["accounts"][number]["Classification"],
    type: FinancialDataset["accounts"][number]["AccountType"],
  ) => boolean,
): ReportRow[] {
  return dataset.accounts
    .filter((account) => predicate(account.Classification, account.AccountType))
    .map((account) => dataRow(account.Name, amounts.get(account.Id) ?? 0))
    .filter((row) => Number(row.ColData?.[1]?.value ?? 0) !== 0);
}

function moneyColumns(firstTitle: string): { Column: ReportColumn[] } {
  return {
    Column: [
      { ColTitle: firstTitle, ColType: "String" },
      { ColTitle: "Amount", ColType: "Money" },
    ],
  };
}

function dataRow(label: string, amount: number): ReportRow {
  return { type: "Data", ColData: [{ value: label }, { value: roundMoney(amount) }] };
}

function summaryRow(label: string, amount: number): ReportRow {
  return { type: "Summary", ColData: [{ value: label }, { value: roundMoney(amount) }] };
}

function section(label: string, rows: ReportRow[], total: number): ReportRow {
  return {
    type: "Section",
    group: label,
    Rows: { Row: rows },
    Summary: { ColData: [{ value: `Total ${label}` }, { value: roundMoney(total) }] },
  };
}

function rowTotal(rows: ReportRow[]): number {
  return roundMoney(rows.reduce(
    (sum, row) => sum + Number(row.ColData?.[1]?.value ?? 0),
    0,
  ));
}

function groupPostings(postings: PostingRecord[]): Map<string, PostingRecord[]> {
  const result = new Map<string, PostingRecord[]>();
  postings.forEach((posting) => {
    const group = result.get(posting.transactionId) ?? [];
    group.push(posting);
    result.set(posting.transactionId, group);
  });
  return result;
}
