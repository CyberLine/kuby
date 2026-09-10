#!/usr/bin/env node
/**
 * Keeps src-tauri/Cargo.toml [package].version in sync with package.json.
 * App version for Tauri itself comes from tauri.conf.json → "../package.json".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: invalid package.json version: ${version}`);
  process.exit(1);
}

const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const next = cargo.replace(
  /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m,
  `$1"${version}"`,
);

if (next === cargo) {
  const current = cargo.match(/^version\s*=\s*"([^"]*)"/m)?.[1];
  if (current === version) {
    console.log(`sync-version: Cargo.toml already at ${version}`);
    process.exit(0);
  }
  console.error("sync-version: could not find [package] version in Cargo.toml");
  process.exit(1);
}

writeFileSync(cargoPath, next);
console.log(`sync-version: Cargo.toml → ${version}`);
