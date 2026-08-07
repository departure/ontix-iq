#!/usr/bin/env node
/**
 * Install and verify local toolchain deps before `pnpm start`.
 * Required: Git, Node.js 24+, pnpm 11 (see packageManager). On macOS/Linux,
 * Homebrew installs missing tools (and Homebrew itself when absent).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_MAJOR = 24;
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PNPM_VERSION = String(packageJson.packageManager || "pnpm@11.9.0").replace(/^pnpm@/, "");
const MIN_PNPM_MAJOR = Number(PNPM_VERSION.split(".")[0]) || 11;
const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";

augmentPathWithBrewPrefixes();

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export async function main() {
  console.log("Checking local dependencies…");
  if (isDarwin || isLinux) ensureHomebrew();
  ensureGit();
  ensureNode();
  ensurePnpm();
  verifyToolchain();
  ensureSubmodule();
  run("pnpm", ["install"], root);
  run("pnpm", ["install"], join(root, "cloudflare-os"));
  console.log("Dependencies ready.\n");
}

/** Prefer Apple Silicon / Intel Homebrew bins even when the parent shell PATH is thin. */
function augmentPathWithBrewPrefixes() {
  const prefixes = [];
  for (const prefix of ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"]) {
    const bin = join(prefix, "bin");
    if (existsSync(bin)) prefixes.push(bin);
  }
  if (!prefixes.length) return;
  process.env.PATH = `${prefixes.join(":")}:${process.env.PATH || ""}`;
}

function ensureHomebrew() {
  if (commandOk("brew", ["--version"])) {
    console.log(`  ✓ Homebrew (${capture("brew", ["--version"]).split("\n")[0]})`);
    return;
  }
  console.log("  • Homebrew missing — installing (NONINTERACTIVE)…");
  const install = spawnSync(
    "/bin/bash",
    ["-c", 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
    { stdio: "inherit", env: process.env },
  );
  if (install.status !== 0) {
    throw new Error(
      "Homebrew install failed. Install from https://brew.sh then re-run `pnpm start`.",
    );
  }
  applyBrewShellenv();
  if (!commandOk("brew", ["--version"])) {
    throw new Error("Homebrew installed but `brew` is not on PATH. Open a new terminal and re-run `pnpm start`.");
  }
  console.log(`  ✓ Homebrew (${capture("brew", ["--version"]).split("\n")[0]})`);
}

function applyBrewShellenv() {
  for (const brewBin of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]) {
    if (!existsSync(brewBin)) continue;
    const result = spawnSync(brewBin, ["shellenv"], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) continue;
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^export ([A-Za-z0-9_]+)="(.*)"$/);
      if (!match) continue;
      process.env[match[1]] = match[2];
    }
    augmentPathWithBrewPrefixes();
    return;
  }
}

function ensureGit() {
  if (commandOk("git", ["--version"])) {
    console.log(`  ✓ ${capture("git", ["--version"])}`);
    return;
  }
  installWithBrew("git");
  if (!commandOk("git", ["--version"])) throw new Error("Git is required but was not found after install.");
  console.log(`  ✓ ${capture("git", ["--version"])}`);
}

function ensureNode() {
  if (nodeSatisfies()) {
    console.log(`  ✓ Node.js ${capture("node", ["-p", "process.versions.node"])}`);
    return;
  }
  if (!commandOk("brew", ["--version"])) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required. Install it, then re-run \`pnpm start\`.`);
  }
  console.log(`  • Installing Node.js (need ${MIN_NODE_MAJOR}+) via Homebrew…`);
  installWithBrew("node");
  if (!nodeSatisfies()) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR}+ is still unavailable after brew install. Open a new terminal and re-run \`pnpm start\`.`,
    );
  }
  console.log(`  ✓ Node.js ${capture("node", ["-p", "process.versions.node"])}`);
}

function ensurePnpm() {
  if (pnpmSatisfies()) {
    console.log(`  ✓ pnpm ${capture("pnpm", ["-v"]).trim()}`);
    return;
  }
  if (commandOk("brew", ["--version"])) {
    console.log(`  • Installing pnpm@${PNPM_VERSION} via Homebrew…`);
    installWithBrew("pnpm");
  } else if (commandOk("corepack", ["--version"])) {
    console.log(`  • Enabling pnpm@${PNPM_VERSION} via corepack…`);
    run("corepack", ["enable"], root);
    run("corepack", ["prepare", `pnpm@${PNPM_VERSION}`, "--activate"], root);
  } else {
    throw new Error(`pnpm ${MIN_PNPM_MAJOR}+ is required. Install pnpm, then re-run \`pnpm start\`.`);
  }
  if (!pnpmSatisfies()) {
    throw new Error(
      `pnpm ${MIN_PNPM_MAJOR}+ is still unavailable after install. Open a new terminal and re-run \`pnpm start\`.`,
    );
  }
  console.log(`  ✓ pnpm ${capture("pnpm", ["-v"]).trim()}`);
}

function verifyToolchain() {
  if (!nodeSatisfies()) throw new Error(`Node.js ${MIN_NODE_MAJOR}+ required.`);
  if (!pnpmSatisfies()) throw new Error(`pnpm ${MIN_PNPM_MAJOR}+ required.`);
  if (!commandOk("git", ["--version"])) throw new Error("Git is required.");
}

function ensureSubmodule() {
  console.log("  • Initializing cloudflare-os submodule…");
  run("git", ["submodule", "update", "--init"], root);
  if (!existsSync(join(root, "cloudflare-os", "package.json"))) {
    throw new Error("Cloudflare OS submodule is missing after `git submodule update --init`.");
  }
  console.log("  ✓ cloudflare-os submodule");
}

function nodeSatisfies() {
  if (!commandOk("node", ["-p", "process.versions.node"])) return false;
  const version = capture("node", ["-p", "process.versions.node"]).trim();
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

function pnpmSatisfies() {
  if (!commandOk("pnpm", ["-v"])) return false;
  const version = capture("pnpm", ["-v"]).trim();
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major >= MIN_PNPM_MAJOR;
}

function installWithBrew(formula) {
  if (!commandOk("brew", ["--version"])) {
    throw new Error(`Cannot install ${formula}: Homebrew is unavailable on this platform. Install ${formula} manually.`);
  }
  run("brew", ["install", formula], root);
  applyBrewShellenv();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status ?? "unknown"}).`);
  }
}

function commandOk(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  return result.status === 0;
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf8", env: process.env }).trim();
}
