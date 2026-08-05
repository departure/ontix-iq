export * from "./custom.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Custom Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
