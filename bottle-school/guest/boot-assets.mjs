// Reshapes Gondolin's QEMU boot assets for a fast QEMU microvm boot, then reseals the manifest once.
// 1. Initramfs: keep only the kernel modules its /init loads before switch_root. Gondolin installs Alpine's linux-virt
//    package into the initramfs, so it ships every module (~31 MiB of ~43 MiB). A large initramfs is slow to unpack
//    and, under QEMU microvm, its top-of-RAM load address can overwrite the ACPI DSDT, hanging the kernel after
//    "ACPI: Core revision". The rootfs keeps the full module tree.
// 2. Kernel (x86_64): replace the bzImage with the uncompressed vmlinux ELF it wraps. QEMU (with qboot, see
//    patches/gondolin-0.13.0.patch) enters it through its PVH note, which skips ~0.2s of in-guest decompression.
// Usage: node boot-assets.mjs <asset-directory>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { readManifest, reseal } from "./assets.mjs";

// Matches the modprobe lines in Gondolin's initramfs /init, plus the virtio vsock transport and af_packet: the kernel
// autoloads af_packet for udhcpc's raw socket, and the Ubuntu rootfs has no modprobe, so it must load before switch_root.
const KEEP = ["virtio_blk", "ext4", "virtio_rng", "virtio_net", "fuse", "vmw_vsock_virtio_transport", "af_packet"];

const [assetDirectory] = process.argv.slice(2);
if (!assetDirectory) throw new Error("usage: node boot-assets.mjs <asset-directory>");
const assets = resolve(assetDirectory);
const manifest = readManifest(assets);

const trimInitramfs = () => {
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
		console.log(`trimmed initramfs ${before} -> ${statSync(initramfs).size} bytes (${removed} modules removed)`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
};

// The bzImage header (Documentation/arch/x86/boot.rst) locates the compressed vmlinux payload.
const extractPvhKernel = () => {
	const bzImage = readFileSync(join(assets, manifest.assets.kernel));
	if (bzImage.toString("latin1", 0x202, 0x206) !== "HdrS") throw new Error(`${manifest.assets.kernel} is not a bzImage`);
	const protectedMode = ((bzImage[0x1f1] || 4) + 1) * 512;
	const offset = protectedMode + bzImage.readUInt32LE(0x248);
	const payload = bzImage.subarray(offset, offset + bzImage.readUInt32LE(0x24c));
	const magic = payload.subarray(0, 4).toString("hex");
	// gzip and zstd payloads end with the 4-byte uncompressed size, which both decoders ignore as trailing data.
	const vmlinux = magic.startsWith("1f8b")
		? gunzipSync(payload)
		: magic === "28b52ffd"
			? zstdDecompressSync(payload.subarray(0, -4))
			: null;
	if (!vmlinux) throw new Error(`unsupported bzImage payload compression (magic ${magic})`);
	if (vmlinux.toString("hex", 0, 4) !== "7f454c46") throw new Error("the bzImage payload is not an ELF vmlinux");
	if (!hasPvhNote(vmlinux)) throw new Error("the kernel has no PVH entry note (CONFIG_PVH); QEMU cannot boot its vmlinux");
	const name = manifest.assets.kernel.replace(/^vmlinuz/, "vmlinux");
	if (name === manifest.assets.kernel) throw new Error(`unexpected kernel asset name ${manifest.assets.kernel}`);
	writeFileSync(join(assets, name), vmlinux);
	rmSync(join(assets, manifest.assets.kernel));
	manifest.assets.kernel = name;
	console.log(`replaced bzImage (${bzImage.length} bytes) with PVH vmlinux ${name} (${vmlinux.length} bytes)`);
};

// XEN_ELFNOTE_PHYS32_ENTRY (18) in a PT_NOTE segment of a 64-bit little-endian ELF.
const hasPvhNote = (elf) => {
	const phoff = Number(elf.readBigUInt64LE(0x20));
	const phentsize = elf.readUInt16LE(0x36);
	for (let i = 0; i < elf.readUInt16LE(0x38); i++) {
		const ph = phoff + i * phentsize;
		if (elf.readUInt32LE(ph) !== 4) continue;
		const start = Number(elf.readBigUInt64LE(ph + 8));
		const end = start + Number(elf.readBigUInt64LE(ph + 32));
		for (let note = start; note + 12 <= end; ) {
			const namesz = elf.readUInt32LE(note);
			const descsz = elf.readUInt32LE(note + 4);
			const name = elf.toString("latin1", note + 12, note + 12 + namesz).replace(/\0+$/, "");
			if (name === "Xen" && elf.readUInt32LE(note + 8) === 18) return true;
			note += 12 + Math.ceil(namesz / 4) * 4 + Math.ceil(descsz / 4) * 4;
		}
	}
	return false;
};

trimInitramfs();
if (manifest.config.arch === "x86_64") extractPvhKernel();
console.log(`resealed ${reseal(assets, manifest)}`);
