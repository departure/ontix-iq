# Ontix IQ branding

Single home for Workshop UI customization. Do not edit branding inside the `cloudflare-os` submodule.

| File | Role |
| --- | --- |
| `branding.jsonc` | Site name, accent hex, logo filename |
| `logo.png` | Square mark shown beside the plain-text site name |
| `overrides.css` | Theme color CSS variables (and future layout/font tweaks) |

## What applies automatically on build

`scripts/apply-branding.mjs` runs after the Workshop frontend Vite build (local and deploy). It:

1. Copies `overrides.css` into the frontend `dist/` and links it from `index.html`
2. Injects the accent color from `branding.jsonc` as critical CSS (so brand red shows without `/admin`)
3. Replaces the built-in default site name (`Cloudflare OS`) with `siteName` from `branding.jsonc`
4. Copies `logo.png` to `dist/branding-logo.png` for reference

### Local hot reload (`overrides.css`)

While `pnpm dev` / `pnpm start` is running, edits to `overrides.css` are watched and re-copied into `dist/`. A small local-only script in the page polls that stylesheet and swaps it in without restarting the app (or refreshing, in most cases).

Restart local after changing `branding.jsonc` or `logo.png` — those still need the full apply step (and Admin upload for the logo).

## `/admin` access (required for the logo)

Site logo upload still goes through AdminConfig. Locally, Cloudflare OS only treats username **`admin`** as an administrator (`ADMINS=["admin"]` in the upstream local runner).

If `/admin` shows “You don't have access to this page,” your signed-in username is not `admin`. Fix:

1. Sign out
2. Create or sign in with username exactly `admin` (any password you choose on first signup)
3. Open `/admin` → General → upload `branding/logo.png`
4. Optionally confirm site name `Ontix IQ` and accent `#dc3a3f` (build defaults already cover name + accent)

Production uses `deployment.jsonc` → `access.admins` (email list) instead of the local `admin` username.
