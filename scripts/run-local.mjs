import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBranding } from "./apply-branding.mjs";
import { loadLocalAsanaMcpTokens } from "./asana-mcp-tokens.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "cloudflare-os");
const links = [
  ["gatekeeper-organization", join(root, "packages/custom-gatekeeper")],
  ["gatekeeper-asana", join(root, "packages/gatekeeper-asana")],
  ["gatekeeper-quickbooks", join(root, "packages/gatekeeper-quickbooks")],
  ["gatekeeper-aws", join(root, "packages/gatekeeper-aws")],
];

if (!existsSync(join(upstream, "package.json"))) throw new Error("Cloudflare OS is not initialized. Run: git submodule update --init");
const environment = loadEnvironment(join(root, ".env"));
execFileSync("pnpm", ["--filter", "@gadgets/typed-storage", "build"], { cwd: upstream, stdio: "inherit" });
execFileSync("pnpm", ["--filter", "@gadgets/workshop-frontend", "exec", "vite", "build"], { cwd: upstream, stdio: "inherit" });
applyBranding();
writeAsanaDevVars(environment);
writeVars(join(root, "packages/gatekeeper-aws/.dev.vars"), environment, ["AWS_ACCESS_KEY", "AWS_ACCESS_KEY_SECRET", "AWS_REGIONS"]);
for (const [name, target] of links) {
  const path = join(upstream, "packages", name);
  if (!existsSync(path)) symlinkSync(target, path, "dir");
}
// The upstream runner keeps a file watcher per gatekeeper alive after Wrangler exits, and those
// child handles hold its event loop open indefinitely. Its own group leader lets us signal the
// whole tree at once, and owning the keyboard here means quitting never depends on that runner.
const child = spawn(process.execPath, ["run-dev-server.js", "--serve-frontend-assets"], { cwd: upstream, stdio: ["ignore", "inherit", "inherit"], detached: true, env: { ...process.env, ...environment } });
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const [name] of links) {
    try { unlinkSync(join(upstream, "packages", name)); } catch {}
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
};
let stopping = false;
let expectedExitCode;
let stopTimer;
const stop = () => {
  if (stopping) return;
  stopping = true;
  expectedExitCode = 0;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  stopTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
  stopTimer.unref();
};
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  // Raw mode clears ISIG, so Ctrl+C and Ctrl+D arrive as data rather than signals. Keystrokes
  // typed while the server boots arrive coalesced into one chunk, so scan rather than compare.
  process.stdin.on("data", (keys) => { if (/[qx\u0003\u0004]/.test(keys)) stop(); });
  console.log("\nOntix IQ dev server starting. Press q to quit.\n");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Its own group no longer receives the terminal's hangup, so closing the window must stop it here.
process.on("SIGHUP", stop);
process.on("exit", () => {
  cleanup();
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
});
child.on("exit", (code) => {
  cleanup();
  clearTimeout(stopTimer);
  process.exit(stopping ? expectedExitCode : (code ?? 0));
});

function writeAsanaDevVars(values) {
  const local = loadLocalAsanaMcpTokens(root, values);
  const merged = {
    ASANA_CLIENT_ID: values.ASANA_CLIENT_ID,
    ASANA_CLIENT_SECRET: values.ASANA_CLIENT_SECRET,
    ASANA_WORKSPACE_GID: values.ASANA_WORKSPACE_GID,
    ASANA_REFRESH_TOKEN: values.ASANA_REFRESH_TOKEN || local?.refreshToken,
    // Prefer a stored MCP OAuth access token; a REST PAT is not valid for MCP.
    ASANA_ACCESS_TOKEN: local?.accessToken || values.ASANA_MCP_ACCESS_TOKEN,
  };
  writeVars(join(root, "packages/gatekeeper-asana/.dev.vars"), merged, [
    "ASANA_CLIENT_ID",
    "ASANA_CLIENT_SECRET",
    "ASANA_WORKSPACE_GID",
    "ASANA_REFRESH_TOKEN",
    "ASANA_ACCESS_TOKEN",
  ]);
  if (!merged.ASANA_REFRESH_TOKEN) {
    console.warn(
      "Asana MCP: no refresh token found in .env (ASANA_REFRESH_TOKEN) or .data/secrets/asana-tokens.json. " +
      "Set ASANA_REFRESH_TOKEN before using the Asana Gatekeeper.",
    );
  }
}

function loadEnvironment(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").flatMap((line) => {
    const value = line.trim();
    if (!value || value.startsWith("#") || !value.includes("=")) return [];
    const index = value.indexOf("=");
    return [[value.slice(0, index).trim(), value.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")]];
  }));
}

function writeVars(path, values, names) {
  const lines = names.flatMap((name) => values[name] ? [`${name}=${values[name]}`] : []);
  if (lines.length) writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}
