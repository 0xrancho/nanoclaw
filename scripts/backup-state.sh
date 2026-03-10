#!/usr/bin/env bash
# Backup NanoClaw runtime state (Thomas's work product)
# Usage: ./scripts/backup-state.sh

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/.nanoclaw-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/state-${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

cd "$NANOCLAW_DIR"

# Collect existing paths only
PATHS=()
for p in \
  groups/ \
  contacts/ \
  accounts/ \
  opportunities/ \
  data/nanoclaw.db \
  data/email-accounts.json \
  data/email-channel-state.json \
; do
  [ -e "$p" ] && PATHS+=("$p")
done

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "Nothing to back up."
  exit 0
fi

tar czf "$BACKUP_FILE" \
  --exclude='data/sessions' \
  --exclude='data/ipc' \
  "${PATHS[@]}"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backed up to ${BACKUP_FILE} (${SIZE})"

# Keep last 10 backups, prune older
ls -1t "${BACKUP_DIR}"/state-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm
