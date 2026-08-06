import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brandingDir = join(root, "branding");
const brandingPath = join(brandingDir, "branding.jsonc");
const overridesSrc = join(brandingDir, "overrides.css");
const logoSrc = join(brandingDir, "logo.png");
const distDir = join(root, "cloudflare-os/packages/workshop-frontend/dist");
const overridesDest = join(distDir, "overrides.css");
const logoDest = join(distDir, "branding-logo.png");
const indexPath = join(distDir, "index.html");
const linkTag = '<link rel="stylesheet" href="/overrides.css" />';
const DEFAULT_SITE_NAME = "Cloudflare OS";

function readBranding() {
  if (!existsSync(brandingPath)) {
    throw new Error(`Missing branding config: ${brandingPath}`);
  }
  const errors = [];
  const branding = parse(readFileSync(brandingPath, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) {
    const { error, offset } = errors[0];
    throw new Error(`Invalid branding.jsonc at offset ${offset}: ${printParseErrorCode(error)}`);
  }
  if (!branding || typeof branding !== "object") {
    throw new Error("branding.jsonc must be an object");
  }
  const siteName = typeof branding.siteName === "string" ? branding.siteName.trim() : "";
  const accentColor = typeof branding.accentColor === "string" ? branding.accentColor.trim() : "";
  if (!siteName) throw new Error("branding.jsonc siteName is required");
  if (!/^#[0-9A-Fa-f]{6}$/.test(accentColor)) {
    throw new Error("branding.jsonc accentColor must be a #RRGGBB hex color");
  }
  return { siteName, accentColor };
}

function injectStylesheetLink(html) {
  if (html.includes("/overrides.css")) return html;
  if (!html.includes("</head>")) {
    throw new Error(`Cannot inject branding stylesheet: no </head> in ${indexPath}`);
  }
  return html.replace("</head>", `    ${linkTag}\n  </head>`);
}

function injectInlineAccent(html, accentColor) {
  const marker = "data-ontix-branding-accent";
  const style = `<style ${marker}>
html {
  --color-kumo-brand: ${accentColor} !important;
  --color-kumo-brand-hover: color-mix(in srgb, ${accentColor} 88%, #000) !important;
  --text-color-kumo-brand: ${accentColor} !important;
  --text-color-kumo-link: ${accentColor} !important;
  --color-accent-100: ${accentColor} !important;
  --color-accent-200: color-mix(in srgb, ${accentColor} 72%, #fff) !important;
}
html[data-mode="dark"] {
  --color-kumo-brand: color-mix(in srgb, ${accentColor} 88%, #000) !important;
  --color-kumo-brand-hover: color-mix(in srgb, ${accentColor} 76%, #000) !important;
  --text-color-kumo-brand: color-mix(in srgb, ${accentColor} 72%, #fff) !important;
  --text-color-kumo-link: color-mix(in srgb, ${accentColor} 72%, #fff) !important;
  --color-accent-100: color-mix(in srgb, ${accentColor} 88%, #000) !important;
  --color-accent-200: color-mix(in srgb, ${accentColor} 72%, #fff) !important;
}
</style>`;
  if (html.includes(marker)) {
    return html.replace(/<style data-ontix-branding-accent>[\s\S]*?<\/style>/, style);
  }
  if (!html.includes("</head>")) {
    throw new Error(`Cannot inject branding accent: no </head> in ${indexPath}`);
  }
  return html.replace("</head>", `    ${style}\n  </head>`);
}

function replaceDefaultSiteName(siteName) {
  const assetsDir = join(distDir, "assets");
  if (!existsSync(assetsDir)) return 0;
  let replacements = 0;
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith(".js")) continue;
    const path = join(assetsDir, name);
    const source = readFileSync(path, "utf8");
    if (!source.includes(DEFAULT_SITE_NAME)) continue;
    // Only the product default string (resolveSiteName fallback); one occurrence in the bundle.
    const next = source.replaceAll(DEFAULT_SITE_NAME, siteName);
    if (next !== source) {
      writeFileSync(path, next);
      replacements += 1;
    }
  }
  return replacements;
}

/** Copy branding assets into the built frontend and bake in site name + accent defaults. */
export function applyBranding() {
  const { siteName, accentColor } = readBranding();

  if (!existsSync(overridesSrc)) {
    throw new Error(`Missing branding overrides: ${overridesSrc}`);
  }
  if (!existsSync(distDir)) {
    throw new Error(
      `Frontend dist is missing (${distDir}). Build @gadgets/workshop-frontend before applying branding.`,
    );
  }
  mkdirSync(distDir, { recursive: true });
  copyFileSync(overridesSrc, overridesDest);
  if (existsSync(logoSrc)) copyFileSync(logoSrc, logoDest);

  if (!existsSync(indexPath)) {
    throw new Error(`Frontend index is missing: ${indexPath}`);
  }
  let html = readFileSync(indexPath, "utf8");
  html = injectStylesheetLink(html);
  html = injectInlineAccent(html, accentColor);
  html = html.replace(`<title>${DEFAULT_SITE_NAME}</title>`, `<title>${siteName}</title>`);
  // Idempotent title rewrite if a previous apply already changed it.
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${siteName}</title>`);
  writeFileSync(indexPath, html);

  const jsHits = replaceDefaultSiteName(siteName);
  console.log(`branding: siteName=${JSON.stringify(siteName)} accent=${accentColor}`);
  console.log(`branding: wrote ${overridesDest}`);
  if (existsSync(logoDest)) console.log(`branding: wrote ${logoDest} (upload via /admin as user "admin")`);
  console.log(`branding: updated default site name in ${jsHits} JS asset(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    applyBranding();
  } catch (error) {
    console.error(`\nBranding apply failed. ${error.message}`);
    process.exitCode = 1;
  }
}
