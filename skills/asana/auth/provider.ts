import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AppConfig } from "../../../src/config.js";
import { EncryptedTokenStore } from "./token-store.js";

export class AsanaOAuthProvider implements OAuthClientProvider {
  private verifier = "";
  private readonly expectedState = randomBytes(24).toString("base64url");
  readonly tokenStore: EncryptedTokenStore;

  constructor(private readonly config: AppConfig) {
    this.tokenStore = new EncryptedTokenStore(
      config.runtime.dataDir,
      config.runtime.tokenEncryptionKey,
    );
  }

  get redirectUrl(): URL {
    return this.config.asana.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl.toString()],
      client_name: "Ontix IQ",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    };
  }

  state(): string {
    return this.expectedState;
  }

  verifyState(received: string | null): void {
    if (!received || received !== this.expectedState) {
      throw new Error("Asana OAuth state validation failed");
    }
  }

  clientInformation(): OAuthClientInformationFull {
    if (!this.config.asana.clientId || !this.config.asana.clientSecret) {
      throw new Error("ASANA_CLIENT_ID and ASANA_CLIENT_SECRET are required");
    }
    return {
      ...this.clientMetadata,
      client_id: this.config.asana.clientId,
      client_secret: this.config.asana.clientSecret,
    };
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.tokenStore.read();
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.tokenStore.write(tokens);
  }

  async refreshTokens(): Promise<void> {
    const current = await this.tokens();
    if (!current?.refresh_token) throw new Error("Asana authorization has no refresh token");
    const client = this.clientInformation();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      resource: this.config.asana.serverUrl.toString(),
    });
    const response = await fetch("https://mcp.asana.com/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${client.client_id}:${client.client_secret}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Asana token refresh failed with HTTP ${response.status}`);
    }
    const refreshed = (await response.json()) as OAuthTokens;
    if (!refreshed.access_token) throw new Error("Asana token refresh returned no access token");
    await this.saveTokens({
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? current.refresh_token,
    });
  }

  redirectToAuthorization(url: URL): void {
    process.stdout.write(`Authorize Asana in your browser:\n${url.toString()}\n`);
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("Missing PKCE code verifier");
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier" || scope === "all") this.verifier = "";
  }
}
