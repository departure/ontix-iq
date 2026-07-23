import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  decryptJson,
  encryptJson,
  LocalEncryptionKey,
  type EncryptedPayload,
} from "../../../src/storage/encryption.js";

export class EncryptedTokenStore {
  private readonly tokenPath: string;
  private readonly encryptionKey: LocalEncryptionKey;

  constructor(
    dataDir: string,
    configuredKey?: string,
  ) {
    this.tokenPath = join(dataDir, "secrets", "asana-tokens.json");
    this.encryptionKey = new LocalEncryptionKey(dataDir, configuredKey);
  }

  async read(): Promise<OAuthTokens | undefined> {
    const stored = await this.readStored();
    return stored ? tokensFromStored(stored) : undefined;
  }

  async credentialFingerprint(): Promise<string> {
    const stored = await this.readStored();
    if (!stored) return "unauthorized";
    if (isTokenEnvelope(stored)) return stored.credentialFingerprint;
    const credentialFingerprint = randomUUID();
    await this.writeEnvelope(stored, credentialFingerprint);
    return credentialFingerprint;
  }

  async write(tokens: OAuthTokens, preserveCredential = false): Promise<void> {
    const current = preserveCredential ? await this.readStored() : undefined;
    const credentialFingerprint =
      current && isTokenEnvelope(current) ? current.credentialFingerprint : randomUUID();
    await this.writeEnvelope(tokens, credentialFingerprint);
  }

  async clear(): Promise<void> {
    await rm(this.tokenPath, { force: true });
  }

  private async readStored(): Promise<OAuthTokens | TokenEnvelope | undefined> {
    try {
      const payload = JSON.parse(await readFile(this.tokenPath, "utf8")) as EncryptedPayload;
      const key = await this.encryptionKey.get(false);
      if (!key) return undefined;
      return decryptJson(payload, key) as OAuthTokens | TokenEnvelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Unable to decrypt stored Asana authorization", { cause: error });
    }
  }

  private async writeEnvelope(
    tokens: OAuthTokens,
    credentialFingerprint: string,
  ): Promise<void> {
    const key = await this.encryptionKey.get(true);
    if (!key) throw new Error("Unable to create token encryption key");
    const payload = encryptJson(
      { version: 1, credentialFingerprint, tokens } satisfies TokenEnvelope,
      key,
    );
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(this.tokenPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }
}

type TokenEnvelope = {
  version: 1;
  credentialFingerprint: string;
  tokens: OAuthTokens;
};

function isTokenEnvelope(value: OAuthTokens | TokenEnvelope): value is TokenEnvelope {
  return (
    "version" in value &&
    value.version === 1 &&
    "credentialFingerprint" in value &&
    typeof value.credentialFingerprint === "string" &&
    "tokens" in value
  );
}

function tokensFromStored(value: OAuthTokens | TokenEnvelope): OAuthTokens {
  return isTokenEnvelope(value) ? value.tokens : value;
}
