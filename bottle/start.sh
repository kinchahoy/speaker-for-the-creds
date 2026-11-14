#!/bin/sh
set -eu
# microsandbox refuses storage another account could write to; keep everything it and we create private.
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Check Homebrew keg-only path when setsid is not in PATH.
for dir in /opt/homebrew/opt/util-linux/bin /usr/local/opt/util-linux/bin; do
	command -v setsid >/dev/null 2>&1 || [ ! -x "$dir/setsid" ] || PATH="$dir:$PATH"
done
command -v setsid >/dev/null || { echo "setsid is missing. Fix: sudo apt install util-linux (macOS: brew install util-linux)" >&2; exit 1; }
home=${BOTTLE_HOME:-"$HOME/.bottle"}
config="${BOTTLE_CONFIG:-$home/config.json}"
export MSB_HOME="${MSB_HOME:-$home/microsandbox}"
[ -f "$config" ] || { echo "$config is missing. Fix: run mise run init bottle" >&2; exit 1; }
# microsandbox refuses a storage root (MSB_HOME) that is, or sits under, a group- or world-writable
# directory (sticky ones such as /tmp are fine).
node -e '
	const { statSync } = require("node:fs"), { dirname, resolve } = require("node:path");
	for (let dir = resolve(process.env.MSB_HOME); ; dir = dirname(dir)) {
		const mode = statSync(dir, { throwIfNoEntry: false })?.mode ?? 0;
		if (mode & 0o022 && !(mode & 0o1000)) {
			console.error(`microsandbox refuses ${dir}: it is group- or world-writable. Fix: chmod 700 ${dir}`);
			process.exit(1);
		}
		if (dir === dirname(dir)) break;
	}
'

setsid node "$root/src/server.ts" &
broker=$!
stop() {
	trap - INT TERM
	kill -TERM "$broker" 2>/dev/null || true
	wait "$broker" || true
}
trap 'stop; exit 0' INT TERM
wait "$broker"
