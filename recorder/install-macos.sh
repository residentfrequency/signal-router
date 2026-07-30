#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LABEL="com.residentfrequency.recorder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APPDIR="$HOME/Library/Application Support/ResidentFrequency"
RUNTIME="$APPDIR/recorder"
LOGDIR="$HOME/Library/Logs/ResidentFrequency"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR" "$RUNTIME"
rsync -a --delete \
  "$ROOT/recorder.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/node_modules" \
  "$RUNTIME/"
sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__RECORDER__|$RUNTIME/recorder.js|g" \
  -e "s|__WORKDIR__|$RUNTIME|g" \
  -e "s|__LOGDIR__|$LOGDIR|g" \
  "$ROOT/$LABEL.plist.template" > "$PLIST"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"
echo "Recorder installed: http://127.0.0.1:3010"
