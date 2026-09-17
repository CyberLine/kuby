#!/usr/bin/env node
// Build Tauri updater latest.json from GitHub Release assets + downloaded .sig files.
// Platform jobs upload binaries and signatures only; this is the single writer.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [releaseJsonPath, sigDir, outPath] = process.argv.slice(2);
if (!releaseJsonPath || !sigDir || !outPath) {
	console.error(
		"usage: generate-latest-json.mjs <release.json> <sig-dir> <latest.json>",
	);
	process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
	fail("GITHUB_REF_NAME is required");
}
const version = tag.replace(/^v/, "");

const release = JSON.parse(readFileSync(releaseJsonPath, "utf8"));
const assets = Array.isArray(release.assets) ? release.assets : [];
const files = assets.map((asset) => asset.name).filter((name) => !name.endsWith(".sig"));
const byName = new Map(assets.map((asset) => [asset.name, asset]));

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

function unique(predicate, label) {
	const matches = files.filter(predicate);
	if (matches.length !== 1) {
		fail(
			`${label}: expected 1 asset, got ${matches.length}${
				matches.length ? ` (${matches.join(", ")})` : ""
			}`,
		);
	}
	return matches[0];
}

function entry(name) {
	const asset = byName.get(name);
	if (!asset) {
		fail(`missing release asset ${name}`);
	}
	const sigPath = join(sigDir, `${name}.sig`);
	if (!existsSync(sigPath)) {
		fail(`missing signature file ${name}.sig`);
	}
	if (!asset.url) {
		fail(`asset ${name} has no download URL`);
	}
	return {
		signature: readFileSync(sigPath, "utf8").replace(/\s+/g, ""),
		url: asset.url,
	};
}

const appImage = unique((name) => name.endsWith(".AppImage"), "Linux AppImage");
const deb = unique((name) => name.endsWith(".deb"), "Linux .deb");
const rpm = unique((name) => name.endsWith(".rpm"), "Linux .rpm");
const appTar = unique(
	(name) => name.endsWith(".app.tar.gz"),
	"macOS updater archive",
);
const nsisZip = files.find((name) => name.endsWith(".nsis.zip"));
const setupExe = files.find((name) => /setup\.exe$/i.test(name));
const windowsUpdater = nsisZip ?? setupExe;
if (!windowsUpdater) {
	fail("missing Windows updater (.nsis.zip or setup.exe)");
}

const appImageEntry = entry(appImage);
const darwinEntry = entry(appTar);
const platforms = {
	"linux-x86_64": appImageEntry,
	"linux-x86_64-appimage": appImageEntry,
	"linux-x86_64-deb": entry(deb),
	"linux-x86_64-rpm": entry(rpm),
	"windows-x86_64": entry(windowsUpdater),
	"darwin-aarch64": darwinEntry,
	"darwin-x86_64": darwinEntry,
	"darwin-universal": darwinEntry,
};

const required = [
	"linux-x86_64",
	"windows-x86_64",
	"darwin-aarch64",
	"darwin-x86_64",
	"darwin-universal",
];
const missing = required.filter(
	(key) => !platforms[key]?.url || !platforms[key]?.signature,
);
if (missing.length) {
	fail(`latest.json missing platforms: ${missing.join(", ")}`);
}

const json = {
	version,
	notes: release.body ?? "",
	pub_date: release.createdAt ?? new Date().toISOString(),
	platforms,
};

writeFileSync(outPath, `${JSON.stringify(json, null, 2)}\n`);

for (const [key, value] of Object.entries(platforms)) {
	console.log(`${key}\t${value.url}`);
}
