import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";

/** Reads a Gondolin asset directory's manifest. */
export const readManifest = (assets) => JSON.parse(readFileSync(`${assets}/manifest.json`, "utf8"));

// Stream in chunks: the v5 rootfs exceeds Node's 2 GiB readFileSync limit.
const checksum = (assets, file) => {
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

/**
 * Recomputes every asset checksum and Gondolin's content-derived build id after a post-build patch, then writes the
 * manifest, so `gondolin build --verify` and `image import` accept the modified assets.
 */
export const reseal = (assets, manifest) => {
	const names = ["kernel", "initramfs", "rootfs", "krunKernel", "krunInitrd"].filter((name) => manifest.assets?.[name]);
	for (const name of names) manifest.checksums[name] = checksum(assets, manifest.assets[name]);
	const namespace = Buffer.from("7b6ed0c07e7f4c2a8b2d0bf3d5be9d52", "hex");
	const buildName = [
		"gondolin-asset-build",
		...names.map((name) => `${name}=${manifest.checksums[name]}`),
		`arch=${manifest.config.arch}`,
	].join("\n");
	const bytes = createHash("sha1").update(namespace).update(buildName).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	manifest.buildId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	writeFileSync(`${assets}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest.buildId;
};
