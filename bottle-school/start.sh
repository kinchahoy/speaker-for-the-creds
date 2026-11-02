#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_disk_tools="$root/.runtime/qemu"

if [ -x "$local_disk_tools/system-root/usr/bin/qemu-img" ]; then
	PATH="$local_disk_tools/system-root/usr/bin:$PATH"
	LD_LIBRARY_PATH="$local_disk_tools/system-root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
	export PATH LD_LIBRARY_PATH
fi

# Check Homebrew keg-only path when setsid is not in PATH.
if ! command -v setsid >/dev/null 2>&1; then
	if [ -x "/opt/homebrew/opt/util-linux/bin/setsid" ]; then
		PATH="/opt/homebrew/opt/util-linux/bin:$PATH"
	elif [ -x "/usr/local/opt/util-linux/bin/setsid" ]; then
		PATH="/usr/local/opt/util-linux/bin:$PATH"
	fi
fi

# Gondolin uses this baseline runner when present instead of the published runner.
if [ -x "$root/.runtime/krun-runner/bin/gondolin-krun-runner" ]; then
	GONDOLIN_KRUN_RUNNER="$root/.runtime/krun-runner/bin/gondolin-krun-runner"
	export GONDOLIN_KRUN_RUNNER
fi

command -v qemu-img >/dev/null || { echo "qemu-img is required to create Gondolin's COW root disk" >&2; exit 1; }
command -v setsid >/dev/null || { echo "setsid is required" >&2; exit 1; }

setsid node "$root/src/server.ts" &
broker=$!
stop() {
	trap - INT TERM
	kill -TERM "$broker" 2>/dev/null || true
	wait "$broker" || true
}
trap 'stop; exit 0' INT TERM
wait "$broker"
