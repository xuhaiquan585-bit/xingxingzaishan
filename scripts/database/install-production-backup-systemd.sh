#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
UNIT_SOURCE_DIR="$REPO/scripts/systemd"
UNIT_TARGET_DIR=/etc/systemd/system
SERVICE=xingxingzaishan-production-backup.service
TIMER=xingxingzaishan-production-backup.timer
STATE_DIR=/var/lib/xingxingzaishan-production-backup
LOG_DIR=/var/log/xingxingzaishan-production-backup
MANAGED_MARKER='# Managed-By: xingxingzaishan-production-backup'
CHANGED=NO

fail() {
  printf 'PRODUCTION_BACKUP_SYSTEMD_INSTALL=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

install_unit_if_changed() {
  local name="$1"
  local source="$UNIT_SOURCE_DIR/$name"
  local target="$UNIT_TARGET_DIR/$name"
  local temporary
  [ -f "$source" ] || fail UNIT_SOURCE_MISSING
  [ ! -L "$source" ] || fail UNIT_SOURCE_UNSAFE
  grep -Fxq "$MANAGED_MARKER" "$source" || fail UNIT_SOURCE_UNMANAGED
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] || fail UNIT_TARGET_UNSAFE
    [ ! -L "$target" ] || fail UNIT_TARGET_UNSAFE
    grep -Fxq "$MANAGED_MARKER" "$target" || fail UNIT_TARGET_UNMANAGED
    if cmp -s -- "$source" "$target" \
      && [ "$(stat -c '%U:%G' "$target")" = root:root ] \
      && [ "$(stat -c '%a' "$target")" = 644 ]; then
      return 0
    fi
  fi
  temporary="$(mktemp "$UNIT_TARGET_DIR/.${name}.XXXXXX")" \
    || fail UNIT_TEMPORARY_CREATE_FAILED
  install -o root -g root -m 0644 "$source" "$temporary" \
    || fail UNIT_INSTALL_FAILED
  mv -f -- "$temporary" "$target" || fail UNIT_REPLACE_FAILED
  CHANGED=YES
}

assert_directory_target_safe() {
  local directory="$1"
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    [ -d "$directory" ] || return 1
    [ ! -L "$directory" ] || return 1
  fi
}

[ "$#" = 0 ] || fail INSTALL_ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO" ] || fail REPOSITORY_MISSING
command -v systemctl >/dev/null 2>&1 || fail SYSTEMCTL_REQUIRED
command -v systemd-analyze >/dev/null 2>&1 || fail SYSTEMD_ANALYZE_REQUIRED

systemd-analyze verify \
  "$UNIT_SOURCE_DIR/$SERVICE" \
  "$UNIT_SOURCE_DIR/$TIMER" \
  >/dev/null || fail SYSTEMD_UNIT_VERIFY_FAILED

assert_directory_target_safe "$STATE_DIR" || fail STATE_DIRECTORY_UNSAFE
assert_directory_target_safe "$LOG_DIR" || fail LOG_DIRECTORY_UNSAFE
install -d -o root -g root -m 0700 "$STATE_DIR" "$LOG_DIR" \
  || fail OBSERVABILITY_DIRECTORY_CREATE_FAILED
install_unit_if_changed "$SERVICE"
install_unit_if_changed "$TIMER"

if [ "$CHANGED" = YES ]; then
  systemctl daemon-reload || fail SYSTEMD_DAEMON_RELOAD_FAILED
fi

if ! systemctl is-enabled --quiet "$TIMER"; then
  systemctl enable "$TIMER" >/dev/null || fail TIMER_ENABLE_FAILED
fi

if ! systemctl is-active --quiet "$TIMER"; then
  systemctl start "$TIMER" || fail TIMER_START_FAILED
fi

systemctl is-enabled --quiet "$TIMER" || fail TIMER_NOT_ENABLED
systemctl is-active --quiet "$TIMER" || fail TIMER_NOT_ACTIVE

echo "SYSTEMD_UNIT_FILES_CHANGED=$CHANGED"
echo "SYSTEMD_SERVICE=$SERVICE"
echo "SYSTEMD_TIMER=$TIMER"
echo 'SYSTEMD_TIMER_SCHEDULE=OnActiveSec=2min,OnUnitActiveSec=1h,AccuracySec=1min'
echo "STATE_DIRECTORY=$STATE_DIR"
echo "LOG_DIRECTORY=$LOG_DIR"
echo 'SYSTEMD_TIMER_ENABLED=YES'
echo 'SYSTEMD_TIMER_ACTIVE=YES'
echo 'PRODUCTION_BACKUP_SYSTEMD_INSTALL=PASS'
