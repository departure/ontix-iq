import type {
  AccountBalance,
  AccountType,
  DatasetValidation,
  EntityQuery,
  EntityType,
  FinancialDataset,
  IsoDate,
  Money,
  MonthlyFinancialSummary,
  PostingQuery,
  PostingRecord,
  PostingSide,
  QboAccount,
  QboAccountBasedExpenseLine,
  QboBill,
  QboBillPayment,
  QboCustomer,
  QboEntity,
  QboInvoice,
  QboItem,
  QboJournalEntry,
  QboJournalEntryLine,
  QboPayment,
  QboPurchase,
  QboReference,
  QboSalesItemLine,
  QboVendor,
} from "../types.js";

export const SIMULATION_SEED = 0x51a7c0de;
export const SIMULATION_START: IsoDate = "2023-08-01";
export const SIMULATION_END: IsoDate = "2026-08-04";
export const OPENING_CASH: Money = 500_000;
export const AR_MULTIPLIER = 2.5;
export const MINIMUM_CASH_RESERVE: Money = 250_000;

const USD: QboReference = { value: "USD", name: "United States Dollar" };
const CREATED_AT = "2026-08-04T12:00:00.000-07:00";
const DAY_MS = 86_400_000;

type MutableState = {
  rng: SeededRandom;
  accounts: QboAccount[];
  accountById: Map<string, QboAccount>;
  customers: QboCustomer[];
  customerById: Map<string, QboCustomer>;
  vendors: QboVendor[];
  vendorById: Map<string, QboVendor>;
  items: QboItem[];
  entities: QboEntity[];
  postings: PostingRecord[];
  sequence: number;
  postingSequence: number;
};

type AccountSeed = {
  id: string;
  name: string;
  classification: QboAccount["Classification"];
  type: AccountType;
  subtype: string;
};

type ExpenseLineInput = {
  accountId: string;
  amount: number;
  description: string;
  customerId?: string;
};

type ArSchedule = {
  customerId: string;
  day?: number;
  amount: (month: IsoDate, index: number, rng: SeededRandom) => number;
  include?: (month: IsoDate, index: number, rng: SeededRandom) => boolean;
};

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(0, values.length - 1)];
    if (value === undefined) {
      throw new Error("Cannot pick from an empty collection");
    }
    return value;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.int(0, index);
      const value = result[index];
      const swapValue = result[swapIndex];
      if (value === undefined || swapValue === undefined) {
        throw new Error("Invalid shuffle index");
      }
      result[index] = swapValue;
      result[swapIndex] = value;
    }
    return result;
  }
}

const ACCOUNT_SEEDS: AccountSeed[] = [
  { id: "1", name: "Checking", classification: "Asset", type: "Bank", subtype: "Checking" },
  { id: "2", name: "Accounts Receivable", classification: "Asset", type: "Accounts Receivable", subtype: "AccountsReceivable" },
  { id: "3", name: "Prepaid Expenses", classification: "Asset", type: "Other Current Asset", subtype: "PrepaidExpenses" },
  { id: "10", name: "Accounts Payable", classification: "Liability", type: "Accounts Payable", subtype: "AccountsPayable" },
  { id: "12", name: "Payroll Liabilities", classification: "Liability", type: "Other Current Liability", subtype: "PayrollClearing" },
  { id: "20", name: "Opening Balance Equity", classification: "Equity", type: "Equity", subtype: "OpeningBalanceEquity" },
  { id: "21", name: "Owner Distributions", classification: "Equity", type: "Equity", subtype: "OwnersEquity" },
  { id: "30", name: "Design Services Income", classification: "Revenue", type: "Income", subtype: "ServiceFeeIncome" },
  { id: "31", name: "Strategy Services Income", classification: "Revenue", type: "Income", subtype: "ServiceFeeIncome" },
  { id: "40", name: "Project Costs", classification: "Expense", type: "Cost of Goods Sold", subtype: "SuppliesMaterialsCogs" },
  { id: "41", name: "Payroll Wages", classification: "Expense", type: "Expense", subtype: "PayrollWageExpenses" },
  { id: "42", name: "Payroll Taxes", classification: "Expense", type: "Expense", subtype: "PayrollTaxExpenses" },
  { id: "43", name: "Payroll Processing Fees", classification: "Expense", type: "Expense", subtype: "PayrollProcessingFees" },
  { id: "44", name: "Rent", classification: "Expense", type: "Expense", subtype: "RentOrLeaseOfBuildings" },
  { id: "45", name: "Health Insurance", classification: "Expense", type: "Expense", subtype: "Insurance" },
  { id: "46", name: "Software & Subscriptions", classification: "Expense", type: "Expense", subtype: "DuesAndSubscriptions" },
  { id: "47", name: "Professional Fees", classification: "Expense", type: "Expense", subtype: "LegalProfessionalFees" },
  { id: "48", name: "Travel", classification: "Expense", type: "Expense", subtype: "Travel" },
  { id: "49", name: "Meals", classification: "Expense", type: "Expense", subtype: "MealsAndEntertainment" },
  { id: "50", name: "Office Expenses", classification: "Expense", type: "Expense", subtype: "OfficeGeneralAdministrativeExpenses" },
  { id: "51", name: "Utilities", classification: "Expense", type: "Expense", subtype: "Utilities" },
  { id: "52", name: "Taxes & Licenses", classification: "Expense", type: "Expense", subtype: "TaxesPaid" },
  { id: "53", name: "Employee Reimbursements", classification: "Expense", type: "Expense", subtype: "OtherBusinessExpenses" },
  { id: "54", name: "Miscellaneous", classification: "Expense", type: "Expense", subtype: "OtherMiscellaneousServiceCost" },
];

const CUSTOMER_NAMES = [
  ["c-disd", "Design Institute of San Diego"],
  ["c-xifin", "XiFin, Inc."],
  ["c-resmed", "ResMed, Inc."],
  ["c-ace", "Ace Parking"],
  ["c-ajibio", "Ajibio-Pharma"],
  ["c-anders", "Anders CPA"],
  ["c-bd", "Beckton Dickenson"],
  ["c-certis", "Certis Oncology"],
  ["c-clic", "CLiC/Cardinal Glass"],
  ["c-exit", "Exit Consulting Group"],
  ["c-gchem", "gChem/Gaylord Chemical"],
  ["c-ingenium", "Ingenium"],
  ["c-macroair", "MacroAir Fans"],
  ["c-mission", "Mission Healthcare"],
  ["c-quorum", "Quorum"],
  ["c-sdpf", "San Diego Police Foundation"],
  ["c-silvia", "Silvia McColl"],
  ["c-svc", "Schor Vogelzang + Chung"],
] as const;

