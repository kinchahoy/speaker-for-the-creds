#!/bin/sh
# Preflight for the bottle-school host (Linux or macOS). Prints one line per check and the fix for anything missing.
# PI_V2_VMM=krun also checks the Krun kernel.
set -u
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
os=$(uname -s)
case "$(uname -m)" in arm64|aarch64) arch=aarch64 qemu=qemu-system-aarch64 ;; *) arch=x86_64 qemu=qemu-system-x86_64 ;; esac
failed=0
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
check "qemu-img" "$utils_fix" command -v qemu-img
check "setsid" "$setsid_fix" command -v setsid
if [ "$os" = Darwin ]; then
	check "hardware virtualization (Hypervisor.framework)" "use a Mac with Hypervisor support" sh -c '[ "$(sysctl -n kern.hv_support)" = 1 ]'
else
	check "/dev/kvm readable and writable" "sudo usermod -aG kvm \$USER, then log in again (WSL: wsl --shutdown)" sh -c 'test -r /dev/kvm && test -w /dev/kvm'
fi
if [ "${PI_V2_VMM:-qemu}" = krun ]; then
	[ "$arch" = x86_64 ] && check "Krun ELF kernel" "provide KRUN_VMLINUX or $root/.runtime/krun/vmlinux" test -f "${KRUN_VMLINUX:-$root/.runtime/krun/vmlinux}"
else
	check "$qemu" "$qemu_fix" command -v "$qemu"
fi
check "config.json (mise run setup)" "mise run setup" test -f "${PI_V2_CONFIG:-$root/config.json}"
[ "$failed" = 0 ] && echo "all checks passed" || { echo "some checks failed" >&2; exit 1; }
