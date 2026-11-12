#!/bin/sh
# Builds the guest image and loads it into microsandbox.
# Usage: guest/build.sh [image-tag]   (default: pi-v5-guest; set it as "guestImage" in config.json)
# Docker (buildx) builds guest/Dockerfile for the host architecture under the tag, then microsandbox loads it into
# <stateRoot>/microsandbox (stateRoot from config.json, or PI_V2_CONFIG).
# microsandbox refuses storage another account could write to; keep everything it and we create private.
umask 077
set -eu
IMAGE=${1:-pi-v5-guest}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MSB=${MSB:-"$ROOT/node_modules/.bin/msb"}
CONFIG=${PI_V2_CONFIG:-"$ROOT/config.json"}

case "$(uname -m)" in
  arm64|aarch64) PLATFORM=linux/arm64 ;;
  x86_64) PLATFORM=linux/amd64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ -f "$CONFIG" ] || { echo "$CONFIG not found: run mise run setup first" >&2; exit 1; }
STATE=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).stateRoot" "$CONFIG")

# PI_GUEST_PLATFORMS=linux/amd64,linux/arm64 builds both (needs binfmt/QEMU emulation and Docker's containerd image store).
docker buildx build --load --platform "${PI_GUEST_PLATFORMS:-$PLATFORM}" -t "$IMAGE" "$ROOT/guest"
mkdir -p -m 700 "$STATE/microsandbox"
docker save --platform "$PLATFORM" "$IMAGE" | MSB_HOME="$STATE/microsandbox" "$MSB" load --tag "$IMAGE"
