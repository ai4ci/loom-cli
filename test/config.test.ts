import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classRootsFor, configFrom, loadConfig } from "../src/config.ts";

test("configFrom applies defaults", () => {
  const cfg = configFrom("/repo", {});
  assert.equal(cfg.designRoot, "design");
  assert.deepEqual(cfg.classRoots, {});
  assert.deepEqual(cfg.languages, []);
});

test("classRootsFor falls back to designRoot/<class>", () => {
  const cfg = configFrom("/repo", { designRoot: "docs" });
  assert.deepEqual(classRootsFor(cfg, "issue"), ["docs/issue"]);
});

test("classRootsFor accepts a single root or a list", () => {
  const cfg = configFrom("/repo", { classRoots: { issue: "design/issues", src: ["src", "R"] } });
  assert.deepEqual(classRootsFor(cfg, "issue"), ["design/issues"]);
  assert.deepEqual(classRootsFor(cfg, "src"), ["src", "R"]);
});

test("reserved schemes are not classes", () => {
  const cfg = configFrom("/repo", {});
  for (const reserved of ["repo", "design"]) {
    assert.throws(() => classRootsFor(cfg, reserved), /reserved/i);
  }
});

test("loadConfig finds .loom.yaml by walking up", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dd-"));
  writeFileSync(path.join(root, ".loom.yaml"), "designRoot: docs\nclassRoots:\n  issue: docs/issues\n");
  const nested = path.join(root, "a", "b");
  mkdirSync(nested, { recursive: true });

  const cfg = loadConfig(nested);
  assert.equal(cfg.repoRoot, root);
  assert.equal(cfg.designRoot, "docs");
  assert.deepEqual(classRootsFor(cfg, "issue"), ["docs/issues"]);
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
