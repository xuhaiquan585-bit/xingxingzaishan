#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
UNIT_SOURCE_DIR="$REPO/scripts/systemd"
UNIT_TARGET_DIR=/etc/systemd/system
DAILY_SERVICE=xingxingzaishan-object-mirror.service
DAILY_TIMER=xingxingzaishan-object-mirror.timer
FULL_AUDIT_SERVICE=xingxingzaishan-object-mirror-full-audit.service
FULL_AUDIT_TIMER=xingxingzaishan-object-mirror-full-audit.timer
DESTINATION_OSS_ENV=/etc/xingxingzaishan/object-mirror.env
MANAGED_MARKER='# Managed-By: xingxingzaishan-object-mirror'
CHANGED=NO

fail() {
  printf 'PRODUCTION_OBJECT_MIRROR_SYSTEMD_INSTALL=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

assert_root_private_regular_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
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

[ "$#" = 0 ] || fail INSTALL_ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO" ] || fail REPOSITORY_MISSING
command -v systemctl >/dev/null 2>&1 || fail SYSTEMCTL_REQUIRED
command -v systemd-analyze >/dev/null 2>&1 || fail SYSTEMD_ANALYZE_REQUIRED
assert_root_private_regular_file "$DESTINATION_OSS_ENV" \
  || fail DESTINATION_OSS_ENV_UNSAFE

systemd-analyze verify \
  "$UNIT_SOURCE_DIR/$DAILY_SERVICE" \
  "$UNIT_SOURCE_DIR/$DAILY_TIMER" \
  "$UNIT_SOURCE_DIR/$FULL_AUDIT_SERVICE" \
  "$UNIT_SOURCE_DIR/$FULL_AUDIT_TIMER" \
  >/dev/null || fail SYSTEMD_UNIT_VERIFY_FAILED

install_unit_if_changed "$DAILY_SERVICE"
install_unit_if_changed "$DAILY_TIMER"
install_unit_if_changed "$FULL_AUDIT_SERVICE"
install_unit_if_changed "$FULL_AUDIT_TIMER"
if [ "$CHANGED" = YES ]; then
  systemctl daemon-reload || fail SYSTEMD_DAEMON_RELOAD_FAILED
fi
for timer in "$DAILY_TIMER" "$FULL_AUDIT_TIMER"; do
  if ! systemctl is-enabled --quiet "$timer"; then
    systemctl enable "$timer" >/dev/null || fail TIMER_ENABLE_FAILED
  fi
  if ! systemctl is-active --quiet "$timer"; then
    systemctl start "$timer" || fail TIMER_START_FAILED
  fi
  systemctl is-enabled --quiet "$timer" || fail TIMER_NOT_ENABLED
  systemctl is-active --quiet "$timer" || fail TIMER_NOT_ACTIVE
done

printf 'SYSTEMD_UNIT_FILES_CHANGED=%s\n' "$CHANGED"
printf 'SYSTEMD_DAILY_SERVICE=%s\n' "$DAILY_SERVICE"
printf 'SYSTEMD_DAILY_TIMER=%s\n' "$DAILY_TIMER"
printf 'SYSTEMD_DAILY_TIMER_SCHEDULE=DAILY_03_20_ASIA_SHANGHAI_RANDOM_DELAY_15_MIN\n'
printf 'SYSTEMD_FULL_AUDIT_SERVICE=%s\n' "$FULL_AUDIT_SERVICE"
printf 'SYSTEMD_FULL_AUDIT_TIMER=%s\n' "$FULL_AUDIT_TIMER"
printf 'SYSTEMD_FULL_AUDIT_TIMER_SCHEDULE=MONTHLY_DAY_01_04_20_ASIA_SHANGHAI_RANDOM_DELAY_15_MIN\n'
printf 'SYSTEMD_TIMERS_ENABLED=YES\n'
printf 'SYSTEMD_TIMERS_ACTIVE=YES\n'
printf 'PRODUCTION_OBJECT_MIRROR_SYSTEMD_INSTALL=PASS\n'
