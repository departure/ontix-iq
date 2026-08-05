export type IsoDate = `${number}-${number}-${number}`;
export type Money = number;

export type AccountType =
  | "Bank"
  | "Accounts Receivable"
  | "Other Current Asset"
  | "Fixed Asset"
  | "Accounts Payable"
  | "Credit Card"
  | "Other Current Liability"
  | "Equity"
  | "Income"
  | "Cost of Goods Sold"
  | "Expense"
  | "Other Income"
  | "Other Expense";

export type EntityType =
  | "Invoice"
  | "Payment"
  | "Bill"
  | "BillPayment"
  | "Purchase"
  | "JournalEntry";

export type PostingSide = "Debit" | "Credit";

export type QboReference = {
  value: string;
  name?: string;
};

export type QboLinkedTransaction = {
  TxnId: string;
  TxnType: EntityType;
};

export type QboAccount = {
  Id: string;
  SyncToken: string;
  MetaData: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
  Name: string;
  FullyQualifiedName: string;
  Active: boolean;
  Classification: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
  AccountType: AccountType;
  AccountSubType: string;
  CurrentBalance: Money;
  CurrencyRef: QboReference;
  sparse: false;
};

export type QboCustomer = {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  FullyQualifiedName: string;
  CompanyName: string;
  Active: boolean;
  Taxable: boolean;
  Balance: Money;
  CurrencyRef: QboReference;
  sparse: false;
};

export type QboVendor = {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  CompanyName: string;
  Active: boolean;
  Balance: Money;
  CurrencyRef: QboReference;
  Vendor1099: boolean;
  sparse: false;
};

export type QboItem = {
  Id: string;
  SyncToken: string;
  Name: string;
  FullyQualifiedName: string;
  Active: boolean;
  Type: "Service";
  IncomeAccountRef: QboReference;
  Taxable: boolean;
  UnitPrice: Money;
  sparse: false;
};

export type QboSalesItemLine = {
  Id: string;
  LineNum: number;
  Amount: Money;
  DetailType: "SalesItemLineDetail";
  Description: string;
  SalesItemLineDetail: {
    ItemRef: QboReference;
    Qty: number;
    UnitPrice: Money;
    TaxCodeRef: QboReference;
    ServiceDate: IsoDate;
  };
};

export type QboAccountBasedExpenseLine = {
  Id: string;
  LineNum: number;
  Amount: Money;
  DetailType: "AccountBasedExpenseLineDetail";
  Description: string;
  AccountBasedExpenseLineDetail: {
    AccountRef: QboReference;
    BillableStatus: "NotBillable" | "Billable";
    CustomerRef?: QboReference;
    TaxCodeRef: QboReference;
  };
};

export type QboJournalEntryLine = {
  Id: string;
  LineNum: number;
  Amount: Money;
  DetailType: "JournalEntryLineDetail";
  Description: string;
  JournalEntryLineDetail: {
    PostingType: PostingSide;
    AccountRef: QboReference;
    Entity?: {
      EntityRef: QboReference;
      Type: "Customer" | "Vendor" | "Employee";
    };
  };
};

export type QboTransactionBase = {
  Id: string;
  SyncToken: string;
  TxnDate: IsoDate;
  DocNumber: string;
  PrivateNote: string;
  CurrencyRef: QboReference;
  ExchangeRate: 1;
  MetaData: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
  sparse: false;
};

export type QboInvoice = QboTransactionBase & {
  entityType: "Invoice";
  CustomerRef: QboReference;
  DueDate: IsoDate;
  Line: QboSalesItemLine[];
  TotalAmt: Money;
  Balance: Money;
  LinkedTxn: QboLinkedTransaction[];
  SalesTermRef: QboReference;
  ARAccountRef: QboReference;
};

export type QboPayment = QboTransactionBase & {
  entityType: "Payment";
  CustomerRef: QboReference;
  TotalAmt: Money;
  UnappliedAmt: Money;
  DepositToAccountRef: QboReference;
  PaymentMethodRef: QboReference;
  Line: Array<{
    Amount: Money;
    LinkedTxn: QboLinkedTransaction[];
  }>;
};

export type QboBill = QboTransactionBase & {
  entityType: "Bill";
  VendorRef: QboReference;
  DueDate: IsoDate;
  Line: QboAccountBasedExpenseLine[];
  TotalAmt: Money;
  Balance: Money;
  LinkedTxn: QboLinkedTransaction[];
  APAccountRef: QboReference;
  SalesTermRef: QboReference;
};

export type QboPurchase = QboTransactionBase & {
  entityType: "Purchase";
  PaymentType: "Cash" | "Check" | "CreditCard";
  AccountRef: QboReference;
  EntityRef?: {
    type: "Vendor";
    value: string;
    name: string;
  };
  Line: QboAccountBasedExpenseLine[];
  TotalAmt: Money;
  LinkedTxn: QboLinkedTransaction[];
};

export type QboBillPayment = QboTransactionBase & {
  entityType: "BillPayment";
  PayType: "Check";
  VendorRef: QboReference;
  APAccountRef: QboReference;
  CheckPayment: {
    BankAccountRef: QboReference;
  };
  TotalAmt: Money;
  Line: Array<{
    Amount: Money;
    LinkedTxn: QboLinkedTransaction[];
  }>;
};

export type QboJournalEntry = QboTransactionBase & {
  entityType: "JournalEntry";
  Adjustment: boolean;
  Line: QboJournalEntryLine[];
  TotalAmt: Money;
};

export type QboEntity =
  | QboInvoice
  | QboPayment
  | QboBill
  | QboBillPayment
  | QboPurchase
  | QboJournalEntry;

export type PostingRecord = {
  id: string;
  transactionId: string;
  transactionType: EntityType;
  transactionDate: IsoDate;
  accountId: string;
  accountName: string;
  side: PostingSide;
  amount: Money;
  memo: string;
  customerId?: string;
  vendorId?: string;
  sourceLineId?: string;
};

export type DatasetMetadata = {
  name: string;
  description: string;
  seed: number;
  startDate: IsoDate;
  endDate: IsoDate;
  generatedAt: string;
  currency: "USD";
  openingCash: Money;
  arMultiplier: number;
  arMultiplierRationale: string;
  minimumCashReserveTarget: Money;
  minimumObservedCash: Money;
  endingCash: Money;
  transactionCount: number;
  postingCount: number;
  completeMonthPostingCounts: Record<string, number>;
};

export type FinancialDataset = {
  metadata: DatasetMetadata;
  accounts: QboAccount[];
  customers: QboCustomer[];
  vendors: QboVendor[];
  items: QboItem[];
  entities: QboEntity[];
  postings: PostingRecord[];
};

export type DateRange = {
  start?: IsoDate;
  end?: IsoDate;
};

export type EntityQuery = DateRange & {
  types?: EntityType[];
  customerIds?: string[];
  vendorIds?: string[];
};

export type PostingQuery = DateRange & {
  accountIds?: string[];
  transactionTypes?: EntityType[];
  customerIds?: string[];
  vendorIds?: string[];
};

export type AccountBalance = {
  accountId: string;
  accountName: string;
  debit: Money;
  credit: Money;
  netDebit: Money;
};

export type MonthlyFinancialSummary = {
  month: string;
  revenue: Money;
  expenses: Money;
  netIncome: Money;
  cashChange: Money;
  postingCount: number;
};

export type DatasetValidation = {
  valid: boolean;
  errors: string[];
  unbalancedTransactionIds: string[];
};
