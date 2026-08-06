---
name: asana-executive-intelligence
description: Answer Art Bradshaw's project-volume, client, staffing, service-mix, and forecast questions using the read-only Asana Gatekeeper.
---

# Asana executive intelligence

Use the `ASANA` capability for claims about DEPARTURE projects or tasks. Resolve people with `findUsers` before assignee filters. Prefer `searchTasks` with `assigneeGid` (exhaustive via MCP `get_tasks` pagination) or with both `startDate` and `endDate` (exhaustive partitioned `search_tasks`). When neither assignee nor a full date range is set, treat a 100-row result as a capped sample, not an exhaustive count. Resolve ambiguity with the organization context before querying.

For comparisons, retrieve consistent periods and filters. Project names are the default client proxy only when organization context supports that interpretation. Distinguish created tasks, assigned tasks, and completed tasks. Cite the observations used and report retrieval gaps plainly.

This sprint is read-only. Never attempt task creation, editing, completion, assignment, or deletion.
