#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
MIRROR_RUNNER="$REPO/scripts/database/run-production-object-mirror.sh"
CONFIG_DIRECTORY=/etc/xingxingzaishan
CONFIG_FILE="$CONFIG_DIRECTORY/object-mirror.env"
EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3
EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6
EXPECTED_ENDPOINT=oss-cn-shanghai.aliyuncs.com
EXPECTED_REGION=oss-cn-shanghai
EXPECTED_BUCKET=xingxingzaishan-mirror-01beifen
MODE=
TEMPORARY_FILE=
CONFIG_INSTALLED=NO

fail() {
  printf 'PRODUCTION_OBJECT_MIRROR_DESTINATION_CONFIG=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  unset ACCESS_KEY_ID ACCESS_KEY_SECRET
  if [ -n "$TEMPORARY_FILE" ] && [ -e "$TEMPORARY_FILE" ]; then
    rm -f -- "$TEMPORARY_FILE"
  fi
  if [ "$status" -ne 0 ] && [ "$CONFIG_INSTALLED" = YES ]; then
    rm -f -- "$CONFIG_FILE"
    printf 'DESTINATION_CONFIG_ROLLED_BACK=YES\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

case "${1:-}" in
  --preflight)
    [ "$#" = 1 ] || fail CONFIG_ARGUMENT_INVALID
    MODE=preflight
    ;;
  --authorize-configure=YES)
    [ "$#" = 1 ] || fail CONFIG_ARGUMENT_INVALID
    MODE=authorized
    ;;
  *) fail CONFIG_MODE_REQUIRED ;;
esac

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for command in git install mktemp mv rm stat; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -d "$REPO/.git" ] || fail REPOSITORY_INVALID
[ -x "$MIRROR_RUNNER" ] || fail MIRROR_RUNNER_MISSING
cd "$REPO"
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse HEAD^{tree})" = "$EXPECTED_TREE" ] || fail ACTIVE_TREE_MISMATCH
[ ! -e "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] \
  || fail DESTINATION_CONFIG_ALREADY_EXISTS

printf 'ACTIVE_COMMIT=%s\n' "$EXPECTED_COMMIT"
printf 'ACTIVE_TREE=%s\n' "$EXPECTED_TREE"
printf 'DESTINATION_ENDPOINT=%s\n' "$EXPECTED_ENDPOINT"
printf 'DESTINATION_REGION=%s\n' "$EXPECTED_REGION"
printf 'DESTINATION_BUCKET=%s\n' "$EXPECTED_BUCKET"
printf 'DESTINATION_CONFIG_PRESENT=NO\n'

if [ "$MODE" = preflight ]; then
  printf 'CONFIGURATION_WRITE=NONE\n'
  printf 'OSS_REQUESTS=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  printf 'READY_FOR_OBJECT_MIRROR_DESTINATION_CONFIG=YES\n'
  printf 'PRODUCTION_OBJECT_MIRROR_DESTINATION_CONFIG_PREFLIGHT=PASS\n'
  exit 0
fi

[ -t 0 ] && [ -t 1 ] || fail INTERACTIVE_TERMINAL_REQUIRED
printf 'Enter MIRROR_OSS_ACCESS_KEY_ID: '
IFS= read -r ACCESS_KEY_ID
printf 'Enter MIRROR_OSS_ACCESS_KEY_SECRET (input hidden): '
IFS= read -r -s ACCESS_KEY_SECRET
printf '\n'

[[ "$ACCESS_KEY_ID" =~ ^[A-Za-z0-9]{16,128}$ ]] \
  || fail ACCESS_KEY_ID_FORMAT_INVALID
[[ "$ACCESS_KEY_SECRET" =~ ^[A-Za-z0-9]{24,128}$ ]] \
  || fail ACCESS_KEY_SECRET_FORMAT_INVALID

install -d -o root -g root -m 0700 "$CONFIG_DIRECTORY" \
  || fail CONFIG_DIRECTORY_CREATE_FAILED
TEMPORARY_FILE="$(mktemp "$CONFIG_DIRECTORY/.object-mirror.env.XXXXXX")" \
  || fail CONFIG_TEMPORARY_CREATE_FAILED
{
  printf 'MIRROR_OSS_ENDPOINT=%s\n' "$EXPECTED_ENDPOINT"
  printf 'MIRROR_OSS_REGION=%s\n' "$EXPECTED_REGION"
  printf 'MIRROR_OSS_BUCKET=%s\n' "$EXPECTED_BUCKET"
  printf 'MIRROR_OSS_ACCESS_KEY_ID=%s\n' "$ACCESS_KEY_ID"
  printf 'MIRROR_OSS_ACCESS_KEY_SECRET=%s\n' "$ACCESS_KEY_SECRET"
  printf 'MIRROR_OSS_SECURE=true\n'
} > "$TEMPORARY_FILE"
chown root:root "$TEMPORARY_FILE" || fail CONFIG_OWNER_FAILED
chmod 0600 "$TEMPORARY_FILE" || fail CONFIG_MODE_FAILED
mv -- "$TEMPORARY_FILE" "$CONFIG_FILE" || fail CONFIG_INSTALL_FAILED
TEMPORARY_FILE=
CONFIG_INSTALLED=YES

[ -f "$CONFIG_FILE" ] || fail CONFIG_FILE_INVALID
[ ! -L "$CONFIG_FILE" ] || fail CONFIG_FILE_INVALID
[ "$(stat -c '%U:%G' "$CONFIG_FILE")" = root:root ] || fail CONFIG_OWNER_FAILED
[ "$(stat -c '%a' "$CONFIG_FILE")" = 600 ] || fail CONFIG_MODE_FAILED

unset ACCESS_KEY_ID ACCESS_KEY_SECRET
/usr/bin/bash "$MIRROR_RUNNER" --preflight \
  || fail MIRROR_PREFLIGHT_FAILED

CONFIG_INSTALLED=NO
printf 'DESTINATION_CONFIG_INSTALLED=YES\n'
printf 'DESTINATION_CONFIG_OWNER=root:root\n'
printf 'DESTINATION_CONFIG_MODE=600\n'
printf 'DATABASE_WRITE=NONE\n'
printf 'OSS_MUTATION=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_OBJECT_MIRROR_DESTINATION_CONFIG=PASS\n'
