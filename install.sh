#!/usr/bin/env bash
# BatutaMCP installer and upgrader (macOS). Run it again to upgrade.
#
#   curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh | bash
#   ... | bash -s -- --dry-run          # show the plan, write nothing
#   ... | bash -s -- --version v0.1.0   # a specific release instead of the latest
#
# What it does: downloads the release archive, checks its SHA-256, unpacks it into
# ~/.batuta-mcp (the old copy moves to ~/.batuta-mcp.previous), installs the Remote
# Script for Live with the bundled installer, and registers the MCP server with
# Claude Code (when `claude` is installed) and Claude Desktop (when it is installed). No sudo, nothing outside your home folder
# except what the bundled installer prints.
set -euo pipefail

# Everything runs inside main(), called on the last line: if the download of this script
# is cut short, bash never reaches that call and nothing runs.
main() {

DEFAULT_REPO_URL="https://github.com/paulpwo/batuta-mcp/releases"
MIN_NODE="22.14"

DIR="${BATUTA_HOME_DIR:-$HOME/.batuta-mcp}"
PREVIOUS="$DIR.previous"
# Claude Desktop: app bundle folders (BATUTA_APPLICATIONS_DIR is for tests) and its config file.
APPS_DIR="${BATUTA_APPLICATIONS_DIR:-/Applications}"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
# Claude Code reads its user settings from CLAUDE_CONFIG_DIR when set, else ~/.claude.
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
DRY_RUN=0
VERSION_ARG=""

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() { say "Usage: install.sh [--dry-run] [--version vX.Y.Z]"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value like v0.1.0"
      VERSION_ARG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

# --- Where to download from -------------------------------------------------
if [ -n "$VERSION_ARG" ]; then
  printf '%s' "$VERSION_ARG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    || die "--version must look like v0.1.0, got: $VERSION_ARG"
  ASSET="batuta-mcp-$VERSION_ARG.tar.gz"
  BASE="${BATUTA_DOWNLOAD_BASE:-$DEFAULT_REPO_URL/download/$VERSION_ARG}"
else
  ASSET="batuta-mcp.tar.gz"
  BASE="${BATUTA_DOWNLOAD_BASE:-$DEFAULT_REPO_URL/latest/download}"
fi
BASE="${BASE%/}"

# --- Preflight checks (read-only) -------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "BatutaMCP controls Ableton Live, so it installs on macOS only."
for tool in curl tar shasum; do
  command -v "$tool" > /dev/null 2>&1 || die "'$tool' is required but was not found."
done

NODE_HELP="Install Node.js $MIN_NODE or later (for example: brew install node, or https://nodejs.org), then run this again."
command -v node > /dev/null 2>&1 || die "Node.js was not found on your PATH. $NODE_HELP"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 14) ? 0 : 1)' \
  || die "Node.js $MIN_NODE or later is required (found $(node --version 2> /dev/null || echo unknown)). $NODE_HELP"
# The absolute path of node: Claude Code may not have your shell PATH (nvm, fnm).
NODE_ABS="$(node -p 'process.execPath')"

case "$DIR" in
  /?*) ;;
  *) die "BATUTA_HOME_DIR must be an absolute path, got: $DIR" ;;
esac
[ "$DIR" != "$HOME" ] || die "Refusing to install into your home folder itself."
[ ! -L "$DIR" ] || die "$DIR is a symlink; refusing to follow it. Remove or rename it yourself."
[ ! -L "$PREVIOUS" ] || die "$PREVIOUS is a symlink; refusing to follow it. Remove or rename it yourself."
if [ -e "$DIR" ]; then
  [ -d "$DIR" ] && [ -f "$DIR/VERSION" ] \
    || die "$DIR exists but is not a BatutaMCP install (no VERSION file). Move it away or set BATUTA_HOME_DIR."
fi
CURRENT=""
[ ! -f "$DIR/VERSION" ] || CURRENT="$(head -n 1 "$DIR/VERSION")"

