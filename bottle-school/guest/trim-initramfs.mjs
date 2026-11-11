// Shrinks the Gondolin initramfs to the kernel modules its /init loads before switch_root.
// Gondolin installs Alpine's linux-virt package into the initramfs, so it ships every module (~31 MiB of ~43 MiB).
// A large initramfs is slow to unpack and, under QEMU microvm, its top-of-RAM load address can overwrite the ACPI
// DSDT, hanging the kernel after "ACPI: Core revision". The rootfs keeps the full module tree for later loads.
// Usage: node trim-initramfs.mjs <asset-directory>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readManifest, reseal } from "./assets.mjs";

// Matches the modprobe lines in Gondolin's initramfs /init, plus the virtio vsock transport.
const KEEP = ["virtio_blk", "ext4", "virtio_rng", "virtio_net", "fuse", "vmw_vsock_virtio_transport"];

const [assetDirectory] = process.argv.slice(2);
if (!assetDirectory) throw new Error("usage: node trim-initramfs.mjs <asset-directory>");
const assets = resolve(assetDirectory);
const manifest = readManifest(assets);
const initramfs = join(assets, manifest.assets.initramfs);
const before = statSync(initramfs).size;

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "initramfs-"));
try {
	const sh = (script, ...args) => execFileSync("sh", ["-c", script, "sh", ...args], { stdio: ["ignore", "ignore", "inherit"] });
	sh('lz4 -dc "$1" | (cd "$2" && cpio -idm --quiet)', initramfs, work);

	const name = (path) => path.split("/").pop().replace(/\.ko(\.(gz|xz|zst))?$/, "").replaceAll("-", "_");
	let removed = 0;
	for (const version of readdirSync(join(work, "lib/modules"))) {
		const base = join(work, "lib/modules", version);
		const deps = new Map(
			readFileSync(join(base, "modules.dep"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [module, rest = ""] = line.split(":");
					return [module, rest.trim().split(/\s+/).filter(Boolean)];
				}),
		);
		const byName = new Map([...deps.keys()].map((path) => [name(path), path]));
		const keep = new Set();
		const stack = KEEP.map((module) => byName.get(module)).filter(Boolean);
		while (stack.length) {
			const path = stack.pop();
			if (keep.has(path)) continue;
			keep.add(path);
			stack.push(...(deps.get(path) ?? []));
		}
		for (const path of deps.keys())
			if (!keep.has(path)) {
				rmSync(join(base, path), { force: true });
				removed += 1;
			}
		// Drop now-empty module directories so the archive stays small and tidy.
		sh('find "$1/kernel" -type d -empty -delete', base);
	}
	sh('cd "$1" && find . -print0 | cpio --null -o --quiet --format=newc | lz4 -l -9 -q -c > "$2"', work, initramfs);
	const buildId = reseal(assets, manifest);
	console.log(`trimmed initramfs ${before} -> ${statSync(initramfs).size} bytes (${removed} modules removed); ${buildId}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
