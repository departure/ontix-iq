import { describe, expect, it } from "vitest";
import { missingRequiredServices, readConfig } from "../src/config.js";
import { redact, truncate } from "../src/core/security.js";

describe("configuration", () => {
  it("uses portable defaults and reports missing connections", () => {
    const config = readConfig({});
    expect(config.openai.model).toBe("gpt-5.6");
    expect(config.asana.callbackUrl.toString()).toBe(
      "http://127.0.0.1:3334/oauth/callback",
    );
    expect(missingRequiredServices(config)).toEqual([
      "OPENAI_API_KEY",
      "ASANA_CLIENT_ID",
      "ASANA_CLIENT_SECRET",
      "AWS_ACCESS_KEY",
      "AWS_ACCESS_KEY_SECRET",
      "NOTION_ACCESS_TOKEN",
    ]);
  });
});

describe("security helpers", () => {
  it("redacts credentials from text and serialized data", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def");
    expect(redact({ token: "super-secret" })).not.toContain("super-secret");
    expect(redact("AKIA1234567890ABCDEF")).toContain("[REDACTED]");
  });

  it("bounds large provider output", () => {
    expect(truncate("x".repeat(100), 30)).toHaveLength(30);
    expect(truncate("short", 30)).toBe("short");
  });
});
