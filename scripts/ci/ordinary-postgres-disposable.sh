#!/usr/bin/env bash
# Called by CI with the already pinned PostgreSQL service's image.
set -euo pipefail
: "${POSTGRES_TEST_IMAGE:?Pinned PostgreSQL test image is required}"
socket_dir=$(mktemp -d /tmp/ordinary-pa-pg-TEST-XXXXXXXX)
container_name="ar-ordinary-pg-${socket_dir##*-}"
cleanup() {
  status=$?
  trap - EXIT
  if ! docker rm --force --volumes "$container_name" >/dev/null; then status=1; fi
  if ! rm -rf -- "$socket_dir"; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
chmod 0777 "$socket_dir"
# Preserve the CI user's socket-directory ownership so /tmp cleanup works without root.
docker run --detach --name "$container_name" --network none --user postgres \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --mount "type=bind,source=$socket_dir,target=/var/run/postgresql" \
  "$POSTGRES_TEST_IMAGE" -c listen_addresses= -c unix_socket_permissions=0777 >/dev/null
ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container_name" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /var/run/postgresql -U postgres' >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Disposable ordinary PostgreSQL did not become ready' >&2
  exit 1
fi
export ORDINARY_TEST_POSTGRES_URL="postgresql://postgres@localhost/postgres?host=$socket_dir"
export ORDINARY_PA_TEST_POSTGRES_URL="$ORDINARY_TEST_POSTGRES_URL"
node scripts/ci/run-ordinary-postgres.mjs
