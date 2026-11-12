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

command -v setsid >/dev/null || { echo "setsid is required" >&2; exit 1; }
config="${PI_V2_CONFIG:-$root/config.json}"
[ -f "$config" ] || { echo "$config is missing: run mise run setup" >&2; exit 1; }
backend=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).backend ?? 'microsandbox'" "$config")
# QEMU and qemu-img are Gondolin's; the microsandbox backend needs neither.
if [ "$backend" = gondolin ]; then
	command -v qemu-img >/dev/null || { echo "qemu-img is required to create Gondolin's COW root disk" >&2; exit 1; }
	if [ "${PI_V2_VMM:-krun}" = qemu ]; then
		case "$(uname -m)" in
			arm64|aarch64) qemu=qemu-system-aarch64 ;;
			*) qemu=qemu-system-x86_64 ;;
		esac
		command -v "$qemu" >/dev/null || { echo "$qemu is required for PI_V2_VMM=qemu (Linux: apt install qemu-system-x86; macOS: brew install qemu)" >&2; exit 1; }
	elif [ "$(uname -m)" = x86_64 ] && [ -z "${GONDOLIN_KRUN_RUNNER:-}" ]; then
		# The published x86_64 Krun runner uses AVX-512, which many CPUs lack.
		echo "Build the Krun runner first: mise run krun-runner (or set PI_V2_VMM=qemu)" >&2
		exit 1
	fi
else
	# microsandbox refuses a storage root that is, or sits under, a group- or world-writable directory (sticky ones such as /tmp are fine).
	node -e '
		const { readFileSync, statSync } = require("node:fs"), { dirname, join, resolve } = require("node:path");
		const { stateRoot } = JSON.parse(readFileSync(process.argv[1], "utf8"));
		for (let dir = join(resolve(stateRoot), "microsandbox"); ; dir = dirname(dir)) {
			let mode;
			try { mode = statSync(dir).mode; } catch { mode = 0; }
			if (mode & 0o022 && !(mode & 0o1000)) {
				console.error(`microsandbox refuses ${dir}: it is group- or world-writable. Fix: chmod 700 ${dir}`);
				process.exit(1);
			}
			if (dir === dirname(dir)) break;
		}
	' "$config"
fi

setsid node "$root/src/server.ts" &
broker=$!
stop() {
	trap - INT TERM
	kill -TERM "$broker" 2>/dev/null || true
	wait "$broker" || true
}
trap 'stop; exit 0' INT TERM
wait "$broker"
