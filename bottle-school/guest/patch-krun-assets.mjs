import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, reseal } from "./assets.mjs";

const [assetDirectory, vmlinux] = process.argv.slice(2);
if (!assetDirectory || !vmlinux) throw new Error("usage: node patch-krun-assets.mjs <asset-directory> <vmlinux>");

const assets = resolve(assetDirectory);
const elfKernel = resolve(vmlinux);
const elfMagic = readFileSync(elfKernel).subarray(0, 4).toString("hex");
if (elfMagic !== "7f454c46") throw new Error(`${elfKernel} is not an ELF kernel`);

const manifest = readManifest(assets);
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

const buildId = reseal(assets, manifest);
console.log(`patched ${buildId}: ${statSync(elfKernel).size} byte ELF kernel and ${initrd.length} byte initrd`);
