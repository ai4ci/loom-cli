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

test("an ambiguous anchor is an error, not a silent first match", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#run]"),
    "src/app.ts": "export class Alpha { run() {} }\nexport class Beta { run() {} }\n",
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const d = (parse(r.out) as any).diagnostics.find((x: any) => x.code === "source/ambiguous-anchor");
  assert.ok(d, "expected an ambiguity diagnostic");
  assert.match(d.fix, /Alpha\.run/);
  assert.match(d.fix, /Beta\.run/);
});

test("resolve refuses an ambiguous anchor", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "src/app.ts": "export class Alpha { run() {} }\nexport class Beta { run() {} }\n",
  });
  const r = await run(["--cwd", root, "resolve", "src://app.ts#run"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /source\/ambiguous-anchor/);
});

test("a dotted anchor disambiguates through the cli", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "src/app.ts": "export class Alpha { run() {} }\nexport class Beta { run() {} }\n",
  });
  const r = await run(["--cwd", root, "resolve", "src://app.ts#Beta.run"]);
  assert.equal(r.code, 0);
  assert.equal((parse(r.out) as any).line, 2);
});

test("a renamed symbol suggests the nearest candidate", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#runApp]"),
    "src/app.ts": "export function runApplication() {}\n",
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const d = (parse(r.out) as any).diagnostics.find((x: any) => x.code === "graph/missing-symbol");
  assert.match(d.fix, /runApplication/);
});

test("the anchor policy is configurable", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\nsource:\n  anchorKinds: [Class]\n",
    "design/document-model.mmd": MODEL_WITH_SRC,
    "src/app.ts": "export class Alpha { run() {} }\n",
  });
  // Only Class is addressable, so the method is not an anchor at all.
  assert.equal((await run(["--cwd", root, "resolve", "src://app.ts#Alpha"])).code, 0);
  const r = await run(["--cwd", root, "resolve", "src://app.ts#run"]);
  assert.equal((parse(r.out) as any).line, undefined, "run must not resolve under this policy");
});
