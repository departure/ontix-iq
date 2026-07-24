#!/bin/bash

# Double-click this file in Finder to install prerequisites and launch Ontix IQ.

set -u

MINIMUM_NODE_VERSION="26.4.0"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_KEY="$PROJECT_DIR/auth/github"
GITHUB_REPOSITORY="git@github.com:departure/ontix-iq.git"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"

banner() {
  clear
  printf '\n  Ontix IQ Launcher\n'
  printf '  =================\n\n'
}

pause_before_close() {
  printf '\n%s\n' "$1"
  printf 'Press Return to close this window.'
  read -r _
  exit 1
}

run_or_stop() {
  "$@" || pause_before_close "Setup could not be completed."
}

version_at_least() {
  local actual="${1#v}"
  local required="${2#v}"
  local actual_major actual_minor actual_patch required_major required_minor required_patch

  actual="${actual%%-*}"
  required="${required%%-*}"
  IFS=. read -r actual_major actual_minor actual_patch <<< "$actual"
  IFS=. read -r required_major required_minor required_patch <<< "$required"
  actual_minor="${actual_minor:-0}"
  actual_patch="${actual_patch:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  (( actual_major > required_major )) ||
    (( actual_major == required_major && actual_minor > required_minor )) ||
    (( actual_major == required_major && actual_minor == required_minor && actual_patch >= required_patch ))
}

load_homebrew_path() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

banner

if [[ "$(uname -s)" != "Darwin" ]]; then
  pause_before_close "This launcher requires macOS."
fi

if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  pause_before_close "Keep this launcher in the Ontix IQ project folder, beside package.json."
fi

cd "$PROJECT_DIR" || pause_before_close "The Ontix IQ project folder could not be opened."

printf '[1/7] Checking Homebrew...\n'
load_homebrew_path
if ! command -v brew >/dev/null 2>&1; then
  printf 'Homebrew is needed to install the development tools.\n'
  printf 'The official installer may ask for this Mac password.\n\n'
  run_or_stop /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_homebrew_path
fi
command -v brew >/dev/null 2>&1 || pause_before_close "Homebrew was not found after installation."

printf '\n[2/7] Checking Git...\n'
if ! git --version >/dev/null 2>&1; then
  printf 'Installing Git...\n'
  run_or_stop brew install git
else
  printf '%s\n' "$(git --version)"
fi

printf '\n[3/7] Updating Ontix IQ from GitHub...\n'
if [[ ! -d .git ]]; then
  pause_before_close "This folder is not a Git checkout, so Ontix IQ cannot update itself."
fi
if [[ ! -f "$GITHUB_KEY" ]]; then
  pause_before_close "The GitHub credential is missing from auth/github."
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  pause_before_close "Ontix IQ must be on the main Git branch before it can update."
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  pause_before_close "Ontix IQ has local code changes. Ask the person who supplied it to update the copy."
fi

chmod 600 "$GITHUB_KEY" || pause_before_close "The GitHub credential permissions could not be secured."
GIT_SSH_COMMAND="ssh -i \"$GITHUB_KEY\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
run_or_stop env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" \
  git pull --ff-only "$GITHUB_REPOSITORY" main

printf '\n[4/7] Checking Node.js and npm...\n'
if brew --prefix node >/dev/null 2>&1; then
  export PATH="$(brew --prefix node)/bin:$PATH"
fi

NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
fi

if [[ -z "$NODE_VERSION" ]] || ! version_at_least "$NODE_VERSION" "$MINIMUM_NODE_VERSION"; then
  printf 'Ontix IQ requires Node.js %s or newer. Installing it now...\n' "$MINIMUM_NODE_VERSION"
  if brew list --versions node >/dev/null 2>&1; then
    run_or_stop brew upgrade node
  else
    run_or_stop brew install node
  fi
  export PATH="$(brew --prefix node)/bin:$PATH"
  NODE_VERSION="$(node --version 2>/dev/null || true)"
fi

if [[ -z "$NODE_VERSION" ]] || ! version_at_least "$NODE_VERSION" "$MINIMUM_NODE_VERSION"; then
  pause_before_close "Node.js $MINIMUM_NODE_VERSION or newer could not be installed."
fi
command -v npm >/dev/null 2>&1 || pause_before_close "npm was not installed with Node.js."
printf 'Node.js %s; npm %s\n' "$NODE_VERSION" "$(npm --version)"

printf '\n[5/7] Installing Ontix IQ dependencies...\n'
run_or_stop npm install --no-audit --no-fund

printf '\n[6/7] Building Ontix IQ...\n'
run_or_stop npm run build

if [[ ! -f .env ]]; then
  printf '\nOntix IQ needs its service credentials before the first launch.\n'
  run_or_stop npm run setup
  open -a TextEdit "$PROJECT_DIR/.env"
  printf '\nA settings file has opened in TextEdit.\n'
  printf 'Add the credentials supplied with this demo, save the file, then return here.\n'
  printf 'Press Return when the settings file has been saved.'
  read -r _
fi

if [[ ! -f .data/secrets/asana-tokens.json ]] &&
  awk -F= '$1 == "ASANA_CLIENT_ID" && length($2) > 0 { found = 1 } END { exit !found }' .env &&
  awk -F= '$1 == "ASANA_CLIENT_SECRET" && length($2) > 0 { found = 1 } END { exit !found }' .env; then
  printf '\nAsana needs one-time authorization. Your browser will open.\n'
  if ! npm run auth:asana; then
    printf '\nAsana authorization was not completed. Ontix IQ will still launch,\n'
    printf 'but Asana features may be unavailable.\n'
  fi
fi

printf '\n[7/7] Launching Ontix IQ...\n\n'
npm run dev
APP_STATUS=$?

if (( APP_STATUS == 0 )); then
  printf '\nOntix IQ has closed.\n'
else
  printf '\nOntix IQ stopped with an error (code %d).\n' "$APP_STATUS"
fi
printf 'Press Return to close this window.'
read -r _
exit "$APP_STATUS"
