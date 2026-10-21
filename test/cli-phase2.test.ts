import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  decision: design/decision\n";

function repo(files: Record<string, string>): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    ...files,
  });
}

const OPEN = (title: string, extra = "") =>
  instance(`class: issue\ntitle: ${title}\nstatus: open${extra ? `\n${extra}` : ""}`);

test("validate with no uri checks the whole repository", () => {
  const root = repo({ "design/issue/a.md": OPEN("A", "blocks: [issue://b.md]"), "design/issue/b.md": OPEN("B") });
  const r = run(["--cwd", root, "validate"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.ok, true);
  assert.equal(out.instances, 2);
});

test("validate writes a report to the design folder", () => {
  const root = repo({ "design/issue/a.md": OPEN("A", "blocks: [issue://ghost.md]") });
  run(["--cwd", root, "validate"]);
  const report = readFileSync(path.join(root, "design/VALIDATION.md"), "utf8");
  assert.match(report, /graph\/dangling-link/);
  assert.match(report, /generated/i);
});

test("the report is rewritten clean when the problems go away", () => {
  const root = repo({ "design/issue/a.md": OPEN("A", "blocks: [issue://ghost.md]") });
  run(["--cwd", root, "validate"]);
  writeFileSync(path.join(root, "design/issue/a.md"), OPEN("A"));
  const r = run(["--cwd", root, "validate"]);
  assert.equal(r.code, 0);
  const report = readFileSync(path.join(root, "design/VALIDATION.md"), "utf8");
  assert.doesNotMatch(report, /dangling-link/);
});

test("validate exits 1 when the repository has errors", () => {
  const root = repo({ "design/issue/a.md": OPEN("A", "blocks: [issue://ghost.md]") });
  assert.equal(run(["--cwd", root, "validate"]).code, 1);
});

test("--fix repairs a stale link block", () => {
  const root = repo({
    "design/issue/a.md": instance(
      "class: issue\ntitle: A\nstatus: open\nblocks: [issue://b.md]",
      "\n<!-- design-docs:links start -->\n- blocks: [Wrong](zzz.md)\n<!-- design-docs:links end -->\n\nProse.\n",
    ),
    "design/issue/b.md": OPEN("Bee"),
  });

  assert.equal(run(["--cwd", root, "validate"]).code, 1);
  const fixed = run(["--cwd", root, "validate", "--fix"]);
  assert.equal(fixed.code, 0);

  const text = readFileSync(path.join(root, "design/issue/a.md"), "utf8");
  assert.match(text, /- blocks: \[Bee\]\(b\.md\)/);
  assert.match(text, /Prose\./, "unprotected content is untouched");
  assert.equal(run(["--cwd", root, "validate"]).code, 0);
});

test("--fix normalises a non-canonical uri without disturbing comments", () => {
  const root = repo({
    "design/issue/a.md": instance(
      "class: issue\n# keep this comment\ntitle: A\nstatus: open\nblocks: [design://issue/b.md]",
    ),
    "design/issue/b.md": OPEN("B"),
  });

  const fixed = run(["--cwd", root, "validate", "--fix"]);
  assert.equal(fixed.code, 0);
  const text = readFileSync(path.join(root, "design/issue/a.md"), "utf8");
  assert.match(text, /issue:\/\/b\.md/);
  assert.doesNotMatch(text, /design:\/\/issue\/b\.md/);
  assert.match(text, /# keep this comment/);
});

test("--fix leaves judgement calls alone", () => {
  const root = repo({ "design/issue/a.md": OPEN("A", "blocks: [issue://ghost.md]") });
  const r = run(["--cwd", root, "validate", "--fix"]);
  assert.equal(r.code, 1);
  assert.ok((parse(r.out) as Record<string, any>).diagnostics
    .some((d: any) => d.code === "graph/dangling-link"));
});

test("--fix reports what it changed", () => {
  const root = repo({
    "design/issue/a.md": OPEN("A", "blocks: [design://issue/b.md]"),
    "design/issue/b.md": OPEN("B"),
  });
  const r = run(["--cwd", root, "validate", "--fix"]);
  assert.deepEqual((parse(r.out) as Record<string, any>).fixed, ["design/issue/a.md"]);
});

test("validate --model analyses the impact of a proposed model", () => {
  const root = repo({ "design/issue/a.md": OPEN("A") });
  const proposed = path.join(root, "proposed.mmd");
  // Dropping the enumeration makes every existing status value invalid.
  writeFileSync(proposed, `classDiagram
    class issue {
        +string title
        +int status
    }
`);
  const r = run(["--cwd", root, "validate", "--model", proposed]);
  assert.equal(r.code, 1);
  assert.ok((parse(r.out) as Record<string, any>).diagnostics
    .some((d: any) => d.code === "instance/type-mismatch"));
});

test("validate --model does not touch the report file", () => {
  const root = repo({ "design/issue/a.md": OPEN("A") });
  const proposed = path.join(root, "proposed.mmd");
  writeFileSync(proposed, "classDiagram\n    class issue {\n        +string title\n    }\n");
  run(["--cwd", root, "validate", "--model", proposed]);
  assert.throws(() => readFileSync(path.join(root, "design/VALIDATION.md"), "utf8"));
});
