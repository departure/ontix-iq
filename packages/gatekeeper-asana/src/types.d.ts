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

/** Read-only, capability-scoped access to DEPARTURE's Asana workspace. */
export interface CustomSession {
  /** Search tasks. Dates are YYYY-MM-DD; at most 100 results are returned. */
  searchTasks(options: { text?: string; startDate?: string; endDate?: string; assigneeGid?: string; completed?: boolean; limit?: number }): Promise<AsanaTaskSummary[]>;
  /** Read one task by GID. */
  getTask(taskGid: string): Promise<AsanaTaskSummary>;
  /** List projects available in the configured workspace. */
  listProjects(limit?: number): Promise<Array<{ gid: string; name: string; archived: boolean }>>;
}
