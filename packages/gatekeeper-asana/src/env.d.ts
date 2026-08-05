declare namespace Cloudflare {
  interface Env {
    ASANA_ACCESS_TOKEN: string;
    ASANA_WORKSPACE_GID: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CustomGatekeeper";
  }
}