const VENDOR_NAMES = [
  ["v-avison", "Avison Young"],
  ["v-adp", "ADP"],
  ["v-healthnet", "HealthNet"],
  ["v-google", "Google"],
  ["v-aws", "Amazon Web Services"],
  ["v-slack", "Slack"],
  ["v-notion", "Notion"],
  ["v-cpa", "Kathy Ambrose CPA"],
  ["v-legal", "Dewey Cheatham & Howe"],
  ["v-konica", "KONICA MINOLTA"],
  ["v-att", "AT&T"],
  ["v-stock", "Stock Photography Marketplace"],
  ["v-restaurant", "Local Restaurants"],
  ["v-travel", "Travel Providers"],
  ["v-reimburse", "Employee Reimbursements"],
  ["v-misc", "Miscellaneous Vendors"],
  ["v-city", "City of San Diego"],
  ["v-taxman", "San Diego Taxman"],
  ["v-sketch", "Sketch"],
  ["v-zeplin", "Zeplin"],
  ["v-microsoft", "Microsoft"],
  ["v-zoom", "Zoom"],
  ["v-openart", "OpenArt"],
  ["v-figma", "Figma"],
  ["v-1password", "1Password"],
  ["v-mailtrap", "Mailtrap"],
  ["v-adobe", "Adobe"],
  ["v-dropbox", "Dropbox"],
] as const;

const EMPLOYEES = [
  "Kelly Henning",
  "Bruno Correia",
  "Art Bradshaw",
  "Daniel Nguyen",
  "Robert Palmer",
  "Alex Morgan",
  "Jordan Lee",
  "Casey Smith",
  "Taylor Brooks",
  "Morgan Davis",
] as const;

const REIMBURSEMENT_EMPLOYEES = EMPLOYEES.slice(0, 5);
const TRAVEL_CITIES = [
  "St. Louis, MO",
  "Purchase, NY",
  "Bentonville, AR",
  "Neosho, MO",
  "Franklin Lakes, NJ",
  "Allentown, PA",
] as const;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function asIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

function parseDate(value: IsoDate): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function addDays(value: IsoDate, days: number): IsoDate {
  return asIsoDate(new Date(parseDate(value).getTime() + days * DAY_MS));
}

function dateAt(month: IsoDate, day: number): IsoDate {
  const [year, monthNumber] = month.split("-").map(Number);
  if (year === undefined || monthNumber === undefined) {
    throw new Error(`Invalid month: ${month}`);
  }
  return asIsoDate(new Date(Date.UTC(year, monthNumber - 1, day, 12)));
}

