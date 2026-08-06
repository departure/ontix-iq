import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load MCP OAuth tokens from `.data/secrets/asana-tokens.json` when present so local
 * Wrangler can refresh without requiring ASANA_REFRESH_TOKEN in `.env`.
 */
export function loadLocalAsanaMcpTokens(root, environment = {}) {
  const dataDir = environment.ONTIX_DATA_DIR || join(root, ".data");
  const tokenPath = join(dataDir, "secrets", "asana-tokens.json");
  if (!existsSync(tokenPath)) return null;
  const key = resolveKey(dataDir, environment.ONTIX_TOKEN_ENCRYPTION_KEY);
  if (!key) return null;
  try {
    const payload = JSON.parse(readFileSync(tokenPath, "utf8"));
    const decrypted = decryptJson(payload, key);
    const tokens = decrypted?.tokens && typeof decrypted.tokens === "object"
      ? decrypted.tokens
      : decrypted;
    if (!tokens?.refresh_token) return null;
    return {
      accessToken: typeof tokens.access_token === "string" ? tokens.access_token : "",
      refreshToken: tokens.refresh_token,
    };
  } catch {
    return null;
  }
}

function resolveKey(dataDir, configuredKey) {
  if (configuredKey) return createHash("sha256").update(configuredKey).digest();
  const keyPath = join(dataDir, "secrets", "local-token.key");
  if (!existsSync(keyPath)) return null;
  const key = Buffer.from(readFileSync(keyPath, "utf8"), "base64");
  return key.length === 32 ? key : null;
}

function decryptJson(payload, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
