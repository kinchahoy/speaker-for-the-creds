#!/bin/sh
# Builds Gondolin's Krun runner from pinned source for a non-AVX-512 baseline and installs it into .runtime/krun-runner/.
# The published npm runner is built on an AVX-512 machine and dies with SIGILL on CPUs without it (Zig's default target
# is the build host's CPU). This builds host/krun-runner at the Gondolin tag matching package.json with
# -Dcpu=x86_64_v3. Linux x86_64 only: the published arm64 and macOS runners are not affected (see README).
# libkrun is not rebuilt: the published package's libkrun.so.1.17.4 contains no AVX-512 and is the version Gondolin pins
# (LIBKRUN_VERSION in its Makefile); it is copied next to the runner (rpath $ORIGIN/../lib) and verified below.
# Needs: git, zig 0.17.x (mise install), objdump, and a prior pnpm install (for the libkrun copy).
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REF=v0.13.0
SHA=fcbcef162a73b214f79069f8430c70cebda0f827
src="$root/.runtime/krun-runner-src"
dest="$root/.runtime/krun-runner"
prefix="$root/.runtime/krun-runner-prefix"

[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "krun-runner.sh builds the Linux x86_64 runner only; elsewhere use the published runner" >&2; exit 1; }
for tool in git zig objdump; do command -v "$tool" >/dev/null || { echo "$tool is required (zig: mise install)" >&2; exit 1; }; done
case "$(zig version)" in 0.17.*) ;; *) echo "zig 0.17.x is required (found $(zig version))" >&2; exit 1 ;; esac
libkrun=$(ls -d "$root"/node_modules/.pnpm/@earendil-works+gondolin-krun-runner-linux-x64@*/node_modules/@earendil-works/gondolin-krun-runner-linux-x64/lib 2>/dev/null | head -n 1 || true)
[ -n "$libkrun" ] || { echo "published libkrun not found; run pnpm install in $root" >&2; exit 1; }

[ -d "$src/.git" ] || git clone --quiet --depth 1 --branch "$REF" https://github.com/earendil-works/gondolin "$src"
[ "$(git -C "$src" rev-parse HEAD)" = "$SHA" ] || { echo "$src is not at $REF ($SHA); delete it and retry" >&2; exit 1; }

# build.zig links -lkrun from <prefix>/lib64 on Linux; stage the published library there.
rm -rf "$prefix" "$dest"
mkdir -p "$prefix/lib64" "$dest/lib"
cp -a "$libkrun"/. "$prefix/lib64/"
cp -a "$libkrun"/. "$dest/lib/"
(cd "$src/host/krun-runner" && zig build -Doptimize=ReleaseSafe -Dcpu=x86_64_v3 -Dlibkrun-prefix="$prefix" --prefix "$dest" --cache-dir "$root/.runtime/krun-runner-cache")
rm -rf "$prefix"

for binary in "$dest/bin/gondolin-krun-runner" "$dest/lib/libkrun.so.1.17.4"; do
	[ "$(objdump -d "$binary" | grep -c zmm)" = 0 ] || { echo "$binary contains AVX-512 (zmm) instructions" >&2; exit 1; }
done
"$dest/bin/gondolin-krun-runner" --version
echo "installed $dest/bin/gondolin-krun-runner (Gondolin $REF, x86_64_v3, 0 zmm instructions); start.sh exports it as GONDOLIN_KRUN_RUNNER"
