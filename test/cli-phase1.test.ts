import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { MODEL } from "./fixtures.ts";

function repo(extra: Record<string, string> = {}): string {
  return makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": MODEL,
    "design/issue/first.md": instance(
      "class: issue\nid: first.md\ntitle: The thing\ncreated: 2026-01-05\nstatus: open\ntags: [a]",
    ),
    ...extra,
  });
}

test("model check passes on a clean model", async () => {
  const r = await run(["--cwd", repo(), "model", "check"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.errors, 0);
});

test("model check reports errors and exits 1", async () => {
  const root = repo();
  writeFileSync(
    path.join(root, "design/document-model.mmd"),
    "classDiagram\n    class a {\n        +Nonsense x\n    }\n",
  );
  const r = await run(["--cwd", root, "model", "check"]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.ok, false);
  assert.ok(out.diagnostics.some((d: any) => d.code === "model/unknown-type"));
});

test("model check can validate a proposed model without installing it", async () => {
  const root = repo();
  const proposed = path.join(root, "proposed.mmd");
  writeFileSync(proposed, "classDiagram\n    class a\n    class a\n");
  const r = await run(["--cwd", root, "model", "check", "--model", proposed]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as Record<string, any>;
  assert.ok(out.diagnostics.some((d: any) => d.code === "model/duplicate-class"));
});

test("validate passes a well-formed instance", async () => {
  const r = await run(["--cwd", repo(), "validate", "issue://first.md"]);
  assert.equal(r.code, 0);
  assert.equal((parse(r.out) as Record<string, unknown>).ok, true);
});

test("validate reports a bad instance and exits 1", async () => {
  const root = repo({
    "design/issue/bad.md": instance("class: issue\nid: bad.md\ntitle: x\ncreated: 2026-01-05\nstatus: pending\ntags: []"),
  });
  const r = await run(["--cwd", root, "validate", "issue://bad.md"]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as Record<string, any>;
  assert.ok(out.diagnostics.some((d: any) => d.code === "instance/invalid-enum-value"));
});

test("warnings alone do not fail the run", async () => {
  const root = repo();
  writeFileSync(
    path.join(root, "design/document-model.mmd"),
    "classDiagram\n    %% @path issue /design/issue\n    class issue { +string title }\n    class decision { +string title }\n    issue --> decision : rel\n",
  );
  const r = await run(["--cwd", root, "model", "check"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.errors, 0);
  assert.ok(out.warnings >= 1);
});
