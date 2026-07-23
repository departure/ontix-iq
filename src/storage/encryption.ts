import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type EncryptedPayload = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class LocalEncryptionKey {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly configuredKey?: string,
  ) {
    this.path = join(dataDir, "secrets", "local-token.key");
  }

  async get(create: boolean): Promise<Buffer | undefined> {
    if (this.configuredKey) {
      return createHash("sha256").update(this.configuredKey).digest();
    }
    try {
      return await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
    }

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      const handle = await open(this.path, "wx", 0o600);
      try {
        await handle.writeFile(key.toString("base64"));
      } finally {
        await handle.close();
      }
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.read();
    }
  }

  private async read(): Promise<Buffer> {
    const key = Buffer.from(await readFile(this.path, "utf8"), "base64");
    if (key.length !== 32) throw new Error("Local encryption key must contain 32 bytes");
    return key;
  }
}

export function encryptJson(
  value: unknown,
  key: Buffer,
  associatedData?: string,
): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson(
  payload: EncryptedPayload,
  key: Buffer,
  associatedData?: string,
): unknown {
  if (
    payload.version !== 1 ||
    typeof payload.iv !== "string" ||
    typeof payload.tag !== "string" ||
    typeof payload.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(cleartext.toString("utf8")) as unknown;
}
