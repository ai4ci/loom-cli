import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configFrom, loadConfig, findModelFiles, designRootFrom } from "../src/config.ts";
import { describe } from "node:test";

test("configFrom applies defaults", () => {
  const cfg = configFrom("/repo", {});
  assert.equal(cfg.designRoot, "design");
  assert.equal(cfg.configPath, null);
});

test("configFrom honours overrides", () => {
  const cfg = configFrom("/repo", {
    designRoot: "docs/",
    source: { anchorKinds: ["function_definition"], transparentKinds: [] },
  });
  assert.equal(cfg.designRoot, "docs");
  assert.deepEqual(cfg.anchorPolicy.anchorKinds, ["function_definition"]);
});

test("loadConfig finds .loom.yaml by walking up", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dd-"));
  writeFileSync(path.join(root, ".loom.yaml"), "designRoot: docs\n");
  const nested = path.join(root, "a", "b");
  mkdirSync(nested, { recursive: true });

  const cfg = loadConfig(nested);
  assert.equal(cfg.repoRoot, root);
  assert.equal(cfg.designRoot, "docs");
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

describe("findModelFiles", () => {
  test("returns empty when no model file exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "readme.md"), "");
    assert.deepEqual(findModelFiles(root), []);
  });

  test("finds a single document-model.mmd", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    const dir = path.join(root, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "document-model.mmd"), "classDiagram\n");
    const found = findModelFiles(root);
    assert.equal(found.length, 1);
    assert.ok(found[0]!.endsWith("docs/document-model.mmd"));
  });

  test("skips .git and node_modules", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    writeFileSync(path.join(root, "document-model.mmd"), "classDiagram\n");
    mkdirSync(path.join(root, ".git", "docs"), { recursive: true });
    writeFileSync(path.join(root, ".git", "docs", "document-model.mmd"), "classDiagram\n");
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "pkg", "document-model.mmd"), "classDiagram\n");
    const found = findModelFiles(root);
    assert.equal(found.length, 1);
    assert.ok(found[0]!.endsWith("/document-model.mmd"));
  });

  test("finds multiple model files when they exist", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    mkdirSync(path.join(root, "a"), { recursive: true });
    mkdirSync(path.join(root, "b"), { recursive: true });
    writeFileSync(path.join(root, "a", "document-model.mmd"), "classDiagram\n");
    writeFileSync(path.join(root, "b", "document-model.mmd"), "classDiagram\n");
    assert.equal(findModelFiles(root).length, 2);
  });
});

describe("designRootFrom", () => {
  test("uses raw.designRoot when present", () => {
    assert.equal(designRootFrom({ designRoot: "docs" }, "/repo"), "docs");
  });

  test("falls back to 'design' when nothing else resolves", () => {
    assert.equal(designRootFrom({}, "/nonexistent"), "design");
  });

  test("discovers the model file parent directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    mkdirSync(path.join(root, "gtd"), { recursive: true });
    writeFileSync(path.join(root, "gtd", "document-model.mmd"), "classDiagram\n");
    assert.equal(designRootFrom({}, root), "gtd");
  });
});

describe("loadConfig with model discovery", () => {
  test("discovers designRoot from document-model.mmd when .loom.yaml has no designRoot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "document-model.mmd"), "classDiagram\n");
    mkdirSync(path.join(root, ".git"));
    const cfg = loadConfig(root);
    assert.equal(cfg.designRoot, "docs");
  });

  test(".loom.yaml designRoot takes precedence over discovery", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dd-"));
    mkdirSync(path.join(root, "gtd"), { recursive: true });
    writeFileSync(path.join(root, "gtd", "document-model.mmd"), "classDiagram\n");
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".loom.yaml"), "designRoot: custom\n");
    const cfg = loadConfig(root);
    assert.equal(cfg.designRoot, "custom");
  });

  test("LOOM_DEFAULT_ROOT env var takes precedence over discovery", () => {
    const prev = process.env["LOOM_DEFAULT_ROOT"];
    process.env["LOOM_DEFAULT_ROOT"] = "env-docs";
    try {
      const root = mkdtempSync(path.join(tmpdir(), "dd-"));
      mkdirSync(path.join(root, "docs"), { recursive: true });
      writeFileSync(path.join(root, "docs", "document-model.mmd"), "classDiagram\n");
      mkdirSync(path.join(root, ".git"));
      const cfg = loadConfig(root);
      assert.equal(cfg.designRoot, "env-docs");
    } finally {
      if (prev === undefined) delete process.env["LOOM_DEFAULT_ROOT"];
      else process.env["LOOM_DEFAULT_ROOT"] = prev;
    }
  });
});
