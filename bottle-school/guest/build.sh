#!/bin/sh
# Builds the one guest image and prepares it for both backends.
# Usage: guest/build.sh [image-tag]   (default: pi-v5-guest; set it as "guestImage" in config.json)
# 1. Docker (buildx) builds guest/Dockerfile for the host architecture. PI_GUEST_PLATFORMS=linux/amd64,linux/arm64 builds
#    both (needs binfmt/QEMU emulation for the foreign one and Docker's containerd image store).
# 2. Gondolin turns the image into VM assets (guest/build.json), boot-assets.mjs reshapes them for QEMU and Krun, and
#    they are imported under the tag.
# 3. microsandbox loads the same image into <stateRoot>/microsandbox (stateRoot from config.json, or PI_V2_CONFIG).
set -eu
IMAGE=${1:-pi-v5-guest}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
GONDOLIN=${GONDOLIN:-"$ROOT/node_modules/.bin/gondolin"}
MSB=${MSB:-"$ROOT/node_modules/.bin/msb"}
CONFIG=${PI_V2_CONFIG:-"$ROOT/config.json"}

# Ensure e2fsprogs (keg-only on macOS) is on PATH for mke2fs.
if ! command -v mke2fs >/dev/null 2>&1; then
  if [ -x "/opt/homebrew/opt/e2fsprogs/sbin/mke2fs" ]; then
    PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"
  elif [ -x "/usr/local/opt/e2fsprogs/sbin/mke2fs" ]; then
    PATH="/usr/local/opt/e2fsprogs/sbin:$PATH"
  fi
fi

case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 PLATFORM=linux/arm64 ;;
  x86_64) ARCH=x86_64 PLATFORM=linux/amd64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ -f "$CONFIG" ] || { echo "$CONFIG not found: run mise run setup first" >&2; exit 1; }
STATE=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).stateRoot" "$CONFIG")

# build.json names this tag as its rootfs source.
docker buildx build --load --platform "${PI_GUEST_PLATFORMS:-$PLATFORM}" -t pi-guest-shared "$ROOT/guest"

ASSETS=$(mktemp -d "${TMPDIR:-/tmp}/pi-assets.XXXXXX")
cleanup() { rm -rf "$ASSETS"; }
trap cleanup EXIT INT TERM
# Gondolin refreshes cached Alpine indexes only on a 404, so a warm cache would keep shipping old kernel packages.
"$GONDOLIN" build cache update --config "$ROOT/guest/build.json" --arch "$ARCH"
"$GONDOLIN" build --config "$ROOT/guest/build.json" --arch "$ARCH" --output "$ASSETS"
# Gondolin's privileged Docker builder writes root-owned assets. The host user must patch and import them.
if [ ! -w "$ASSETS/manifest.json" ]; then
  docker run --rm -v "$ASSETS:/assets" alpine:3.24 chown -R "$(id -u):$(id -g)" /assets
fi
# Trim the initramfs to the modules /init loads (a full-module one is slow and breaks QEMU microvm boots) and swap the
# bzImage for its PVH vmlinux (no in-guest decompression), which also fills the Krun slots; see the script.
node "$ROOT/guest/boot-assets.mjs" "$ASSETS"
"$GONDOLIN" build --verify "$ASSETS"
"$GONDOLIN" image import "$ASSETS" --tag "$IMAGE"

mkdir -p -m 700 "$STATE/microsandbox"
docker save --platform "$PLATFORM" pi-guest-shared | MSB_HOME="$STATE/microsandbox" "$MSB" load --tag "$IMAGE"
