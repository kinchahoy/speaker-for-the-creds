#!/bin/sh
# Builds the guest image and loads it into microsandbox.
# Usage: guest/build.sh [image-tag]   (default: bottle-school-guest; set it as "guestImage" in config.json)
# Docker (buildx) builds guest/Dockerfile for the host architecture under the tag, then microsandbox loads it into its
# own home (MSB_HOME, else ~/.microsandbox).
# microsandbox refuses storage another account could write to; keep everything it and we create private.
umask 077
set -eu
IMAGE=${1:-bottle-school-guest}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MSB=${MSB:-"$ROOT/node_modules/.bin/msb"}
[ -n "${BOTTLE_SCHOOL_CONFIG:-}" ] || [ -z "${PI_V2_CONFIG:-}" ] || { echo "note: PI_V2_CONFIG is deprecated; use BOTTLE_SCHOOL_CONFIG." >&2; BOTTLE_SCHOOL_CONFIG=$PI_V2_CONFIG; }
CONFIG=${BOTTLE_SCHOOL_CONFIG:-"$ROOT/config.json"}

case "$(uname -m)" in
  arm64|aarch64) PLATFORM=linux/arm64 ;;
  x86_64) PLATFORM=linux/amd64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ -f "$CONFIG" ] || { echo "$CONFIG not found. Fix: run mise run init bottle-school first" >&2; exit 1; }
MSB_HOME=${MSB_HOME:-"$HOME/.microsandbox"}

# PI_GUEST_PLATFORMS=linux/amd64,linux/arm64 builds both (needs binfmt/QEMU emulation and Docker's containerd image store).
docker buildx build --load --platform "${PI_GUEST_PLATFORMS:-$PLATFORM}" -t "$IMAGE" "$ROOT/guest"
mkdir -p -m 700 "$MSB_HOME"
docker save --platform "$PLATFORM" "$IMAGE" | MSB_HOME="$MSB_HOME" "$MSB" load --tag "$IMAGE"
