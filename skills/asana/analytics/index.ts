export type ClientTaskAnalysis = {
  clients: Array<{
    client: string;
    count: number;
    projects: Array<{ gid: string; name: string; count: number }>;
  }>;
  attributedTaskCount: number;
  internalTaskCount: number;
  unclassifiedTaskCount: number;
  unattributedTaskCount: number;
  crossClientTaskCount: number;
};

export function analyzeClientTasks(tasks: Record<string, unknown>[]): ClientTaskAnalysis {
  const projectNames = new Map<string, string>();
  for (const task of tasks) {
    for (const project of taskProjects(task)) projectNames.set(project.gid, project.name);
  }
  const projectClients = new Map<string, { key: string; label: string; classification: string }>();
  for (const [gid, name] of projectNames) {
    projectClients.set(gid, classifyProjectClient(name, [...projectNames.values()]));
  }

  const clientTasks = new Map<string, Set<string>>();
  const clientLabels = new Map<string, string>();
  const clientProjects = new Map<string, Map<string, { name: string; tasks: Set<string> }>>();
  const internalTasks = new Set<string>();
  const unclassifiedTasks = new Set<string>();
  const unattributedTasks = new Set<string>();
  let crossClientTaskCount = 0;

  for (const task of tasks) {
    if (typeof task.gid !== "string") continue;
    const projects = taskProjects(task);
    if (projects.length === 0) {
      unattributedTasks.add(task.gid);
      continue;
    }
    const taskClientKeys = new Set<string>();
    let hasInternalProject = false;
    let hasUnclassifiedProject = false;
    for (const project of projects) {
      const client = projectClients.get(project.gid);
      if (!client) continue;
      if (client.classification === "internal") {
        hasInternalProject = true;
        continue;
      }
      if (client.classification === "unclassified") {
        hasUnclassifiedProject = true;
        continue;
      }
      taskClientKeys.add(client.key);
      clientLabels.set(client.key, client.label);
      const projectMap = clientProjects.get(client.key) ?? new Map();
      const projectEntry = projectMap.get(project.gid) ?? {
        name: project.name,
        tasks: new Set<string>(),
      };
      projectEntry.tasks.add(task.gid);
      projectMap.set(project.gid, projectEntry);
      clientProjects.set(client.key, projectMap);
    }
    if (taskClientKeys.size > 0) {
      if (taskClientKeys.size > 1) crossClientTaskCount += 1;
      for (const key of taskClientKeys) {
        const gids = clientTasks.get(key) ?? new Set<string>();
        gids.add(task.gid);
        clientTasks.set(key, gids);
      }
    } else if (hasUnclassifiedProject) {
      unclassifiedTasks.add(task.gid);
    } else if (hasInternalProject) {
      internalTasks.add(task.gid);
    }
  }

  const clients = [...clientTasks.entries()]
    .map(([key, gids]) => ({
      client: clientLabels.get(key) ?? key,
      count: gids.size,
      projects: [...(clientProjects.get(key)?.entries() ?? [])]
        .map(([gid, project]) => ({ gid, name: project.name, count: project.tasks.size }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => right.count - left.count || left.client.localeCompare(right.client));
  return {
    clients,
    attributedTaskCount: new Set([...clientTasks.values()].flatMap((gids) => [...gids])).size,
    internalTaskCount: internalTasks.size,
    unclassifiedTaskCount: unclassifiedTasks.size,
    unattributedTaskCount: unattributedTasks.size,
    crossClientTaskCount,
  };
}

export function calculateTaskMentionAnalysis(
  totalTaskCount: number,
  matches: Array<{ term: string; tasks: Record<string, unknown>[] }>,
): {
  matchingTaskCount: number;
  percentage: number;
  termCounts: Array<{ term: string; count: number }>;
} {
  if (!Number.isSafeInteger(totalTaskCount) || totalTaskCount < 0) {
    throw new Error("Total task count must be a non-negative integer");
  }
  const allMatches = new Set<string>();
  const termCounts = matches.map(({ term, tasks }) => {
    const termMatches = new Set<string>();
    for (const task of tasks) {
      if (typeof task.gid !== "string") continue;
      termMatches.add(task.gid);
      allMatches.add(task.gid);
    }
    return { term, count: termMatches.size };
  });
  const matchingTaskCount = allMatches.size;
  return {
    matchingTaskCount,
    percentage: totalTaskCount === 0 ? 0 : (matchingTaskCount / totalTaskCount) * 100,
    termCounts,
  };
}

export function calculateMonthlyTaskAverages(
  months: Array<{ year: number; month: number; count: number }>,
): {
  years: Array<{ year: number; monthCount: number; total: number; monthlyAverage: number }>;
  monthCount: number;
  total: number;
  monthlyAverage: number;
} {
  const grouped = new Map<number, { monthCount: number; total: number }>();
  for (const item of months) {
    if (
      !Number.isInteger(item.year) ||
      !Number.isInteger(item.month) ||
      item.month < 1 ||
      item.month > 12 ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0
    ) {
      throw new Error("Monthly task counts require valid years, months, and non-negative totals");
    }
    const year = grouped.get(item.year) ?? { monthCount: 0, total: 0 };
    year.monthCount += 1;
    year.total += item.count;
    grouped.set(item.year, year);
  }
  const years = [...grouped.entries()]
    .map(([year, values]) => ({
      year,
      ...values,
      monthlyAverage: values.monthCount === 0 ? 0 : values.total / values.monthCount,
    }))
    .sort((left, right) => left.year - right.year);
  const total = years.reduce((sum, year) => sum + year.total, 0);
  const monthCount = years.reduce((sum, year) => sum + year.monthCount, 0);
  return {
    years,
    monthCount,
    total,
    monthlyAverage: monthCount === 0 ? 0 : total / monthCount,
  };
}

export function calculateQuarterForecast(
  months: Array<{ year: number; month: number; count: number }>,
): {
  winner: string;
  confidence: "low" | "moderate" | "high";
  margin: number;
  quarters: Array<{
    quarter: string;
    averageShare: number;
    averageCount: number;
    medianCount: number;
    yearsBusiest: number;
  }>;
  history: Array<{
    year: number;
    total: number;
    quarters: Array<{ quarter: string; count: number; share: number }>;
  }>;
} {
  const byYear = new Map<number, number[]>();
  for (const item of months) {
    if (
      !Number.isInteger(item.year) ||
      !Number.isInteger(item.month) ||
      item.month < 1 ||
      item.month > 12 ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0
    ) {
      throw new Error("Quarter forecasts require valid monthly task counts");
    }
    const quarters = byYear.get(item.year) ?? [0, 0, 0, 0];
    quarters[Math.floor((item.month - 1) / 3)] =
      (quarters[Math.floor((item.month - 1) / 3)] ?? 0) + item.count;
    byYear.set(item.year, quarters);
  }
  const history = [...byYear.entries()]
    .map(([year, counts]) => {
      const total = counts.reduce((sum, count) => sum + count, 0);
      return {
        year,
        total,
        quarters: counts.map((count, index) => ({
          quarter: `Q${index + 1}`,
          count,
          share: total === 0 ? 0 : count / total,
        })),
      };
    })
    .filter((year) => year.total > 0)
    .sort((left, right) => left.year - right.year);
  if (history.length === 0) throw new Error("Quarter forecast has no historical tasks");

  const quarters = [0, 1, 2, 3]
    .map((index) => {
      const observations = history.map((year) => year.quarters[index]?.count ?? 0);
      const shares = history.map((year) => year.quarters[index]?.share ?? 0);
      const sorted = [...observations].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const medianCount =
        sorted.length % 2 === 0
          ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
          : (sorted[middle] ?? 0);
      return {
        quarter: `Q${index + 1}`,
        averageShare: shares.reduce((sum, share) => sum + share, 0) / shares.length,
        averageCount:
          observations.reduce((sum, count) => sum + count, 0) / observations.length,
        medianCount,
        yearsBusiest: history.filter((year) => {
          const maximum = Math.max(...year.quarters.map((quarter) => quarter.count));
          return year.quarters[index]?.count === maximum;
        }).length,
      };
    })
    .sort(
      (left, right) =>
        right.averageShare - left.averageShare || left.quarter.localeCompare(right.quarter),
    );
  const margin = (quarters[0]?.averageShare ?? 0) - (quarters[1]?.averageShare ?? 0);
  const winnerConsistency = (quarters[0]?.yearsBusiest ?? 0) / history.length;
  const confidence =
    margin >= 0.08 && winnerConsistency >= 2 / 3
      ? "high"
      : margin >= 0.03 || winnerConsistency >= 2 / 3
        ? "moderate"
        : "low";
  return {
    winner: quarters[0]?.quarter ?? "Q1",
    confidence,
    margin,
    quarters,
    history,
  };
}

export function calculateServiceGrowth(
  services: Array<{
    service: string;
    periods: Array<{ label: string; count: number; monthCount: number }>;
  }>,
): {
  winner: string;
  confidence: "low" | "moderate" | "high";
  services: Array<{
    service: string;
    periods: Array<{
      label: string;
      count: number;
      monthCount: number;
      monthlyRate: number;
    }>;
    changes: Array<{
      from: string;
      to: string;
      percentageChange?: number;
    }>;
    latestGrowth?: number;
  }>;
} {
  if (services.length < 2) throw new Error("Service growth requires at least two services");
  const analyzed = services.map((service) => {
    if (!service.service.trim() || service.periods.length < 2) {
      throw new Error("Each service requires a name and at least two periods");
    }
    const periods = service.periods.map((period) => {
      if (
        !period.label.trim() ||
        !Number.isSafeInteger(period.count) ||
        period.count < 0 ||
        !Number.isInteger(period.monthCount) ||
        period.monthCount < 1
      ) {
        throw new Error("Service growth periods require valid counts and month totals");
      }
      return { ...period, monthlyRate: period.count / period.monthCount };
    });
    const changes = periods.slice(1).map((period, index) => {
      const previous = periods[index];
      return {
        from: previous?.label ?? "",
        to: period.label,
        ...(previous && previous.monthlyRate > 0
          ? {
              percentageChange:
                (period.monthlyRate - previous.monthlyRate) / previous.monthlyRate,
            }
          : {}),
      };
    });
    return {
      service: service.service,
      periods,
      changes,
      latestGrowth: changes.at(-1)?.percentageChange,
    };
  });
  const ranked = [...analyzed].sort(
    (left, right) =>
      (right.latestGrowth ?? Number.NEGATIVE_INFINITY) -
        (left.latestGrowth ?? Number.NEGATIVE_INFINITY) ||
      left.service.localeCompare(right.service),
  );
  const winner = ranked[0]?.service ?? analyzed[0]?.service ?? "";
  const first = ranked[0]?.latestGrowth;
  const second = ranked[1]?.latestGrowth;
  const margin =
    first === undefined || second === undefined ? 0 : Math.abs(first - second);
  const winnerChanges = ranked[0]?.changes
    .map((change) => change.percentageChange)
    .filter((value): value is number => value !== undefined) ?? [];
  const directionConsistent =
    winnerChanges.length > 1 &&
    winnerChanges.every((value) => Math.sign(value) === Math.sign(winnerChanges[0] ?? 0));
  const confidence =
    margin >= 0.25 && directionConsistent
      ? "high"
      : margin >= 0.15 || directionConsistent
        ? "moderate"
        : "low";
  return { winner, confidence, services: analyzed };
}

function taskProjects(task: Record<string, unknown>): Array<{ gid: string; name: string }> {
  const direct = projectRecords(task.projects);
  if (direct.length > 0) return direct;
  return isRecord(task.parent) ? projectRecords(task.parent.projects) : [];
}

function projectRecords(value: unknown): Array<{ gid: string; name: string }> {
  if (!Array.isArray(value)) return [];
  const projects = new Map<string, { gid: string; name: string }>();
  for (const project of value) {
    if (
      isRecord(project) &&
      typeof project.gid === "string" &&
      typeof project.name === "string"
    ) {
      projects.set(project.gid, { gid: project.gid, name: project.name.trim() });
    }
  }
  return [...projects.values()];
}

function classifyProjectClient(
  projectName: string,
  allProjectNames: string[],
): { key: string; label: string; classification: "client" | "internal" | "unclassified" } {
  const name = projectName.trim();
  if (/^(?:ontix|pm templates|resources\s*:)/i.test(name)) {
    return { key: `internal:${name.toLowerCase()}`, label: name, classification: "internal" };
  }
  if (/^RP$/i.test(name)) {
    return { key: "unclassified:rp", label: "RP", classification: "unclassified" };
  }

  const code = name.match(/^([A-Za-z]{2,8})-\d{2,3}(?:-\d{2,3})?\b/)?.[1]?.toUpperCase();
  if (code) {
    const exact = allProjectNames.find(
      (candidate) => candidate.trim().toUpperCase() === code,
    );
    const expanded = allProjectNames.find((candidate) => {
      const firstWord = candidate.trim().split(/\s+/)[0] ?? "";
      return (
        !candidate.match(/^([A-Za-z]{2,8})-\d/) &&
        firstWord.length > code.length &&
        firstWord.toUpperCase().startsWith(code)
      );
    });
    const label = exact?.trim() || expanded?.trim() || code;
    return { key: label.toLowerCase(), label, classification: "client" };
  }

  const label = name
    .replace(/\s+\(internal\)\s*$/i, "")
    .replace(/\s+(?:Pharmacy Solutions\s+)?Website\b.*$/i, "")
    .replace(/\s+Support\b.*$/i, "")
    .trim();
  return { key: label.toLowerCase(), label, classification: "client" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
