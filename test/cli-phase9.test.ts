import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    class issue {
        +string title
        +IssueStatus status
    }
    class IssueStatus {
        <<enumeration>>
        open
        closed
    }
    issue "1" --> "0..*" src : implemented-by
`;

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n";

function repo(extra: Record<string, string> = {}): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: Aye\nstatus: open\nimplemented-by: [src://app.ts#Service.run]"),
    "design/issue/b.md": instance("class: issue\ntitle: Bee\nstatus: closed"),
    "src/app.ts": `export class Service {
  run() { return 1; }
  stop() { return 2; }
}

export function free() { return 3; }
`,
    "src/nested/deep.ts": "export function buried() {}\n",
    ...extra,
  });
}

test("ls on a class lists its instances", async () => {
  const r = await run(["--cwd", repo(), "ls", "issue://"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), ["issue://a.md", "issue://b.md"]);
  assert.equal(out.entries.find((e: any) => e.uri === "issue://a.md").title, "Aye");
});

test("ls on a source root lists directories and files", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), ["src://app.ts", "src://nested"]);
  assert.equal(out.entries.find((e: any) => e.uri === "src://nested").kind, "Directory");
});

test("ls on a source file lists its linkable anchors", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://app.ts"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri), [
    "src://app.ts#Service",
    "src://app.ts#free",
  ]);
  const service = out.entries[0];
  assert.equal(service.kind, "Class");
  assert.equal(service.line, 1);
  assert.equal(service.children, 2);
});

test("ls descends into an anchor", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://app.ts#Service"]);
  assert.deepEqual((parse(r.out) as any).entries.map((e: any) => e.uri), [
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
  ]);
});

test("--depth descends further", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://app.ts", "--depth", "2"]);
  assert.deepEqual((parse(r.out) as any).entries.map((e: any) => e.uri), [
    "src://app.ts#Service",
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
    "src://app.ts#free",
  ]);
});

test("--kind narrows to given structure kinds", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://app.ts", "--depth", "2", "--kind", "Method"]);
  assert.deepEqual((parse(r.out) as any).entries.map((e: any) => e.uri), [
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
  ]);
});

test("--linked and --unlinked filter by existing references", async () => {
  const root = repo();
  const linked = await run(["--cwd", root, "ls", "src://app.ts", "--depth", "2", "--linked"]);
  assert.deepEqual((parse(linked.out) as any).entries.map((e: any) => e.uri), [
    "src://app.ts#Service.run",
  ]);

  const unlinked = await run(["--cwd", root, "ls", "src://app.ts", "--depth", "2", "--unlinked"]);
  const uris = (parse(unlinked.out) as any).entries.map((e: any) => e.uri);
  assert.equal(uris.includes("src://app.ts#Service.run"), false);
  assert.ok(uris.includes("src://app.ts#free"));
});

test("ls reports whether each anchor is already linked", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://app.ts#Service"]);
  const entries = (parse(r.out) as any).entries;
  assert.equal(entries.find((e: any) => e.uri.endsWith("#Service.run")).linked, true);
  assert.equal(entries.find((e: any) => e.uri.endsWith("#Service.stop")).linked, false);
});

test("ls on a missing path fails cleanly", async () => {
  const r = await run(["--cwd", repo(), "ls", "src://ghost.ts"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not-found/);
});

// --- locate ----------------------------------------------------------------

test("locate returns the innermost linkable ancestor of a line", async () => {
  const r = await run(["--cwd", repo(), "locate", "src://app.ts", "--line", "2"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.equal(out.anchor.uri, "src://app.ts#Service.run");
  assert.equal(out.anchor.kind, "Method");
  assert.deepEqual(out.ancestors.map((a: any) => a.uri), [
    "src://app.ts#Service",
    "src://app.ts",
  ]);
});

test("locate on a line with no linkable ancestor returns the file", async () => {
  const root = repo({ "src/plain.ts": "import { x } from './x';\n\nexport function f() {}\n" });
  const r = await run(["--cwd", root, "locate", "src://plain.ts", "--line", "1"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.equal(out.anchor, null);
  assert.deepEqual(out.ancestors.map((a: any) => a.uri), ["src://plain.ts"]);
});

test("locate reports the outermost class for a line in its body but outside a method", async () => {
  const r = await run(["--cwd", repo(), "locate", "src://app.ts", "--line", "1"]);
  assert.equal((parse(r.out) as any).anchor.uri, "src://app.ts#Service");
});

test("locate requires a line", async () => {
  const r = await run(["--cwd", repo(), "locate", "src://app.ts"]);
  assert.notEqual(r.code, 0);
});
