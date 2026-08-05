export interface DateRange { startDate?: string; endDate?: string }
/** Fixed synthetic QuickBooks capability. Every returned value is simulated, never live accounting data. */
export interface CustomSession {
  getCompanyInfo(): Promise<unknown>;
  analyzeCustomerRevenue(options?: DateRange & { limit?: number }): Promise<unknown>;
  analyzeServiceRevenue(options?: DateRange): Promise<unknown>;
  getProfitAndLoss(options?: DateRange & { accountingMethod?: "ACCRUAL" | "CASH" }): Promise<unknown>;
}
