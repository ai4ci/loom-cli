#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

// Safely locate paths regardless of where the command is executed from
const rootDir = process.cwd();
const pkgPath = path.join(rootDir, "package.json");
const cliPath = path.join(rootDir, "src", "cli.ts");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version;

let src = fs.readFileSync(cliPath, "utf8");

// Matches: const LOOM_VERSION = "anything"; or LOOM_VERSION = 'anything';
const regex = /(LOOM_VERSION\s*=\s*["'`])[^"'`]*(["'`])/;

if (regex.test(src)) {
  src = src.replace(regex, `$1${version}$2`);
  fs.writeFileSync(cliPath, src);
  console.log(`✅ Successfully stamped version ${version} into src/cli.ts`);
} else {
  console.error("❌ Error: Could not find LOOM_VERSION literal in src/cli.ts");
  process.exit(1);
}
