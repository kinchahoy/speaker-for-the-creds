#!/bin/sh
# Builds one pinned guest image through Gondolin's supported build configuration.
# Usage: guest/build.sh [image-tag]   (default: pi-v5-guest)
# PI_GUEST_BROWSER=1 adds Playwright and Chromium, for example: PI_GUEST_BROWSER=1 guest/build.sh pi-v5-guest-browser
# Docker builds the Ubuntu rootfs from guest/Dockerfile; Gondolin imports it through guest/build.json.
set -eu
IMAGE=${1:-pi-v5-guest}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
GONDOLIN=${GONDOLIN:-"$ROOT/node_modules/.bin/gondolin"}
VMLINUX=${KRUN_VMLINUX:-"$ROOT/.runtime/krun/vmlinux"}

# Ensure e2fsprogs (keg-only on macOS) is on PATH for mke2fs.
if ! command -v mke2fs >/dev/null 2>&1; then
  if [ -x "/opt/homebrew/opt/e2fsprogs/sbin/mke2fs" ]; then
    PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"
  elif [ -x "/usr/local/opt/e2fsprogs/sbin/mke2fs" ]; then
    PATH="/usr/local/opt/e2fsprogs/sbin:$PATH"
  fi
fi

case "$(uname -m)" in
  arm64|aarch64)
    ARCH="aarch64"
    ;;
  x86_64)
    ARCH="x86_64"
    ;;
  *)
    ARCH="$(uname -m)"
    ;;
esac

if [ "$ARCH" = "x86_64" ]; then
  [ -f "$VMLINUX" ] || { echo "missing Krun x86_64 ELF kernel: $VMLINUX" >&2; exit 1; }
fi

docker build --build-arg BROWSER="${PI_GUEST_BROWSER:-0}" --build-arg REFRESH="$(date +%F)" -t pi-guest-base:v5 "$ROOT/guest"
ASSETS=$(mktemp -d "${TMPDIR:-/tmp}/pi-v3-assets.XXXXXX")
cleanup() { rm -rf "$ASSETS"; }
trap cleanup EXIT INT TERM

"$GONDOLIN" build --config "$ROOT/guest/build.json" --arch "$ARCH" --output "$ASSETS"
# Gondolin's privileged Docker builder writes root-owned assets. The host user must patch and import them.
if [ ! -w "$ASSETS/manifest.json" ]; then
  docker run --rm -v "$ASSETS:/assets" alpine:3.23 chown -R "$(id -u):$(id -g)" /assets
fi
if [ "$ARCH" = "x86_64" ]; then
  node "$ROOT/guest/patch-krun-assets.mjs" "$ASSETS" "$VMLINUX"
fi
"$GONDOLIN" build --verify "$ASSETS"
"$GONDOLIN" image import "$ASSETS" --tag "$IMAGE"
