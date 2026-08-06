declare namespace Cloudflare {
  interface Env {
    ASANA_CLIENT_ID: string;
    ASANA_CLIENT_SECRET: string;
    ASANA_REFRESH_TOKEN: string;
    /** Optional bootstrap access token; refreshed via ASANA_REFRESH_TOKEN when absent or rejected. */
    ASANA_ACCESS_TOKEN?: string;
    ASANA_WORKSPACE_GID: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CustomGatekeeper";
  }
}
