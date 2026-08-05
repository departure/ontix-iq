import { describe, expect, it } from "vitest";
import { formatErrorLog } from "./format.js";

describe("formatErrorLog", () => {
  it("adds trusted producer metadata to the bounded event", () => {
    const event = {
      schemaVersion: 1 as const,
      occurrenceId: "occurrence-id",
      occurredAt: "2026-08-04T00:00:00.000Z",
      failureSite: "overseer.run-agent",
      severity: "error" as const,
      handled: false,
      exception: { type: "Error", message: "boom" },
    };

    expect(formatErrorLog({
      service: "cloudflare-os",
      environment: "production",
      release: "abc123",
    }, event)).toEqual({
      event: "error_report",
      service: "cloudflare-os",
      environment: "production",
      release: "abc123",
      ...event,
    });
  });

  it("does not let RPC input replace trusted metadata", () => {
    const event = {
      schemaVersion: 1 as const,
      occurrenceId: "occurrence-id",
      occurredAt: "2026-08-04T00:00:00.000Z",
      failureSite: "site",
      severity: "error" as const,
      handled: false,
      event: "forged",
      service: "forged",
      environment: "forged",
      release: "forged",
    };

    expect(formatErrorLog({
      service: "cloudflare-os",
      environment: "production",
      release: "abc123",
    }, event)).toMatchObject({
      event: "error_report",
      service: "cloudflare-os",
      environment: "production",
      release: "abc123",
    });
  });
});
