#!/usr/bin/env node
// Reads the version from package.json and stamps it into src/cli.ts
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;
let src = fs.readFileSync("src/cli.ts", "utf8");
src = src.replace(
  /(LOOM_VERSION = )"[^"]*"/,
  '$1"' + version + '"',
);
fs.writeFileSync("src/cli.ts", src);
