#!/bin/sh
# Preflight for the bottle-school host (Linux or macOS). Prints one line per check and the fix for anything missing.
# With "backend": "gondolin", Gondolin uses libkrun unless PI_V2_VMM=qemu; Krun also checks the Krun runner (no AVX-512 instructions) and the image's Krun boot assets. The default, microsandbox, needs neither.
set -u
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
os=$(uname -s)
case "$(uname -m)" in arm64|aarch64) arch=aarch64 qemu=qemu-system-aarch64 ;; *) arch=x86_64 qemu=qemu-system-x86_64 ;; esac
failed=0
config=${PI_V2_CONFIG:-$root/config.json}
cfg() { node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]] ?? ''" "$config" "$1" 2>/dev/null; }
backend=$(cfg backend); backend=${backend:-microsandbox}
check() { # check <label> <fix> <command...>
	label=$1 fix=$2
	shift 2
	if "$@" >/dev/null 2>&1; then echo "ok       $label"; else echo "MISSING  $label -> $fix"; failed=1; fi
}
if [ "$os" = Darwin ]; then
	qemu_fix="brew install qemu"; utils_fix="brew install qemu"; setsid_fix="brew install util-linux (setsid is keg-only: /opt/homebrew/opt/util-linux/bin)"
	[ -x /opt/homebrew/opt/util-linux/bin/setsid ] && PATH="/opt/homebrew/opt/util-linux/bin:$PATH"
	[ -x /usr/local/opt/util-linux/bin/setsid ] && PATH="/usr/local/opt/util-linux/bin:$PATH"
else
	qemu_fix="sudo apt install qemu-system-x86 (arm64: qemu-system-arm)"; utils_fix="sudo apt install qemu-utils"; setsid_fix="sudo apt install util-linux"
fi
check "node and pnpm (mise run install)" "mise install" sh -c 'command -v node && command -v pnpm'
check "docker daemon reachable" "install Docker and start it" docker info
[ "$backend" = gondolin ] && check "qemu-img" "$utils_fix" command -v qemu-img
check "setsid" "$setsid_fix" command -v setsid
if [ "$os" = Darwin ]; then
	check "hardware virtualization (Hypervisor.framework)" "use a Mac with Hypervisor support" sh -c '[ "$(sysctl -n kern.hv_support)" = 1 ]'
else
	check "/dev/kvm readable and writable" "sudo usermod -aG kvm \$USER, then log in again (WSL: wsl --shutdown)" sh -c 'test -r /dev/kvm && test -w /dev/kvm'
fi
if [ "$backend" = gondolin ] && [ "${PI_V2_VMM:-krun}" = krun ]; then
	# Same runner choice as start.sh: the locally built one, else Gondolin's published package.
	runner=$root/.runtime/krun-runner/bin/gondolin-krun-runner
	[ -x "$runner" ] || runner=$(ls "$root"/node_modules/.pnpm/@earendil-works+gondolin-krun-runner-*/node_modules/@earendil-works/*/bin/gondolin-krun-runner 2>/dev/null | head -n 1)
	check "Krun runner" "mise run krun-runner (README: VM backends)" test -x "$runner"
	[ "$runner" = "$root/.runtime/krun-runner/bin/gondolin-krun-runner" ] && export GONDOLIN_KRUN_RUNNER="$runner"
	# The published Linux x86_64 runner is built with AVX-512 and dies with SIGILL on CPUs without it (Zig builds for the build host's CPU).
	[ "$os" = Linux ] && check "Krun runner has no AVX-512 (zmm) instructions" "mise run krun-runner" sh -c '[ "$(objdump -d "$1" | grep -c zmm)" = 0 ]' sh "$runner"
fi
if [ "$backend" = gondolin ] && [ "${PI_V2_VMM:-krun}" != krun ]; then
	check "$qemu" "$qemu_fix" command -v "$qemu"
fi
check "config.json (mise run setup)" "mise run setup" test -f "$config"
# Boot the configured guest image once (~5s): host checks can all pass while the guest kernel hangs at boot.
if [ "$failed" = 0 ] && [ "$backend" = microsandbox ]; then
	image=$(cfg guestImage)
	export MSB_HOME="$(cfg stateRoot)/microsandbox"
	check "guest image $image loaded into microsandbox" "mise run guest-build $image" sh -c '"$1" image ls | grep -q "$2"' sh "$root/node_modules/.bin/msb" "$image"
	check "guest image $image boots and runs a command (microsandbox)" "mise run guest-build $image" \
		sh -c '"$1" run -q --no-net --replace --name pi-doctor "$2" -- true; rc=$?; "$1" rm pi-doctor; exit $rc' sh "$root/node_modules/.bin/msb" "$image"
elif [ "$failed" = 0 ]; then
	image=$(cfg guestImage)
	if [ "${PI_V2_VMM:-krun}" = krun ] && [ "$arch" = x86_64 ]; then
		# guest/boot-assets.mjs points the Krun slots at the ELF vmlinux and the initramfs; Gondolin's stock raw libkrunfw kernel does not boot.
		check "guest image $image has Krun boot assets" "mise run guest-build $image" node -e '
			const { execFileSync } = require("node:child_process"), fs = require("node:fs");
			const dir = /assetDir: (.*)/.exec(execFileSync(process.argv[1], ["image", "inspect", process.argv[2]], { encoding: "utf8" }))[1];
			const { assets } = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
			const magic = fs.readFileSync(`${dir}/${assets.krunKernel}`).subarray(0, 4).toString("hex");
			if (magic !== "7f454c46" || fs.statSync(`${dir}/${assets.krunInitrd}`).size < 4096) process.exit(1);
		' "$root/node_modules/.bin/gondolin" "$image"
	fi
	check "guest image $image boots and runs a command" "mise run guest-build $image (see README: VM backends)" \
		timeout 120 "$root/node_modules/.bin/gondolin" exec --image "$image" --vmm "${PI_V2_VMM:-krun}" -- true
fi
[ "$failed" = 0 ] && echo "all checks passed" || { echo "some checks failed" >&2; exit 1; }
