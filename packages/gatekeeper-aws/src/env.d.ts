declare namespace Cloudflare {
  interface Env {
    AWS_ACCESS_KEY: string;
    AWS_ACCESS_KEY_SECRET: string;
    AWS_REGIONS?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CustomGatekeeper";
  }
}
