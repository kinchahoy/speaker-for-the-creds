#!/bin/sh
# Preflight for the bottle-school host (Linux or macOS). Prints one line per check and the fix for anything missing.
set -u
# microsandbox refuses storage another account could write to; keep everything it and we create private.
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
failed=0
config=${PI_V2_CONFIG:-$root/config.json}
cfg() { node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]] ?? ''" "$config" "$1" 2>/dev/null; }
check() { # check <label> <fix> <command...>
	label=$1 fix=$2
	shift 2
	if "$@" >/dev/null 2>&1; then echo "ok       $label"; else echo "MISSING  $label -> $fix"; failed=1; fi
}
if [ "$(uname -s)" = Darwin ]; then
	setsid_fix="brew install util-linux (setsid is keg-only: /opt/homebrew/opt/util-linux/bin)"
	[ -x /opt/homebrew/opt/util-linux/bin/setsid ] && PATH="/opt/homebrew/opt/util-linux/bin:$PATH"
	[ -x /usr/local/opt/util-linux/bin/setsid ] && PATH="/usr/local/opt/util-linux/bin:$PATH"
else
	setsid_fix="sudo apt install util-linux"
fi
check "node and pnpm (mise run install)" "mise install" sh -c 'command -v node && command -v pnpm'
check "docker daemon reachable" "install Docker and start it" docker info
check "setsid" "$setsid_fix" command -v setsid
if [ "$(uname -s)" = Darwin ]; then
	check "hardware virtualization (Hypervisor.framework)" "use a Mac with Hypervisor support" sh -c '[ "$(sysctl -n kern.hv_support)" = 1 ]'
else
	check "/dev/kvm readable and writable" "sudo usermod -aG kvm \$USER, then log in again (WSL: wsl --shutdown)" sh -c 'test -r /dev/kvm && test -w /dev/kvm'
fi
check "config.json (mise run init bottle-school)" "mise run init bottle-school" test -f "$config"
# Boot the configured guest image once (~5s): host checks can all pass while the guest kernel hangs at boot.
if [ "$failed" = 0 ]; then
	image=$(cfg guestImage)
	export MSB_HOME="$(cfg stateRoot)/microsandbox"
	check "guest image $image loaded into microsandbox" "mise run guest-build $image" sh -c '"$1" image ls | grep -q "$2"' sh "$root/node_modules/.bin/msb" "$image"
	check "guest image $image boots and runs a command" "mise run guest-build $image" \
		sh -c '"$1" run -q --no-net --replace --name pi-doctor "$2" -- true; rc=$?; "$1" rm pi-doctor; exit $rc' sh "$root/node_modules/.bin/msb" "$image"
fi
[ "$failed" = 0 ] && echo "all checks passed" || { echo "some checks failed" >&2; exit 1; }
