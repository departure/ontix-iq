export function dateRangeBoundsInTimeZone(
  from: string,
  through: string,
  timeZone: string,
): { start: Date; end: Date } {
  const fromParts = parseCalendarDate(from);
  const throughParts = parseCalendarDate(through);
  const fromOrdinal = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const throughOrdinal = Date.UTC(throughParts.year, throughParts.month - 1, throughParts.day);
  if (fromOrdinal > throughOrdinal) throw new Error("Period start date must not follow its end date");
  const dayAfterThrough = new Date(throughOrdinal + 86_400_000).toISOString().slice(0, 10);
  return {
    start: startOfDateInTimeZone(from, timeZone),
    end: startOfDateInTimeZone(dayAfterThrough, timeZone),
  };
}

export function monthBoundsInTimeZone(
  year: number,
  month: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be an integer from 2000 through 2100");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Month must be an integer from 1 through 12");
  }
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return {
    start: startOfDateInTimeZone(start, timeZone),
    end: startOfDateInTimeZone(nextMonth, timeZone),
  };
}

export function yearBoundsInTimeZone(
  year: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be an integer from 2000 through 2100");
  }
  return {
    start: startOfDateInTimeZone(`${year}-01-01`, timeZone),
    end: startOfDateInTimeZone(`${year + 1}-01-01`, timeZone),
  };
}

export function calendarMonthInTimeZone(
  timestamp: string,
  timeZone: string,
): { year: number; month: number } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid task creation time: ${timestamp}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

function startOfDateInTimeZone(date: string, timeZone: string): Date {
  const parsed = parseCalendarDate(date);
  const target = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate = target - (represented - candidate);
  }
  return new Date(candidate);
}

function parseCalendarDate(date: string): { year: number; month: number; day: number } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  return { year, month, day };
}

