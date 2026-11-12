#!/bin/sh
set -eu
# microsandbox refuses storage another account could write to; keep everything it and we create private.
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Check Homebrew keg-only path when setsid is not in PATH.
for dir in /opt/homebrew/opt/util-linux/bin /usr/local/opt/util-linux/bin; do
	command -v setsid >/dev/null 2>&1 || [ ! -x "$dir/setsid" ] || PATH="$dir:$PATH"
done
command -v setsid >/dev/null || { echo "setsid is required" >&2; exit 1; }
config="${PI_V2_CONFIG:-$root/config.json}"
[ -f "$config" ] || { echo "$config is missing: run mise run setup" >&2; exit 1; }
# microsandbox refuses a storage root that is, or sits under, a group- or world-writable directory (sticky ones such as /tmp are fine).
node -e '
	const { readFileSync, statSync } = require("node:fs"), { dirname, join, resolve } = require("node:path");
	const { stateRoot } = JSON.parse(readFileSync(process.argv[1], "utf8"));
	for (let dir = join(resolve(stateRoot), "microsandbox"); ; dir = dirname(dir)) {
		const mode = statSync(dir, { throwIfNoEntry: false })?.mode ?? 0;
		if (mode & 0o022 && !(mode & 0o1000)) {
			console.error(`microsandbox refuses ${dir}: it is group- or world-writable. Fix: chmod 700 ${dir}`);
			process.exit(1);
		}
		if (dir === dirname(dir)) break;
	}
' "$config"

setsid node "$root/src/server.ts" &
broker=$!
stop() {
	trap - INT TERM
	kill -TERM "$broker" 2>/dev/null || true
	wait "$broker" || true
}
trap 'stop; exit 0' INT TERM
wait "$broker"