function monthStarts(start: IsoDate, end: IsoDate): IsoDate[] {
  const result: IsoDate[] = [];
  const cursor = parseDate(start);
  cursor.setUTCDate(1);
  while (asIsoDate(cursor) <= end) {
    result.push(asIsoDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

function qboMetadata(date: IsoDate): QboEntity["MetaData"] {
  return {
    CreateTime: `${date}T09:00:00.000-07:00`,
    LastUpdatedTime: `${date}T09:00:00.000-07:00`,
  };
}

function reference(id: string, name: string): QboReference {
  return { value: id, name };
}

function createAccounts(): QboAccount[] {
  return ACCOUNT_SEEDS.map((seed) => ({
    Id: seed.id,
    SyncToken: "0",
    MetaData: { CreateTime: CREATED_AT, LastUpdatedTime: CREATED_AT },
    Name: seed.name,
    FullyQualifiedName: seed.name,
    Active: true,
    Classification: seed.classification,
    AccountType: seed.type,
    AccountSubType: seed.subtype,
    CurrentBalance: 0,
    CurrencyRef: USD,
    sparse: false,
  }));
}

function createCustomers(): QboCustomer[] {
  return CUSTOMER_NAMES.map(([id, name]) => ({
    Id: id,
    SyncToken: "0",
    DisplayName: name,
    FullyQualifiedName: name,
    CompanyName: name,
    Active: true,
    Taxable: false,
    Balance: 0,
    CurrencyRef: USD,
    sparse: false,
  }));
}

function createVendors(): QboVendor[] {
  return VENDOR_NAMES.map(([id, name]) => ({
    Id: id,
    SyncToken: "0",
    DisplayName: name,
    CompanyName: name,
    Active: true,
    Balance: 0,
    CurrencyRef: USD,
    Vendor1099: id === "v-cpa" || id === "v-legal",
    sparse: false,
  }));
}

function createItems(accounts: QboAccount[]): QboItem[] {
  const accountById = new Map(accounts.map((account) => [account.Id, account]));
  return ([
    ["item-30", "Design services", "30"],
    ["item-31", "Strategy services", "31"],
  ] as const).map(([id, name, accountId]) => {
    const account = accountById.get(accountId);
    if (id === undefined || name === undefined || account === undefined) {
      throw new Error(`Invalid item seed for account ${accountId ?? "unknown"}`);
    }
    return {
      Id: id,
      SyncToken: "0",
      Name: name,
      FullyQualifiedName: name,
      Active: true,
      Type: "Service",
      IncomeAccountRef: reference(account.Id, account.Name),
      Taxable: false,
      UnitPrice: 0,
      sparse: false,
    };
  });
}

function createState(seed: number): MutableState {
  const accounts = createAccounts();
  const customers = createCustomers();
  const vendors = createVendors();
  const items = createItems(accounts);
  return {
    rng: new SeededRandom(seed),
    accounts,
    accountById: new Map(accounts.map((account) => [account.Id, account])),
    customers,
    customerById: new Map(customers.map((customer) => [customer.Id, customer])),
    vendors,
    vendorById: new Map(vendors.map((vendor) => [vendor.Id, vendor])),
    items,
    entities: [],
    postings: [],
    sequence: 1,
    postingSequence: 1,
  };
}

function requireAccount(state: MutableState, accountId: string): QboAccount {
  const account = state.accountById.get(accountId);
  if (account === undefined) {
    throw new Error(`Unknown account ${accountId}`);
  }
  return account;
}

function requireCustomer(state: MutableState, customerId: string): QboCustomer {
  const customer = state.customerById.get(customerId);
  if (customer === undefined) {
    throw new Error(`Unknown customer ${customerId}`);
  }
  return customer;
}

function requireVendor(state: MutableState, vendorId: string): QboVendor {
  const vendor = state.vendorById.get(vendorId);
  if (vendor === undefined) {
    throw new Error(`Unknown vendor ${vendorId}`);
  }
  return vendor;
}

function nextId(state: MutableState, prefix: string): string {
  const id = `${prefix}-${String(state.sequence).padStart(6, "0")}`;
  state.sequence += 1;
  return id;
}

function addPosting(
  state: MutableState,
  transaction: QboEntity,
  accountId: string,
  side: PostingSide,
  amount: number,
  memo: string,
  dimensions: Pick<PostingRecord, "customerId" | "vendorId" | "sourceLineId"> = {},
): void {
  const account = requireAccount(state, accountId);
  state.postings.push({
    id: `post-${String(state.postingSequence).padStart(7, "0")}`,
    transactionId: transaction.Id,
    transactionType: transaction.entityType,
    transactionDate: transaction.TxnDate,
    accountId,
    accountName: account.Name,
    side,
    amount: roundMoney(amount),
    memo,
    ...dimensions,
  });
  state.postingSequence += 1;
}

function addOpeningBalance(state: MutableState): void {
  const id = nextId(state, "je");
  const amount = OPENING_CASH;
  const lines: QboJournalEntryLine[] = [
    journalLine(state, id, 1, "1", "Debit", amount, "Opening cash"),
    journalLine(state, id, 2, "20", "Credit", amount, "Opening balance equity"),
  ];
  const entity: QboJournalEntry = {
    ...transactionBase(id, SIMULATION_START, "OPENING-2023", "Simulation opening balance"),
    entityType: "JournalEntry",
    Adjustment: true,
    Line: lines,
    TotalAmt: amount,
  };
  state.entities.push(entity);
  addPosting(state, entity, "1", "Debit", amount, "Opening cash", { sourceLineId: lines[0]?.Id });
  addPosting(state, entity, "20", "Credit", amount, "Opening balance equity", { sourceLineId: lines[1]?.Id });
}

function transactionBase(id: string, date: IsoDate, docNumber: string, note: string) {
  return {
    Id: id,
    SyncToken: "0",
    TxnDate: date,
    DocNumber: docNumber,
    PrivateNote: note,
    CurrencyRef: USD,
    ExchangeRate: 1 as const,
    MetaData: qboMetadata(date),
    sparse: false as const,
  };
}

function journalLine(
  state: MutableState,
  transactionId: string,
  lineNumber: number,
  accountId: string,
  side: PostingSide,
  amount: number,
  description: string,
  entity?: QboJournalEntryLine["JournalEntryLineDetail"]["Entity"],
): QboJournalEntryLine {
  const account = requireAccount(state, accountId);
  return {
    Id: `${transactionId}-L${lineNumber}`,
    LineNum: lineNumber,
    Amount: roundMoney(amount),
    DetailType: "JournalEntryLineDetail",
    Description: description,
    JournalEntryLineDetail: {
      PostingType: side,
      AccountRef: reference(account.Id, account.Name),
      ...(entity === undefined ? {} : { Entity: entity }),
    },
  };
}

function addInvoice(
  state: MutableState,
  date: IsoDate,
  customerId: string,
  baseAmount: number,
  memo: string,
): QboInvoice {
  const customer = requireCustomer(state, customerId);
  const id = nextId(state, "inv");
  const total = roundMoney(baseAmount * AR_MULTIPLIER);
  const serviceDefinitions = [
    ["31", 0.12, "Discovery and research"],
    ["31", 0.13, "Brand and content strategy"],
    ["30", 0.18, "UX and information architecture"],
    ["30", 0.20, "Visual design"],
    ["30", 0.15, "Production design"],
    ["31", 0.08, "Project management"],
    ["30", 0.09, "Quality assurance"],
    ["31", 0.05, "Account services"],
  ] as const;
  let allocated = 0;
  const serviceLines: Array<[string, number, string]> = serviceDefinitions.map(
    ([accountId, share, description], index) => {
      const amount = index === serviceDefinitions.length - 1
        ? roundMoney(total - allocated)
        : roundMoney(total * share);
      allocated = roundMoney(allocated + amount);
      return [accountId, amount, description];
    },
  );
  const lines: QboSalesItemLine[] = serviceLines.map(([accountId, amount, description], index) => {
    return {
      Id: `${id}-L${index + 1}`,
      LineNum: index + 1,
      Amount: amount,
      DetailType: "SalesItemLineDetail",
      Description: `${description} — ${memo}`,
      SalesItemLineDetail: {
        ItemRef: reference(`item-${accountId}`, description),
        Qty: 1,
        UnitPrice: amount,
        TaxCodeRef: reference("NON", "Non-Taxable"),
        ServiceDate: date,
      },
    };
  });
  const entity: QboInvoice = {
    ...transactionBase(id, date, `INV-${id.slice(-6)}`, memo),
    entityType: "Invoice",
    CustomerRef: reference(customer.Id, customer.DisplayName),
    DueDate: addDays(date, 30),
    Line: lines,
    TotalAmt: total,
    Balance: total,
    LinkedTxn: [],
    SalesTermRef: reference("net30", "Net 30"),
    ARAccountRef: reference("2", requireAccount(state, "2").Name),
  };
  state.entities.push(entity);
  addPosting(state, entity, "2", "Debit", total, memo, { customerId });
  serviceLines.forEach(([accountId, amount], index) => {
    addPosting(state, entity, accountId, "Credit", amount, memo, {
      customerId,
      sourceLineId: lines[index]?.Id,
    });
  });
  return entity;
}

function addCustomerPayment(state: MutableState, invoice: QboInvoice, date: IsoDate): QboPayment {
  const customer = requireCustomer(state, invoice.CustomerRef.value);
  const id = nextId(state, "pmt");
  const link = { TxnId: invoice.Id, TxnType: "Invoice" as const };
  const entity: QboPayment = {
    ...transactionBase(id, date, `PMT-${id.slice(-6)}`, `Payment for ${invoice.DocNumber}`),
    entityType: "Payment",
    CustomerRef: reference(customer.Id, customer.DisplayName),
    TotalAmt: invoice.TotalAmt,
    UnappliedAmt: 0,
    DepositToAccountRef: reference("1", requireAccount(state, "1").Name),
    PaymentMethodRef: reference("ach", "ACH"),
    Line: [{ Amount: invoice.TotalAmt, LinkedTxn: [link] }],
  };
  invoice.Balance = 0;
  invoice.LinkedTxn.push({ TxnId: entity.Id, TxnType: "Payment" });
  state.entities.push(entity);
  addPosting(state, entity, "1", "Debit", invoice.TotalAmt, entity.PrivateNote, { customerId: customer.Id });
  addPosting(state, entity, "2", "Credit", invoice.TotalAmt, entity.PrivateNote, { customerId: customer.Id });
  return entity;
}

function expenseLine(
  state: MutableState,
  transactionId: string,
  lineNumber: number,
  input: ExpenseLineInput,
): QboAccountBasedExpenseLine {
  const account = requireAccount(state, input.accountId);
  const customer = input.customerId === undefined ? undefined : requireCustomer(state, input.customerId);
  return {
    Id: `${transactionId}-L${lineNumber}`,
    LineNum: lineNumber,
    Amount: roundMoney(input.amount),
    DetailType: "AccountBasedExpenseLineDetail",
    Description: input.description,
    AccountBasedExpenseLineDetail: {
      AccountRef: reference(account.Id, account.Name),
      BillableStatus: customer === undefined ? "NotBillable" : "Billable",
      ...(customer === undefined ? {} : { CustomerRef: reference(customer.Id, customer.DisplayName) }),
      TaxCodeRef: reference("NON", "Non-Taxable"),
    },
  };
}

function addBill(
  state: MutableState,
  date: IsoDate,
  vendorId: string,
  inputs: ExpenseLineInput[],
  memo: string,
  paymentDelay = 10,
): QboBill {
  const vendor = requireVendor(state, vendorId);
  const id = nextId(state, "bill");
  const lines = inputs.map((input, index) => expenseLine(state, id, index + 1, input));
  const total = roundMoney(inputs.reduce((sum, input) => sum + input.amount, 0));
  const entity: QboBill = {
    ...transactionBase(id, date, `BILL-${id.slice(-6)}`, memo),
    entityType: "Bill",
    VendorRef: reference(vendor.Id, vendor.DisplayName),
    DueDate: addDays(date, 30),
    Line: lines,
    TotalAmt: total,
    Balance: total,
    LinkedTxn: [],
    APAccountRef: reference("10", requireAccount(state, "10").Name),
    SalesTermRef: reference("net30", "Net 30"),
  };
  state.entities.push(entity);
  inputs.forEach((input, index) => {
    addPosting(state, entity, input.accountId, "Debit", input.amount, memo, {
      vendorId,
      customerId: input.customerId,
      sourceLineId: lines[index]?.Id,
    });
  });
  addPosting(state, entity, "10", "Credit", total, memo, { vendorId });
  const paymentDate = addDays(date, paymentDelay);
  if (paymentDate <= SIMULATION_END) {
    addBillPayment(state, entity, paymentDate);
  }
  return entity;
}

function addBillPayment(state: MutableState, bill: QboBill, date: IsoDate): QboBillPayment {
  const vendor = requireVendor(state, bill.VendorRef.value);
  const id = nextId(state, "pay");
  const entity: QboBillPayment = {
    ...transactionBase(id, date, `ACH-${id.slice(-6)}`, `Payment for ${bill.DocNumber}`),
    entityType: "BillPayment",
    PayType: "Check",
    VendorRef: reference(vendor.Id, vendor.DisplayName),
    APAccountRef: reference("10", requireAccount(state, "10").Name),
    CheckPayment: {
      BankAccountRef: reference("1", requireAccount(state, "1").Name),
    },
    Line: [{
      Amount: bill.TotalAmt,
      LinkedTxn: [{ TxnId: bill.Id, TxnType: "Bill" }],
    }],
    TotalAmt: bill.TotalAmt,
  };
  bill.Balance = 0;
  bill.LinkedTxn.push({ TxnId: entity.Id, TxnType: "BillPayment" });
  state.entities.push(entity);
  addPosting(state, entity, "10", "Debit", bill.TotalAmt, entity.PrivateNote, { vendorId: vendor.Id });
  addPosting(state, entity, "1", "Credit", bill.TotalAmt, entity.PrivateNote, { vendorId: vendor.Id });
  return entity;
}

function addPurchase(
  state: MutableState,
  date: IsoDate,
  vendorId: string,
  inputs: ExpenseLineInput[],
  memo: string,
  paymentType: QboPurchase["PaymentType"] = "Cash",
): QboPurchase {
  const vendor = requireVendor(state, vendorId);
  const id = nextId(state, "pur");
  const lines = inputs.map((input, index) => expenseLine(state, id, index + 1, input));
  const total = roundMoney(inputs.reduce((sum, input) => sum + input.amount, 0));
  const entity: QboPurchase = {
    ...transactionBase(id, date, `PUR-${id.slice(-6)}`, memo),
    entityType: "Purchase",
    PaymentType: paymentType,
    AccountRef: reference("1", requireAccount(state, "1").Name),
    EntityRef: { type: "Vendor", value: vendor.Id, name: vendor.DisplayName },
    Line: lines,
    TotalAmt: total,
    LinkedTxn: [],
  };
  state.entities.push(entity);
  inputs.forEach((input, index) => {
    addPosting(state, entity, input.accountId, "Debit", input.amount, memo, {
      vendorId,
      customerId: input.customerId,
      sourceLineId: lines[index]?.Id,
    });
  });
  addPosting(state, entity, "1", "Credit", total, memo, { vendorId });
  return entity;
}

function addPayroll(state: MutableState, date: IsoDate, payrollNumber: number): void {
  const id = nextId(state, "je");
  const grossPayroll = 25_000;
  const basePerEmployee = roundMoney(grossPayroll / EMPLOYEES.length);
  const employerTaxAmount = 2_200;
  const employeeWithholding = 5_000;
  const feeAmount = 500;
  const totalExpense = roundMoney(grossPayroll + employerTaxAmount + feeAmount);
  const payrollCash = roundMoney(totalExpense - employeeWithholding);
  const lines: QboJournalEntryLine[] = EMPLOYEES.map((employee, index) =>
    journalLine(state, id, index + 1, "41", "Debit", basePerEmployee, `Biweekly wages — ${employee}`, {
      EntityRef: reference(`employee-${index + 1}`, employee),
      Type: "Employee",
    }),
  );
  lines.push(
    journalLine(state, id, 11, "42", "Debit", employerTaxAmount, "Employer payroll taxes", {
      EntityRef: reference("v-adp", "ADP"),
      Type: "Vendor",
    }),
    journalLine(state, id, 12, "43", "Debit", feeAmount, "ADP processing fee", {
      EntityRef: reference("v-adp", "ADP"),
      Type: "Vendor",
    }),
    journalLine(state, id, 13, "12", "Credit", employeeWithholding, "Employee tax withholding"),
    journalLine(state, id, 14, "1", "Credit", payrollCash, "ADP net payroll and employer-cost withdrawal"),
  );
  const entity: QboJournalEntry = {
    ...transactionBase(id, date, `PAYROLL-${String(payrollNumber).padStart(3, "0")}`, "Biweekly ADP payroll"),
    entityType: "JournalEntry",
    Adjustment: false,
    Line: lines,
    TotalAmt: totalExpense,
  };
  state.entities.push(entity);
  EMPLOYEES.forEach((employee, index) => {
    addPosting(state, entity, "41", "Debit", basePerEmployee, `Wages — ${employee}`, {
      vendorId: "v-adp",
      sourceLineId: lines[index]?.Id,
    });
  });
  addPosting(state, entity, "42", "Debit", employerTaxAmount, "Employer payroll taxes", { vendorId: "v-adp", sourceLineId: lines[10]?.Id });
  addPosting(state, entity, "43", "Debit", feeAmount, "Payroll processing", { vendorId: "v-adp", sourceLineId: lines[11]?.Id });
  addPosting(state, entity, "12", "Credit", employeeWithholding, "Employee tax withholding", { vendorId: "v-adp", sourceLineId: lines[12]?.Id });
  addPosting(state, entity, "1", "Credit", payrollCash, "Net payroll and employer costs", { vendorId: "v-adp", sourceLineId: lines[13]?.Id });

  const remittanceId = nextId(state, "je");
  const remittanceLines = [
    journalLine(state, remittanceId, 1, "12", "Debit", employeeWithholding, "Remit employee tax withholding"),
    journalLine(state, remittanceId, 2, "1", "Credit", employeeWithholding, "ADP tax remittance"),
  ];
  const remittance: QboJournalEntry = {
    ...transactionBase(
      remittanceId,
      date,
      `PAYTAX-${String(payrollNumber).padStart(3, "0")}`,
      "ADP employee tax remittance",
    ),
    entityType: "JournalEntry",
    Adjustment: false,
    Line: remittanceLines,
    TotalAmt: employeeWithholding,
  };
  state.entities.push(remittance);
  addPosting(state, remittance, "12", "Debit", employeeWithholding, remittance.PrivateNote, {
    vendorId: "v-adp",
    sourceLineId: remittanceLines[0]?.Id,
  });
  addPosting(state, remittance, "1", "Credit", employeeWithholding, remittance.PrivateNote, {
    vendorId: "v-adp",
    sourceLineId: remittanceLines[1]?.Id,
  });
}

function addCashWithdrawal(state: MutableState, date: IsoDate): void {
  const id = nextId(state, "je");
  const lines = [
    journalLine(state, id, 1, "21", "Debit", 20_000, "Annual owner cash withdrawal"),
    journalLine(state, id, 2, "1", "Credit", 20_000, "Annual owner cash withdrawal"),
  ];
  const entity: QboJournalEntry = {
    ...transactionBase(id, date, `WITHDRAWAL-${date.slice(0, 4)}`, "Annual cash withdrawal"),
    entityType: "JournalEntry",
    Adjustment: false,
    Line: lines,
    TotalAmt: 20_000,
  };
  state.entities.push(entity);
  addPosting(state, entity, "21", "Debit", 20_000, entity.PrivateNote, { sourceLineId: lines[0]?.Id });
  addPosting(state, entity, "1", "Credit", 20_000, entity.PrivateNote, { sourceLineId: lines[1]?.Id });
}

function randomRange(rng: SeededRandom, min: number, max: number): number {
  return rng.int(min * 100, max * 100) / 100;
}

function recurringArSchedules(): ArSchedule[] {
  return [
    { customerId: "c-disd", amount: (_month, _index, rng) => randomRange(rng, 1_500, 3_500) },
    { customerId: "c-xifin", amount: (_month, _index, rng) => randomRange(rng, 5_500, 12_000) },
    {
      customerId: "c-resmed",
      amount: (_month, index) => Math.max(0, roundMoney(3_000 * (1 - index / 17))),
      include: (_month, index) => index < 17,
    },
    {
      customerId: "c-ace",
      amount: (_month, _index, rng) => randomRange(rng, 75, 300),
      include: (_month, _index, rng) => rng.chance(0.55),
    },
    {
      customerId: "c-ajibio",
      amount: (_month, _index, rng) => randomRange(rng, 150, 1_100),
      include: (_month, _index, rng) => rng.chance(0.62),
    },
    { customerId: "c-anders", amount: (_month, _index, rng) => randomRange(rng, 6_500, 7_500) },
    { customerId: "c-bd", amount: (_month, _index, rng) => randomRange(rng, 6_500, 8_000) },
    {
      customerId: "c-certis",
      amount: (_month, _index, rng) => randomRange(rng, 900, 1_500),
      include: (_month, _index, rng) => rng.chance(0.68),
    },
    { customerId: "c-clic", amount: (_month, _index, rng) => randomRange(rng, 1_100, 3_500) },
    {
      customerId: "c-exit",
      amount: (_month, _index, rng) => randomRange(rng, 900, 1_150),
      include: (month) => month <= "2024-06-01",
    },
    { customerId: "c-gchem", amount: (_month, _index, rng) => randomRange(rng, 1_500, 3_000) },
    {
      customerId: "c-ingenium",
      amount: (_month, _index, rng) => randomRange(rng, 600, 900),
      include: (month) => month < "2026-03-01",
    },
    {
      customerId: "c-macroair",
      amount: (_month, _index, rng) => randomRange(rng, 1_200, 3_000),
      include: (month) => month >= "2025-07-01",
    },
    { customerId: "c-quorum", amount: (_month, _index, rng) => randomRange(rng, 600, 900) },
    { customerId: "c-sdpf", amount: () => 150 },
  ];
}

function addArActivity(state: MutableState, months: IsoDate[]): void {
  const schedules = recurringArSchedules();
  months.forEach((month, monthIndex) => {
    schedules.forEach((schedule, scheduleIndex) => {
      const include = schedule.include?.(month, monthIndex, state.rng) ?? true;
      if (!include) {
        return;
      }
      const baseAmount = schedule.amount(month, monthIndex, state.rng);
      if (baseAmount <= 0) {
        return;
      }
      const invoiceDate = dateAt(month, schedule.day ?? 5 + (scheduleIndex % 8));
      if (invoiceDate < SIMULATION_START || invoiceDate > SIMULATION_END) {
        return;
      }
      const customer = requireCustomer(state, schedule.customerId);
      const invoice = addInvoice(state, invoiceDate, schedule.customerId, baseAmount, `Monthly services — ${customer.DisplayName}`);
      const paymentDate = addDays(invoiceDate, state.rng.int(18, 38));
      if (paymentDate <= SIMULATION_END) {
        addCustomerPayment(state, invoice, paymentDate);
      }
    });
  });

  const specialInvoices: Array<[IsoDate, string, number, string]> = [
    ["2024-04-01", "c-mission", 55_000, "Mission project milestone"],
    ["2024-02-01", "c-silvia", 900, "Silvia McColl annual engagement"],
    ["2025-02-01", "c-silvia", 900, "Silvia McColl annual engagement"],
    ["2024-08-15", "c-svc", 1_150, "Schor Vogelzang + Chung engagement"],
    ["2025-02-15", "c-svc", 1_150, "Schor Vogelzang + Chung engagement"],
  ];
  specialInvoices.forEach(([date, customerId, amount, memo]) => {
    const invoice = addInvoice(state, date, customerId, amount, memo);
    const paymentDate = addDays(date, state.rng.int(20, 35));
    if (paymentDate <= SIMULATION_END) {
      addCustomerPayment(state, invoice, paymentDate);
    }
  });
}

const ANNUAL_SOFTWARE: ReadonlyArray<{
  vendorId: string;
  month: number;
  day: number;
  amount: number;
}> = [
  { vendorId: "v-sketch", month: 1, day: 8, amount: 720 },
  { vendorId: "v-zeplin", month: 2, day: 20, amount: 2_160 },
  { vendorId: "v-microsoft", month: 3, day: 10, amount: 600 },
  { vendorId: "v-zoom", month: 3, day: 31, amount: 170 },
  { vendorId: "v-openart", month: 5, day: 14, amount: 336 },
  { vendorId: "v-figma", month: 6, day: 8, amount: 576 },
  { vendorId: "v-1password", month: 7, day: 15, amount: 864 },
  { vendorId: "v-mailtrap", month: 8, day: 1, amount: 9 },
  { vendorId: "v-adobe", month: 12, day: 23, amount: 5_088 },
  { vendorId: "v-dropbox", month: 12, day: 30, amount: 4_032 },
];

function addMonthlyBills(state: MutableState, month: IsoDate): void {
  const year = Number(month.slice(0, 4));
  const monthlyBills: Array<{
    day: number;
    vendorId: string;
    amount: number;
    accountId: string;
    memo: string;
  }> = [
    { day: 1, vendorId: "v-avison", amount: 3_500, accountId: "44", memo: "Monthly office rent" },
    { day: 1, vendorId: "v-healthnet", amount: 7_000, accountId: "45", memo: "Monthly employee health coverage" },
    { day: 1, vendorId: "v-google", amount: 160, accountId: "46", memo: "Google Workspace monthly subscription" },
    { day: 1, vendorId: "v-aws", amount: randomRange(state.rng, 360, 440), accountId: "46", memo: "AWS monthly cloud services" },
    { day: 5, vendorId: "v-notion", amount: 72, accountId: "46", memo: "Notion monthly subscription" },
    { day: 8, vendorId: "v-cpa", amount: 300, accountId: "47", memo: "Monthly CPA services" },
    { day: 10, vendorId: "v-legal", amount: 400, accountId: "47", memo: "Monthly legal retainer" },
    { day: 12, vendorId: "v-konica", amount: 250, accountId: "50", memo: "Monthly copier lease" },
    { day: 15, vendorId: "v-att", amount: 100, accountId: "51", memo: "Monthly telecommunications" },
    { day: 23, vendorId: "v-slack", amount: randomRange(state.rng, 65, 75), accountId: "46", memo: "Slack monthly subscription" },
  ];
  monthlyBills.forEach((bill) => {
    const date = dateAt(month, bill.day);
    if (date >= SIMULATION_START && date <= SIMULATION_END) {
      addBill(state, date, bill.vendorId, [{ accountId: bill.accountId, amount: bill.amount, description: bill.memo }], bill.memo, state.rng.int(7, 16));
    }
  });

  const monthNumber = Number(month.slice(5, 7));
  if ([3, 6, 9, 12].includes(monthNumber)) {
    const amount = randomRange(state.rng, 500, 1_000);
    const date = dateAt(month, 18);
    if (date <= SIMULATION_END) {
      addBill(state, date, "v-legal", [{ accountId: "47", amount, description: "Quarterly legal project services" }], "Quarterly legal project services", 12);
    }
  }

  ANNUAL_SOFTWARE.forEach((renewal) => {
    if (renewal.month !== monthNumber) {
      return;
    }
    const date = `${year}-${String(renewal.month).padStart(2, "0")}-${String(renewal.day).padStart(2, "0")}` as IsoDate;
    if (date >= SIMULATION_START && date <= SIMULATION_END) {
      const vendor = requireVendor(state, renewal.vendorId);
      addBill(
        state,
        date,
        renewal.vendorId,
        [{ accountId: "46", amount: renewal.amount, description: `${vendor.DisplayName} annual renewal` }],
        `${vendor.DisplayName} annual renewal`,
        state.rng.int(5, 12),
      );
    }
  });
}

function addEmployeeExpenses(state: MutableState, month: IsoDate): void {
  REIMBURSEMENT_EMPLOYEES.forEach((employee, index) => {
    if (!state.rng.chance(0.72)) {
      return;
    }
    const amount = randomRange(state.rng, 20, 100);
    const date = dateAt(month, 6 + index * 3);
    if (date <= SIMULATION_END) {
      addPurchase(
        state,
        date,
        "v-reimburse",
        [{ accountId: "53", amount, description: `${employee} monthly expense reimbursement` }],
        `Employee expense — ${employee}`,
        "Check",
      );
    }
  });
}

function addStockAndProjectCosts(state: MutableState, month: IsoDate): void {
  const stockDate = dateAt(month, 9);
  if (stockDate <= SIMULATION_END) {
    addPurchase(
      state,
      stockDate,
      "v-stock",
      [{ accountId: "40", amount: randomRange(state.rng, 50, 100), description: "Monthly stock photography license" }],
      "Stock photography",
    );
  }
  const eligibleCustomers = CUSTOMER_NAMES.filter(([id]) => !["c-mission", "c-silvia", "c-svc"].includes(id));
  const count = state.rng.int(2, 3);
  state.rng.shuffle(eligibleCustomers).slice(0, count).forEach(([customerId, customerName], index) => {
    const date = dateAt(month, 13 + index * 4);
    if (date <= SIMULATION_END) {
      addPurchase(
        state,
        date,
        "v-stock",
        [{
          accountId: "40",
          amount: randomRange(state.rng, 50, 100),
          description: `Project asset for ${customerName}`,
          customerId,
        }],
        `Customer-tied project cost — ${customerName}`,
      );
    }
  });
}

function addRestaurants(state: MutableState, month: IsoDate): void {
  const count = state.rng.int(5, 10);
  const totalCents = state.rng.int(27_500, 32_500);
  const weights = Array.from({ length: count }, () => state.rng.int(1, 10));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let allocated = 0;
  weights.forEach((weight, index) => {
    const isLast = index === weights.length - 1;
    const cents = isLast ? totalCents - allocated : Math.round((totalCents * weight) / weightTotal);
    allocated += cents;
    const date = dateAt(month, 3 + Math.floor((index * 24) / count));
    if (date <= SIMULATION_END) {
      addPurchase(
        state,
        date,
        "v-restaurant",
        [{ accountId: "49", amount: cents / 100, description: "Team or client meal" }],
        "Restaurant purchase",
      );
    }
  });
}

function addMiscellaneous(state: MutableState, month: IsoDate): void {
  const total = randomRange(state.rng, 40, 300);
  const count = state.rng.int(1, 3);
  let remaining = total;
  for (let index = 0; index < count; index += 1) {
    const amount = index === count - 1 ? remaining : roundMoney(remaining * randomRange(state.rng, 0.3, 0.65));
    remaining = roundMoney(remaining - amount);
    const date = dateAt(month, 7 + index * 8);
    if (date <= SIMULATION_END) {
      addPurchase(
        state,
        date,
        "v-misc",
        [{ accountId: "54", amount, description: "Incidental business expense" }],
        "Miscellaneous business expense",
      );
    }
  }
}

function addTravel(state: MutableState, months: IsoDate[]): void {
  const years = [...new Set(months.map((month) => Number(month.slice(0, 4))))];
  years.forEach((year) => {
    const availableMonths = months.filter((month) => Number(month.slice(0, 4)) === year);
    const tripCount = year === 2026 ? 4 : state.rng.int(6, 7);
    const tripMonths = state.rng.shuffle(availableMonths).slice(0, Math.min(tripCount, availableMonths.length));
    const cities = state.rng.shuffle(TRAVEL_CITIES);
    tripMonths.forEach((month, index) => {
      const date = dateAt(month, 11);
      if (date > SIMULATION_END) {
        return;
      }
      const city = cities[index % cities.length] ?? "St. Louis, MO";
      const people = state.rng.int(1, 2);
      const days = state.rng.int(2, 3);
      addPurchase(
        state,
        date,
        "v-travel",
        [
          { accountId: "48", amount: roundMoney(randomRange(state.rng, 350, 650) * people), description: `${city} airfare for ${people}` },
          { accountId: "48", amount: roundMoney(randomRange(state.rng, 180, 280) * people * (days - 1)), description: `${city} hotel, ${days - 1} nights` },
          { accountId: "48", amount: roundMoney(randomRange(state.rng, 45, 75) * people * days), description: `${city} travel meals, ${days} days` },
        ],
        `Business trip to ${city} for ${people} employee${people === 1 ? "" : "s"}, ${days} days`,
      );
    });
  });
}

function addTaxesAndWithdrawals(state: MutableState, months: IsoDate[]): void {
  const years = [...new Set(months.map((month) => Number(month.slice(0, 4))))];
  years.forEach((year) => {
    const withdrawalDate = `${year}-12-15` as IsoDate;
    if (withdrawalDate >= SIMULATION_START && withdrawalDate <= SIMULATION_END) {
      addCashWithdrawal(state, withdrawalDate);
    }
    const businessTaxDate = `${year}-09-01` as IsoDate;
    if (businessTaxDate >= SIMULATION_START && businessTaxDate <= SIMULATION_END) {
      addBill(state, businessTaxDate, "v-city", [{ accountId: "52", amount: 48, description: "San Diego annual business tax" }], "San Diego business tax", 5);
    }
    const taxmanDate = `${year}-03-01` as IsoDate;
    if (taxmanDate >= SIMULATION_START && taxmanDate <= SIMULATION_END) {
      addBill(state, taxmanDate, "v-taxman", [{ accountId: "52", amount: 1_200, description: "Annual tax preparation" }], "San Diego Taxman annual fee", 10);
    }
  });
}

function addPayrollActivity(state: MutableState): void {
  let date: IsoDate = "2023-08-04";
  let payrollNumber = 1;
  while (date <= SIMULATION_END) {
    addPayroll(state, date, payrollNumber);
    date = addDays(date, 14);
    payrollNumber += 1;
  }
}

function updateBalances(state: MutableState): void {
  state.accounts.forEach((account) => {
    const postings = state.postings.filter((posting) => posting.accountId === account.Id);
    const debit = postings.filter((posting) => posting.side === "Debit").reduce((sum, posting) => sum + posting.amount, 0);
    const credit = postings.filter((posting) => posting.side === "Credit").reduce((sum, posting) => sum + posting.amount, 0);
    const debitNormal = account.Classification === "Asset" || account.Classification === "Expense";
    account.CurrentBalance = roundMoney(debitNormal ? debit - credit : credit - debit);
  });
  state.customers.forEach((customer) => {
    customer.Balance = roundMoney(
      state.entities
        .filter((entity): entity is QboInvoice => entity.entityType === "Invoice" && entity.CustomerRef.value === customer.Id)
        .reduce((sum, invoice) => sum + invoice.Balance, 0),
    );
  });
  state.vendors.forEach((vendor) => {
    vendor.Balance = roundMoney(
      state.entities
        .filter((entity): entity is QboBill => entity.entityType === "Bill" && entity.VendorRef.value === vendor.Id)
        .reduce((sum, bill) => sum + bill.Balance, 0),
    );
  });
}

function cashObservations(postings: PostingRecord[]): { minimum: number; ending: number } {
  let balance = 0;
  let minimum = Number.POSITIVE_INFINITY;
  const cashPostings = postings
    .filter((posting) => posting.accountId === "1")
    .toSorted((left, right) => left.transactionDate.localeCompare(right.transactionDate) || left.id.localeCompare(right.id));
  cashPostings.forEach((posting) => {
    balance = roundMoney(balance + (posting.side === "Debit" ? posting.amount : -posting.amount));
    minimum = Math.min(minimum, balance);
  });
  return { minimum: roundMoney(minimum), ending: roundMoney(balance) };
}

function completeMonthPostingCounts(postings: PostingRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  postings.forEach((posting) => {
    const month = posting.transactionDate.slice(0, 7);
    counts[month] = (counts[month] ?? 0) + 1;
  });
  delete counts["2026-08"];
  return counts;
}

export function generateFinancialDataset(seed = SIMULATION_SEED): FinancialDataset {
  const state = createState(seed);
  const months = monthStarts(SIMULATION_START, SIMULATION_END);
  addOpeningBalance(state);
  addArActivity(state, months);
  months.forEach((month) => {
    addMonthlyBills(state, month);
    addEmployeeExpenses(state, month);
    addStockAndProjectCosts(state, month);
    addRestaurants(state, month);
    addMiscellaneous(state, month);
  });
  addTravel(state, months);
  addTaxesAndWithdrawals(state, months);
  addPayrollActivity(state);
  state.entities.sort((left, right) => left.TxnDate.localeCompare(right.TxnDate) || left.Id.localeCompare(right.Id));
  state.postings.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate) || left.id.localeCompare(right.id));
  updateBalances(state);
  const cash = cashObservations(state.postings);
  const counts = completeMonthPostingCounts(state.postings);
  const dataset: FinancialDataset = {
    metadata: {
      name: "Ontix IQ deterministic QuickBooks simulation",
      description: "Fixed-seed, QBO-shaped accrual ledger with explicit balanced double-entry postings.",
      seed,
      startDate: SIMULATION_START,
      endDate: SIMULATION_END,
      generatedAt: CREATED_AT,
      currency: "USD",
      openingCash: OPENING_CASH,
      arMultiplier: AR_MULTIPLIER,
      arMultiplierRationale: "A single 2.5x factor is applied to every recurring and special AR amount, preserving relative customer values while maintaining the $250,000 cash reserve and at least $500,000 ending cash.",
      minimumCashReserveTarget: MINIMUM_CASH_RESERVE,
      minimumObservedCash: cash.minimum,
      endingCash: cash.ending,
      transactionCount: state.entities.length,
      postingCount: state.postings.length,
      completeMonthPostingCounts: counts,
    },
    accounts: state.accounts,
    customers: state.customers,
    vendors: state.vendors,
    items: state.items,
    entities: state.entities,
    postings: state.postings,
  };
  const validation = validateFinancialDataset(dataset);
  if (!validation.valid) {
    throw new Error(`Generated invalid financial dataset: ${validation.errors.join("; ")}`);
  }
  if (cash.minimum < MINIMUM_CASH_RESERVE || cash.ending < OPENING_CASH) {
    throw new Error(`AR multiplier ${AR_MULTIPLIER} does not meet cash invariants: minimum ${cash.minimum}, ending ${cash.ending}`);
  }
  const sparseMonths = Object.entries(counts).filter(([, count]) => count < 200);
  if (sparseMonths.length > 0) {
    throw new Error(`Complete months require at least 200 posting lines: ${sparseMonths.map(([month, count]) => `${month}=${count}`).join(", ")}`);
  }
  return dataset;
}

export function queryEntities(dataset: FinancialDataset, query: EntityQuery = {}): QboEntity[] {
  return dataset.entities.filter((entity) => {
    if (query.start !== undefined && entity.TxnDate < query.start) return false;
    if (query.end !== undefined && entity.TxnDate > query.end) return false;
    if (query.types !== undefined && !query.types.includes(entity.entityType)) return false;
    if (query.customerIds !== undefined) {
      const customerId = entity.entityType === "Invoice" || entity.entityType === "Payment" ? entity.CustomerRef.value : undefined;
      if (customerId === undefined || !query.customerIds.includes(customerId)) return false;
    }
    if (query.vendorIds !== undefined) {
      const vendorId = entity.entityType === "Bill"
        ? entity.VendorRef.value
        : entity.entityType === "BillPayment"
          ? entity.VendorRef.value
        : entity.entityType === "Purchase"
          ? entity.EntityRef?.value
          : undefined;
      if (vendorId === undefined || !query.vendorIds.includes(vendorId)) return false;
    }
    return true;
  });
}

export function queryPostings(dataset: FinancialDataset, query: PostingQuery = {}): PostingRecord[] {
  return dataset.postings.filter((posting) => {
    if (query.start !== undefined && posting.transactionDate < query.start) return false;
    if (query.end !== undefined && posting.transactionDate > query.end) return false;
    if (query.accountIds !== undefined && !query.accountIds.includes(posting.accountId)) return false;
    if (query.transactionTypes !== undefined && !query.transactionTypes.includes(posting.transactionType)) return false;
    if (query.customerIds !== undefined && (posting.customerId === undefined || !query.customerIds.includes(posting.customerId))) return false;
    if (query.vendorIds !== undefined && (posting.vendorId === undefined || !query.vendorIds.includes(posting.vendorId))) return false;
    return true;
  });
}

export function trialBalance(dataset: FinancialDataset, range: { start?: IsoDate; end?: IsoDate } = {}): AccountBalance[] {
  const postings = queryPostings(dataset, range);
  return dataset.accounts.map((account) => {
    const accountPostings = postings.filter((posting) => posting.accountId === account.Id);
    const debit = roundMoney(accountPostings.filter((posting) => posting.side === "Debit").reduce((sum, posting) => sum + posting.amount, 0));
    const credit = roundMoney(accountPostings.filter((posting) => posting.side === "Credit").reduce((sum, posting) => sum + posting.amount, 0));
    return {
      accountId: account.Id,
      accountName: account.Name,
      debit,
      credit,
      netDebit: roundMoney(debit - credit),
    };
  });
}

export function monthlyFinancialSummaries(dataset: FinancialDataset): MonthlyFinancialSummary[] {
  const months = monthStarts(dataset.metadata.startDate, dataset.metadata.endDate).map((date) => date.slice(0, 7));
  const accountById = new Map(dataset.accounts.map((account) => [account.Id, account]));
  return months.map((month) => {
    const postings = dataset.postings.filter((posting) => posting.transactionDate.startsWith(month));
    let revenue = 0;
    let expenses = 0;
    let cashChange = 0;
    postings.forEach((posting) => {
      const account = accountById.get(posting.accountId);
      if (account?.Classification === "Revenue") {
        revenue += posting.side === "Credit" ? posting.amount : -posting.amount;
      }
      if (account?.Classification === "Expense") {
        expenses += posting.side === "Debit" ? posting.amount : -posting.amount;
      }
      if (posting.accountId === "1") {
        cashChange += posting.side === "Debit" ? posting.amount : -posting.amount;
      }
    });
    return {
      month,
      revenue: roundMoney(revenue),
      expenses: roundMoney(expenses),
      netIncome: roundMoney(revenue - expenses),
      cashChange: roundMoney(cashChange),
      postingCount: postings.length,
    };
  });
}

export function validateFinancialDataset(dataset: FinancialDataset): DatasetValidation {
  const errors: string[] = [];
  const transactionIds = new Set(dataset.entities.map((entity) => entity.Id));
  const postingGroups = new Map<string, PostingRecord[]>();
  dataset.postings.forEach((posting) => {
    if (!transactionIds.has(posting.transactionId)) {
      errors.push(`Posting ${posting.id} refers to missing transaction ${posting.transactionId}`);
    }
    const group = postingGroups.get(posting.transactionId) ?? [];
    group.push(posting);
    postingGroups.set(posting.transactionId, group);
  });
  const unbalancedTransactionIds: string[] = [];
  dataset.entities.forEach((entity) => {
    const postings = postingGroups.get(entity.Id) ?? [];
    if (postings.length < 2) {
      errors.push(`Transaction ${entity.Id} has fewer than two posting lines`);
      return;
    }
    const debits = roundMoney(postings.filter((posting) => posting.side === "Debit").reduce((sum, posting) => sum + posting.amount, 0));
    const credits = roundMoney(postings.filter((posting) => posting.side === "Credit").reduce((sum, posting) => sum + posting.amount, 0));
    if (debits !== credits) {
      unbalancedTransactionIds.push(entity.Id);
      errors.push(`Transaction ${entity.Id} is unbalanced: debits ${debits}, credits ${credits}`);
    }
  });
  const duplicateEntityIds = dataset.entities.length - transactionIds.size;
  if (duplicateEntityIds > 0) {
    errors.push(`${duplicateEntityIds} duplicate transaction IDs`);
  }
  const allowedTypes = new Set<EntityType>([
    "Invoice",
    "Payment",
    "Bill",
    "BillPayment",
    "Purchase",
    "JournalEntry",
  ]);
  dataset.entities.forEach((entity) => {
    if (!allowedTypes.has(entity.entityType)) {
      errors.push(`Unsupported entity type ${(entity as { entityType: string }).entityType}`);
    }
  });
  return { valid: errors.length === 0, errors, unbalancedTransactionIds };
}

export function accountBalance(
  dataset: FinancialDataset,
  accountId: string,
  throughDate: IsoDate = dataset.metadata.endDate,
): Money {
  const account = dataset.accounts.find((candidate) => candidate.Id === accountId);
  if (account === undefined) {
    throw new Error(`Unknown account ${accountId}`);
  }
  const postings = queryPostings(dataset, { accountIds: [accountId], end: throughDate });
  const debit = postings.filter((posting) => posting.side === "Debit").reduce((sum, posting) => sum + posting.amount, 0);
  const credit = postings.filter((posting) => posting.side === "Credit").reduce((sum, posting) => sum + posting.amount, 0);
  return roundMoney(
    account.Classification === "Asset" || account.Classification === "Expense"
      ? debit - credit
      : credit - debit,
  );
}
