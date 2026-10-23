import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configFrom, loadConfig } from "../src/config.ts";

test("configFrom applies defaults", () => {
  const cfg = configFrom("/repo", {});
  assert.equal(cfg.designRoot, "design");
  assert.deepEqual(cfg.languages, []);
  assert.equal(cfg.configPath, null);
});

test("configFrom honours overrides", () => {
  const cfg = configFrom("/repo", {
    designRoot: "docs/",
    languages: ["r", "python"],
    source: { anchorKinds: ["function_definition"], transparentKinds: [] },
  });
  assert.equal(cfg.designRoot, "docs");
  assert.deepEqual(cfg.languages, ["r", "python"]);
  assert.deepEqual(cfg.anchorPolicy.anchorKinds, ["function_definition"]);
});

test("loadConfig finds .loom.yaml by walking up", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dd-"));
  writeFileSync(path.join(root, ".loom.yaml"), "designRoot: docs\nlanguages: [r]\n");
  const nested = path.join(root, "a", "b");
  mkdirSync(nested, { recursive: true });

  const cfg = loadConfig(nested);
  assert.equal(cfg.repoRoot, root);
  assert.equal(cfg.designRoot, "docs");
  assert.deepEqual(cfg.languages, ["r"]);
  assert.equal(cfg.configPath, path.join(root, ".loom.yaml"));
});

test("loadConfig falls back to the git root when there is no config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dd-"));
  mkdirSync(path.join(root, ".git"));
  const nested = path.join(root, "a");
  mkdirSync(nested, { recursive: true });

  const cfg = loadConfig(nested);
  assert.equal(cfg.repoRoot, root);
  assert.equal(cfg.designRoot, "design");
  assert.equal(cfg.configPath, null);
});
