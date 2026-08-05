import type { ErrorEventV1, ErrorReporterProps } from "@gadgets/error-reporting";

export function formatErrorLog(props: ErrorReporterProps, report: ErrorEventV1) {
  const event = { ...report } as Record<string, unknown>;
  delete event.event;
  delete event.service;
  delete event.environment;
  delete event.release;
  return { ...event, event: "error_report", ...props } as const;
}
