import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL_WITH_SRC = `classDiagram
    class issue {
        +string title
    }

    issue "1" --> "0..*" src : implemented-by
`;

function repo(): string {
  return makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src, R]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "design/issue/one.md": instance(
      "class: issue\ntitle: One\nimplemented-by: [src://app.ts#runApp, src://model.R#fitModel]",
    ),
    "src/app.ts": `
export function runApp() {
  console.log("running");
}
`,
    "R/model.R": `
# implemented-by: issue://one.md
fitModel <- function(data) {
  data
}
`,
  });
}

test("resolve resolves src:// with anchor to line number", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "resolve", "src://app.ts#runApp"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.equal(out.path, "src/app.ts");
  assert.equal(out.anchor, "runApp");
  assert.equal(out.line, 2);
});

test("resolve resolves R function with anchor across multi-root to line number", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "resolve", "src://model.R#fitModel"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.equal(out.path, "R/model.R");
  assert.equal(out.anchor, "fitModel");
  assert.equal(out.line, 3);
});

test("validate catches missing symbol in source code", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#missing]"),
    "src/app.ts": "export function exists() {}",
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as any;
  assert.ok(out.diagnostics.some((d: any) => d.code === "graph/missing-symbol"));
});

test("validate catches dangling reverse link comment in source file", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/app.ts": `
// implemented-by: issue://does-not-exist.md
export function foo() {}
`,
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as any;
  assert.ok(out.diagnostics.some((d: any) => d.code === "source/dangling-reverse-link"));
});

test("refs command identifies design documents referencing a source function", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "refs", "src://app.ts#runApp"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.references, [{ from: "issue://one.md", relation: "implemented-by" }]);
});

test("prefetch command downloads/warms grammars", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "prefetch"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.ok(out.prefetched.length > 0);
});
