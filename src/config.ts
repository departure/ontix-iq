import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default("gpt-5.6"),
  ASANA_CLIENT_ID: optionalString,
  ASANA_CLIENT_SECRET: optionalString,
  ASANA_OAUTH_CALLBACK_HOST: z.string().default("127.0.0.1"),
  ASANA_OAUTH_CALLBACK_PORT: z.coerce.number().int().min(1).max(65535).default(3334),
  ASANA_OAUTH_CALLBACK_PATH: z.string().startsWith("/").default("/oauth/callback"),
  AWS_ACCESS_KEY: optionalString,
  AWS_ACCESS_KEY_SECRET: optionalString,
  AWS_REGIONS: z.string().default(""),
  NOTION_ACCESS_TOKEN: optionalString,
  ONTIX_DATA_DIR: z.string().default(".data"),
  ONTIX_ORGANIZATION_ID: z.string().default("departure"),
  ONTIX_USER_ID: z.string().default("art-bradshaw"),
  ONTIX_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(12).default(6),
  ONTIX_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  ONTIX_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(2000).max(200000).default(40000),
  ONTIX_TOKEN_ENCRYPTION_KEY: optionalString,
});

export type AppConfig = {
  environment: "development" | "test" | "production";
  openai: { apiKey?: string; model: string };
  asana: {
    clientId?: string;
    clientSecret?: string;
    callbackUrl: URL;
    serverUrl: URL;
  };
  aws: { accessKeyId?: string; secretAccessKey?: string; regions: string[] };
  notion: { accessToken?: string };
  runtime: {
    dataDir: string;
    organizationId: string;
    userId: string;
    maxToolRounds: number;
    toolTimeoutMs: number;
    maxEvidenceChars: number;
    tokenEncryptionKey?: string;
  };
};

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const callbackUrl = new URL(
    `http://${parsed.ASANA_OAUTH_CALLBACK_HOST}:${parsed.ASANA_OAUTH_CALLBACK_PORT}${parsed.ASANA_OAUTH_CALLBACK_PATH}`,
  );
  return {
    environment: parsed.NODE_ENV,
    openai: {
      ...(parsed.OPENAI_API_KEY ? { apiKey: parsed.OPENAI_API_KEY } : {}),
      model: parsed.OPENAI_MODEL,
    },
    asana: {
      ...(parsed.ASANA_CLIENT_ID ? { clientId: parsed.ASANA_CLIENT_ID } : {}),
      ...(parsed.ASANA_CLIENT_SECRET ? { clientSecret: parsed.ASANA_CLIENT_SECRET } : {}),
      callbackUrl,
      serverUrl: new URL("https://mcp.asana.com/v2/mcp"),
    },
    aws: {
      ...(parsed.AWS_ACCESS_KEY ? { accessKeyId: parsed.AWS_ACCESS_KEY } : {}),
      ...(parsed.AWS_ACCESS_KEY_SECRET ? { secretAccessKey: parsed.AWS_ACCESS_KEY_SECRET } : {}),
      regions: parsed.AWS_REGIONS.split(",").map((value) => value.trim()).filter(Boolean),
    },
    notion: {
      ...(parsed.NOTION_ACCESS_TOKEN ? { accessToken: parsed.NOTION_ACCESS_TOKEN } : {}),
    },
    runtime: {
      dataDir: parsed.ONTIX_DATA_DIR,
      organizationId: parsed.ONTIX_ORGANIZATION_ID,
      userId: parsed.ONTIX_USER_ID,
      maxToolRounds: parsed.ONTIX_MAX_TOOL_ROUNDS,
      toolTimeoutMs: parsed.ONTIX_TOOL_TIMEOUT_MS,
      maxEvidenceChars: parsed.ONTIX_MAX_EVIDENCE_CHARS,
      ...(parsed.ONTIX_TOKEN_ENCRYPTION_KEY
        ? { tokenEncryptionKey: parsed.ONTIX_TOKEN_ENCRYPTION_KEY }
        : {}),
    },
  };
}

export function missingRequiredServices(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.openai.apiKey) missing.push("OPENAI_API_KEY");
  if (!config.asana.clientId) missing.push("ASANA_CLIENT_ID");
  if (!config.asana.clientSecret) missing.push("ASANA_CLIENT_SECRET");
  if (!config.aws.accessKeyId) missing.push("AWS_ACCESS_KEY");
  if (!config.aws.secretAccessKey) missing.push("AWS_ACCESS_KEY_SECRET");
  if (!config.notion.accessToken) missing.push("NOTION_ACCESS_TOKEN");
  return missing;
}
