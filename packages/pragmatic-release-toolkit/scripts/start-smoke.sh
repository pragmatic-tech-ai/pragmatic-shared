#!/usr/bin/env bash
# Starts a container image once with no configuration (container-ci.yml's start smoke) and judges how it ends:
#   - output with a module-resolution error fails (the image lacks a file its entry loads);
#   - a non-zero exit fails unless its output matches the configuration-refusal pattern (extended grep, case-insensitive);
#   - an image still running after the wait passes; it is stopped and removed whatever the outcome.
# Usage: start-smoke.sh <image>   environment: SMOKE_ARGS (extra docker run arguments, split on blanks, never globbed),
#        SMOKE_REFUSAL (the refusal pattern), SMOKE_SECONDS (the wait, default 20).
set -euo pipefail

IMAGE="${1:?usage: start-smoke.sh <image>}"
REFUSAL="${SMOKE_REFUSAL:?SMOKE_REFUSAL is required}"
SECONDS_TO_WAIT="${SMOKE_SECONDS:-20}"
MODULE_ERROR='ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM'
NAME="start-smoke-$$-$RANDOM"
ARGS=()
read -r -a ARGS <<< "${SMOKE_ARGS:-}"

cleanup()
{
    docker rm -f "$NAME" > /dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$NAME" "${ARGS[@]}" "$IMAGE" > /dev/null
running=true
for _ in $(seq 1 "$SECONDS_TO_WAIT"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
        running=false
        break
    fi
    sleep 1
done
logs="$(docker logs "$NAME" 2>&1)"
code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
printf '%s\n' "$logs"
if printf '%s' "$logs" | grep -Eq "$MODULE_ERROR"; then
    echo '::error::the image cannot resolve a module'
    exit 1
fi
if [ "$running" = false ] && [ "$code" != 0 ] && ! printf '%s' "$logs" | grep -Eiq "$REFUSAL"; then
    echo "::error::the image died (exit $code) without a configuration refusal"
    exit 1
fi
echo "start smoke passed (running after ${SECONDS_TO_WAIT} s: $running, exit $code)"
