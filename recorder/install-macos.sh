#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LABEL="com.residentfrequency.recorder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/ResidentFrequency"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__RECORDER__|$ROOT/recorder.js|g" \
  -e "s|__WORKDIR__|$ROOT|g" \
  -e "s|__LOGDIR__|$LOGDIR|g" \
  "$ROOT/$LABEL.plist.template" > "$PLIST"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"
echo "Recorder installed: http://127.0.0.1:3010"
