import { createHash } from "node:crypto";
import { closeSync, copyFileSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [assetDirectory, vmlinux] = process.argv.slice(2);
if (!assetDirectory || !vmlinux) throw new Error("usage: node patch-krun-assets.mjs <asset-directory> <vmlinux>");

const assets = resolve(assetDirectory);
const elfKernel = resolve(vmlinux);
const elfMagic = readFileSync(elfKernel).subarray(0, 4).toString("hex");
if (elfMagic !== "7f454c46") throw new Error(`${elfKernel} is not an ELF kernel`);

const manifestPath = `${assets}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.config?.arch !== "x86_64") throw new Error("the Krun ELF patch supports x86_64 assets only");
if (!manifest.assets?.krunKernel || !manifest.assets?.krunInitrd) throw new Error("the asset manifest has no Krun boot artifacts");

copyFileSync(elfKernel, `${assets}/${manifest.assets.krunKernel}`);

// A valid trailer-only newc archive. The ELF libkrun path rejects a zero-byte initrd.
const initrd = Buffer.alloc(512);
const cpioHeader = [
	"070701", // magic
	"00000000", "00000000", "00000000", "00000000", // ino, mode, uid, gid
	"00000001", "00000000", "00000000", // nlink, mtime, filesize
	"00000000", "00000000", "00000000", "00000000", // device and rdevice numbers
	"0000000b", "00000000", // pathname length and checksum
].join("");
if (cpioHeader.length !== 110) throw new Error("invalid newc header length");
initrd.write(cpioHeader, 0, "ascii");
initrd.write("TRAILER!!!\0", 110, "ascii");
writeFileSync(`${assets}/${manifest.assets.krunInitrd}`, initrd);

// Stream in chunks: the v5 rootfs exceeds Node's 2 GiB readFileSync limit.
const checksum = (file) => {
	const hash = createHash("sha256");
	const fd = openSync(`${assets}/${file}`, "r");
	const chunk = Buffer.alloc(64 * 1024 * 1024);
	try {
		for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) {
			hash.update(chunk.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
};
manifest.checksums.kernel = checksum(manifest.assets.kernel);
manifest.checksums.initramfs = checksum(manifest.assets.initramfs);
manifest.checksums.rootfs = checksum(manifest.assets.rootfs);
manifest.checksums.krunKernel = checksum(manifest.assets.krunKernel);
manifest.checksums.krunInitrd = checksum(manifest.assets.krunInitrd);

const namespace = Buffer.from("7b6ed0c07e7f4c2a8b2d0bf3d5be9d52", "hex");
const buildName = [
	"gondolin-asset-build",
	`kernel=${manifest.checksums.kernel}`,
	`initramfs=${manifest.checksums.initramfs}`,
	`rootfs=${manifest.checksums.rootfs}`,
	`krunKernel=${manifest.checksums.krunKernel}`,
	`krunInitrd=${manifest.checksums.krunInitrd}`,
	"arch=x86_64",
].join("\n");
const bytes = createHash("sha1").update(namespace).update(buildName).digest().subarray(0, 16);
bytes[6] = (bytes[6] & 0x0f) | 0x50;
bytes[8] = (bytes[8] & 0x3f) | 0x80;
const hex = bytes.toString("hex");
manifest.buildId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`patched ${manifest.buildId}: ${statSync(elfKernel).size} byte ELF kernel and ${initrd.length} byte initrd`);