has_desktop() { [ -d "$APPS_DIR/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ] || [ -e "$DESKTOP_CONFIG" ] || [ -L "$DESKTOP_CONFIG" ]; }

# --- Dry run: print the plan and stop ---------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: nothing will be downloaded or written."
  say "  1. Download $BASE/$ASSET and $BASE/$ASSET.sha256 and verify the SHA-256."
  say "  2. Unpack into a staging folder next to $DIR (entries with absolute paths or '..' are refused)."
  if [ -n "$CURRENT" ]; then
    say "  3. Replace $DIR (version $CURRENT); it moves to $PREVIOUS, replacing any older copy there."
  else
    say "  3. Create $DIR."
  fi
  say "  4. Run: $NODE_ABS $DIR/installer/install.mjs install"
  if command -v claude > /dev/null 2>&1; then
    say "  5. Run: claude mcp remove batutaMCP --scope user (ignored if absent), then claude mcp add --scope user batutaMCP -- $NODE_ABS --disallow-code-generation-from-strings $DIR/server/dist/src/bin.js"
  else
    say "  5. 'claude' was not found: print the registration command instead."
  fi
  if command -v claude > /dev/null 2>&1; then
    say "  6. Run: $NODE_ABS $DIR/installer/claude-code-settings.mjs tui --settings $CLAUDE_SETTINGS (sets \"tui\": \"fullscreen\", the renderer the transport bar's buttons need; backup first)."
  fi
  if has_desktop; then
    say "  7. Claude Desktop found: add the batutaMCP entry to $DESKTOP_CONFIG (other servers untouched, backup first; refused if the file is a symlink or not valid JSON)."
  else
    say "  7. Claude Desktop not found: skipped."
  fi
  exit 0
fi

# --- Download and verify ----------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/batuta-install.XXXXXX")"
STAGE=""
cleanup() { rm -rf "$WORK"; [ -z "$STAGE" ] || rm -rf "$STAGE"; }
trap cleanup EXIT

say "Downloading $ASSET ..."
curl -fsSL --proto '=https,file' -o "$WORK/$ASSET" "$BASE/$ASSET" || die "Could not download $BASE/$ASSET"
curl -fsSL --proto '=https,file' -o "$WORK/$ASSET.sha256" "$BASE/$ASSET.sha256" || die "Could not download $BASE/$ASSET.sha256"

EXPECTED="$(awk 'NR == 1 {print $1}' "$WORK/$ASSET.sha256")"
printf '%s' "$EXPECTED" | grep -Eq '^[0-9a-fA-F]{64}$' || die "The SHA-256 file is malformed."
ACTUAL="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
[ "$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')" = "$ACTUAL" ] \
  || die "SHA-256 mismatch for $ASSET (expected $EXPECTED, got $ACTUAL). Nothing was changed."
say "SHA-256 verified."

# Refuse unsafe entries before extracting anything: absolute paths, '..', links.
# (List into files first: "tar | grep -q" can die of SIGPIPE and fail open under pipefail.)
tar -tzf "$WORK/$ASSET" > "$WORK/names.txt" || die "The archive cannot be read."
tar -tvzf "$WORK/$ASSET" > "$WORK/long.txt" || die "The archive cannot be read."
if grep -Eq '^/|(^|/)\.\.(/|$)' "$WORK/names.txt"; then
  die "The archive has an entry with an absolute path or '..'; refusing to unpack it (unsafe archive)."
fi
if grep -q '^[lh]' "$WORK/long.txt"; then
  die "The archive contains a link; refusing to unpack it (unsafe archive)."
fi

# --- Unpack next to the target and swap in ----------------------------------
mkdir -p "$(dirname "$DIR")"
STAGE="$(mktemp -d "$DIR.staging.XXXXXX")"
tar -xzf "$WORK/$ASSET" -C "$STAGE"
for needed in VERSION installer/install.mjs server/dist/src/bin.js remote_script/BatutaMCP/__init__.py; do
  [ -f "$STAGE/$needed" ] || die "The archive is missing $needed; nothing was changed."
done
NEW="$(head -n 1 "$STAGE/VERSION")"

if [ -e "$DIR" ]; then
  rm -rf "$PREVIOUS"
  mv "$DIR" "$PREVIOUS"
  mv "$STAGE" "$DIR" || { mv "$PREVIOUS" "$DIR"; die "Could not move the new version into place; restored $DIR."; }
else
  mv "$STAGE" "$DIR"
fi
STAGE=""
chmod 755 "$DIR"   # mktemp creates the staging folder private
if [ -n "$CURRENT" ]; then say "Upgraded $CURRENT -> $NEW (previous copy: $PREVIOUS)"; else say "Installed $NEW into $DIR"; fi

# --- Remote Script for Live (the bundled installer refuses symlinked or foreign targets) ---
say "Installing the Remote Script ..."
# Its own "Next steps" list is dropped (this script prints the relevant ones below); the rest is shown.
if ! "$NODE_ABS" "$DIR/installer/install.mjs" install | awk '/^Next steps/ {skip = 1} !skip {print}'; then
  die "The Remote Script installer refused or failed (message above). BatutaMCP files are in $DIR; fix the problem and run this again."
fi

# --- Register with Claude Code ----------------------------------------------
BIN="$DIR/server/dist/src/bin.js"
if command -v claude > /dev/null 2>&1; then
  claude mcp remove batutaMCP --scope user > /dev/null 2>&1 || true
  claude mcp add --scope user batutaMCP -- "$NODE_ABS" --disallow-code-generation-from-strings "$BIN" \
    || die "'claude mcp add' failed; run the command above by hand."
  say "Registered batutaMCP with Claude Code."
  # The transport bar's buttons take clicks only under the fullscreen renderer: always set it.
  "$NODE_ABS" "$DIR/installer/claude-code-settings.mjs" tui --settings "$CLAUDE_SETTINGS" \
    || say "Could not update $CLAUDE_SETTINGS (see above). For the transport bar's buttons, type /tui fullscreen in Claude Code."
else
  say "Claude Code ('claude') was not found. To register the server, run:"
  say "  claude mcp add --scope user batutaMCP -- '$NODE_ABS' --disallow-code-generation-from-strings '$BIN'"
fi

# --- Register with Claude Desktop (merge done by Node, never by sed) --------
DESKTOP_DONE=0
if has_desktop; then
  if "$NODE_ABS" "$DIR/installer/desktop-config.mjs" merge --config "$DESKTOP_CONFIG" --node "$NODE_ABS" --bin "$BIN"; then
    DESKTOP_DONE=1
  else
    say "Could not update the Claude Desktop config (see above); it was left as it was. Merge this into its mcpServers object by hand:"
    say "  \"batutaMCP\": { \"command\": \"$NODE_ABS\", \"args\": [\"--disallow-code-generation-from-strings\", \"$BIN\"] }"
  fi
else
  say "Claude Desktop not found; skipped."
fi

# --- What is left for you ---------------------------------------------------
say ""
say "One manual step left:"
say "  1. In Live: Settings > Link, Tempo & MIDI > Control Surface: choose BatutaMCP (Input: None, Output: None)."
say "     Restart Live if it was running."
say "  2. Restart Claude Code and ask it for batuta_status."
if [ "$DESKTOP_DONE" = 1 ]; then
  say "     For Claude Desktop: fully quit and reopen Claude Desktop (Cmd-Q, then open it again)."
fi
say ""
say "Optional transport bar for Claude Code:"
say "  claude plugin marketplace add '$DIR/clients/claude-code'"
say "  claude plugin install batuta-transport@batuta --scope user"
say ""
say "To upgrade later, run the same install command again."
}

main "$@"
