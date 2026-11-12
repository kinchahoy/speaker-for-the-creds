#!/bin/sh
# Builds the microsandbox backend's guest image and loads it into microsandbox's image cache.
# Usage: guest/build-microsandbox.sh <state-root> [image-tag]   (default tag: pi-v5-ms; set it as "guestImage" in config.json)
# <state-root> is config.json's stateRoot: microsandbox keeps its storage in <state-root>/microsandbox, which the service
# creates with mode 700. Docker builds guest/Dockerfile (the same base the Gondolin image imports), then
# guest/microsandbox.Dockerfile on top, and `msb load` imports the `docker save` stream. BASE=<image> skips the base build.
set -eu
STATE=${1:?usage: guest/build-microsandbox.sh <state-root> [image-tag]}
IMAGE=${2:-pi-v5-ms}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MSB=${MSB:-"$ROOT/node_modules/.bin/msb"}

if [ -z "${BASE:-}" ]; then
  BASE=pi-guest-base:v5
  docker build --build-arg BROWSER="${PI_GUEST_BROWSER:-0}" --build-arg REFRESH="$(date +%F)" -t "$BASE" "$ROOT/guest"
fi
docker build -f "$ROOT/guest/microsandbox.Dockerfile" --build-arg BASE="$BASE" -t "$IMAGE" "$ROOT/guest"
mkdir -p -m 700 "$STATE/microsandbox"
docker save "$IMAGE" | MSB_HOME="$STATE/microsandbox" "$MSB" load --tag "$IMAGE"
