export interface AsanaTaskSummary {
  gid: string;
  name: string;
  completed: boolean;
  createdAt?: string;
  completedAt?: string;
  assignee?: { gid: string; name: string };
  projects: Array<{ gid: string; name: string }>;
  permalinkUrl?: string;
}

export interface AsanaUserSummary {
  gid: string;
  name: string;
  email?: string;
}

/** Read-only, capability-scoped access to DEPARTURE's Asana workspace via Asana MCP. */
export interface CustomSession {
  /**
   * Resolve workspace users by name or email substring (case-insensitive).
   * Use this before assignee-filtered task searches.
   */
  findUsers(query: string): Promise<AsanaUserSummary[]>;
  /**
   * Search tasks. Dates are YYYY-MM-DD.
   * When assigneeGid is set, results are collected exhaustively via get_tasks pagination.
   * When both startDate and endDate are set (without assigneeGid), results are collected by
   * partitioning around MCP's 100-result search page limit (up to a safety ceiling).
   * Otherwise at most 100 results are returned.
   */
  searchTasks(options: {
    text?: string;
    startDate?: string;
    endDate?: string;
    assigneeGid?: string;
    completed?: boolean;
    limit?: number;
  }): Promise<AsanaTaskSummary[]>;
  /** Read one task by GID. */
  getTask(taskGid: string): Promise<AsanaTaskSummary>;
  /** List projects available in the configured workspace. */
  listProjects(limit?: number): Promise<Array<{ gid: string; name: string; archived: boolean }>>;
}
