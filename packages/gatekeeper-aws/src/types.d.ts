/** Least-privilege, read-only AWS account capability. */
export interface CustomSession {
  getIdentity(): Promise<{ account?: string; arn?: string }>;
  getCosts(options: { start: string; end: string; granularity?: "DAILY" | "MONTHLY"; groupByService?: boolean }): Promise<unknown>;
  getCommitmentUtilization(options: { start: string; end: string }): Promise<unknown>;
  getInventory(): Promise<unknown>;
}
