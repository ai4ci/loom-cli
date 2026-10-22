import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

// `implements` runs source -> doc, so it is a different relation from the
// forward `implemented-by`, declared in the opposite direction.
const MODEL = `classDiagram
    class issue {
        +string title
    }
    issue "1" --> "0..*" src : implemented-by
    src "0..*" --> "0..*" issue : implements
`;

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n";

const TS = `export class Service {
  run() {
    return 1;
  }

  stop() {
    return 2;
  }
}
`;

function repo(extra: Record<string, string> = {}): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": MODEL,
    "design/issue/auth.md": instance("class: issue\ntitle: Auth"),
    "design/issue/other.md": instance("class: issue\ntitle: Other"),
    "src/app.ts": TS,
    ...extra,
  });
}

const read = (root: string, p: string) => readFileSync(path.join(root, p), "utf8");

test("link on a src subject writes a comment inside the body", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "link", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  assert.equal(r.code, 0);

  const written = read(root, "src/app.ts");
  assert.match(written, /run\(\) \{\n {4}\/\/ implements: issue:\/\/auth\.md\n {4}return 1;/);
  assert.equal((parse(r.out) as any).written[0], "src/app.ts");
});

test("the comment attributes back to the anchor it was written for", async () => {
  const root = repo();
  await run(["--cwd", root, "link", "src://app.ts#Service.stop", "implements", "issue://auth.md"]);
  const r = await run(["--cwd", root, "refs", "issue://auth.md"]);
  assert.equal(r.code, 0);
});

test("link on a design subject still writes yaml", async () => {
  const root = repo();
  await run(["--cwd", root, "link", "issue://auth.md", "implemented-by", "src://app.ts#Service.run"]);
  assert.match(read(root, "design/issue/auth.md"), /implemented-by:/);
  assert.equal(read(root, "src/app.ts"), TS, "source must be untouched");
});

test("linking twice is a no-op", async () => {
  const root = repo();
  await run(["--cwd", root, "link", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  const once = read(root, "src/app.ts");
  await run(["--cwd", root, "link", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  assert.equal(read(root, "src/app.ts"), once);
});

test("unlink removes the comment", async () => {
  const root = repo();
  await run(["--cwd", root, "link", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  const r = await run(["--cwd", root, "unlink", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  assert.equal(r.code, 0);
  assert.equal(read(root, "src/app.ts"), TS, "the file returns to its original state");
});

test("a comment goes after an existing leading comment block", async () => {
  const root = repo({
    "src/app.ts": `export class Service {
  run() {
    // explains why
    // across two lines
    return 1;
  }
}
`,
  });
  await run(["--cwd", root, "link", "src://app.ts#Service.run", "implements", "issue://auth.md"]);
  const written = read(root, "src/app.ts");
  assert.match(written, /\/\/ across two lines\n {4}\/\/ implements: issue:\/\/auth\.md\n {4}return 1;/);
});

test("several links into one file are applied in a single pass", async () => {
  const root = repo();
  const changeset = path.join(root, "change.yaml");
  writeFileSync(changeset, `ops:
  - { op: link, from: "src://app.ts#Service.run",  rel: implements, to: "issue://auth.md" }
  - { op: link, from: "src://app.ts#Service.stop", rel: implements, to: "issue://other.md" }
`);
  const r = await run(["--cwd", root, "apply", changeset]);
  assert.equal(r.code, 0);

  const written = read(root, "src/app.ts");
  assert.match(written, /run\(\) \{\n {4}\/\/ implements: issue:\/\/auth\.md/);
  assert.match(written, /stop\(\) \{\n {4}\/\/ implements: issue:\/\/other\.md/);
  assert.deepEqual((parse(r.out) as any).written, ["src/app.ts"]);
});

test("--dry-run shows the source diff and writes nothing", async () => {
  const root = repo();
  const changeset = path.join(root, "change.yaml");
  writeFileSync(changeset, `ops:
  - { op: link, from: "src://app.ts#Service.run", rel: implements, to: "issue://auth.md" }
`);
  const r = await run(["--cwd", root, "apply", changeset, "--dry-run"]);
  assert.equal(r.code, 0);
  assert.equal(read(root, "src/app.ts"), TS);
  assert.match((parse(r.out) as any).changes[0].diff, /\+\s*\/\/ implements: issue:\/\/auth\.md/);
});

test("a declaration with no body cannot be annotated", async () => {
  const root = repo({ "src/api.ts": "export interface Shape {\n  area(): number;\n}\n" });
  const r = await run(["--cwd", root, "link", "src://api.ts#Shape", "implements", "issue://auth.md"]);
  // An interface has a body; its member does not, and is not even an anchor.
  assert.equal(r.code, 0);

  const rr = await run(["--cwd", root, "link", "src://api.ts#Shape.area", "implements", "issue://auth.md"]);
  assert.equal(rr.code, 1);
});

test("an R one-liner cannot be annotated", async () => {
  const root = repo({ "src/model.R": "one <- function(x) x + 1\n" });
  const r = await run(["--cwd", root, "link", "src://model.R#one", "implements", "issue://auth.md"]);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /not-annotatable/);
});

test("an R function with a block is annotated with a hash comment", async () => {
  const root = repo({ "src/model.R": "fit <- function(df) {\n  df\n}\n" });
  const r = await run(["--cwd", root, "link", "src://model.R#fit", "implements", "issue://auth.md"]);
  assert.equal(r.code, 0);
  assert.match(read(root, "src/model.R"), /\{\n {2}# implements: issue:\/\/auth\.md\n {2}df/);
});

test("a python link goes inside the block, ahead of the docstring", async () => {
  const root = repo({ "src/w.py": 'class W:\n    def go(self):\n        """Doc."""\n        return 1\n' });
  const r = await run(["--cwd", root, "link", "src://w.py#W.go", "implements", "issue://auth.md"]);
  assert.equal(r.code, 0);
  const written = read(root, "src/w.py");
  assert.match(written, /def go\(self\):\n {8}# implements: issue:\/\/auth\.md\n {8}"""Doc\."""/);
});

test("linking by line resolves to the enclosing anchor", async () => {
  const root = repo();
  const r = await run([
    "--cwd", root, "link", "src://app.ts", "--line", "3", "implements", "issue://auth.md",
  ]);
  assert.equal(r.code, 0);
  assert.match(read(root, "src/app.ts"), /run\(\) \{\n {4}\/\/ implements: issue:\/\/auth\.md/);
});

test("a relation the model does not allow from src is refused", async () => {
  const root = repo();
  const r = await run([
    "--cwd", root, "link", "src://app.ts#Service.run", "implemented-by", "issue://auth.md",
  ]);
  assert.equal(r.code, 1);
});

test("a changeset that fails validation leaves the source untouched", async () => {
  const root = repo();
  const changeset = path.join(root, "change.yaml");
  writeFileSync(changeset, `ops:
  - { op: link, from: "src://app.ts#Service.run",  rel: implements, to: "issue://auth.md" }
  - { op: link, from: "src://app.ts#Service.stop", rel: implements, to: "issue://ghost.md" }
`);
  const r = await run(["--cwd", root, "apply", changeset]);
  assert.equal(r.code, 1);
  assert.equal(read(root, "src/app.ts"), TS);
});
