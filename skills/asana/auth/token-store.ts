import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

type EncryptedPayload = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class EncryptedTokenStore {
  private readonly tokenPath: string;
  private readonly keyPath: string;

  constructor(
    dataDir: string,
    private readonly configuredKey?: string,
  ) {
    this.tokenPath = join(dataDir, "secrets", "asana-tokens.json");
    this.keyPath = join(dataDir, "secrets", "local-token.key");
  }

  async read(): Promise<OAuthTokens | undefined> {
    try {
      const payload = JSON.parse(await readFile(this.tokenPath, "utf8")) as EncryptedPayload;
      const key = await this.key(false);
      if (!key) return undefined;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(cleartext.toString("utf8")) as OAuthTokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Unable to decrypt stored Asana authorization", { cause: error });
    }
  }

  async write(tokens: OAuthTokens): Promise<void> {
    const key = await this.key(true);
    if (!key) throw new Error("Unable to create token encryption key");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);
    const payload: EncryptedPayload = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(this.tokenPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }

  private async key(create: boolean): Promise<Buffer | undefined> {
    if (this.configuredKey) {
      return createHash("sha256").update(this.configuredKey).digest();
    }
    try {
      return Buffer.from(await readFile(this.keyPath, "utf8"), "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      const key = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      await writeFile(this.keyPath, key.toString("base64"), { mode: 0o600 });
      return key;
    }
  }
}
