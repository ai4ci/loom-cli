import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    class issue {
        +string title
    }
    class decision {
        +string title
    }
    %% @path issue issues
    %% @path src src
`;

const CONFIG = "designRoot: design\n";

function repo(): string {
  return makeRepo({
    ".loom.yaml": CONFIG,
    "design/document-model.mmd": MODEL,
    "issues/one.md": instance("class: issue\ntitle: One"),
    "issues/two.md": instance("class: issue\ntitle: Two"),
    "src/app.ts": `export class Service {
  run() { return 1; }
  stop() { return 2; }
}

export function free() { return 3; }
`,
    "src/util/helpers.ts": `export function add(a: number, b: number) { return a + b; }

export class Helper {
  greet(name: string) { return "hi " + name; }
}
`,
    "src/util/deep/tool.ts": `export function drill() { return 42; }
`,
  });
}

test("find on a source root defaults to unlimited depth", async () => {
  const r = await run(["--cwd", repo(), "find", "src://"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  const uris = out.entries.map((e: any) => e.uri).sort();
  assert.deepEqual(uris, [
    "src://app.ts",
    "src://app.ts#Service",
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
    "src://app.ts#free",
    "src://util",
    "src://util/deep",
    "src://util/deep/tool.ts",
    "src://util/deep/tool.ts#drill",
    "src://util/helpers.ts",
    "src://util/helpers.ts#Helper",
    "src://util/helpers.ts#Helper.greet",
    "src://util/helpers.ts#add",
  ]);
});

test("find --depth 1 shows children only (like ls)", async () => {
  const r = await run(["--cwd", repo(), "find", "src://", "--depth", "1"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), [
    "src://app.ts",
    "src://util",
  ]);
});

test("find --depth 2 drills one level into files and dirs", async () => {
  const r = await run(["--cwd", repo(), "find", "src://", "--depth", "2"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), [
    "src://app.ts",
    "src://app.ts#Service",
    "src://app.ts#free",
    "src://util",
    "src://util/deep",
    "src://util/helpers.ts",
  ]);
});

test("find on a file lists its anchors (depth 1 = current ls)", async () => {
  const r = await run(["--cwd", repo(), "find", "src://app.ts", "--depth", "1"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri), [
    "src://app.ts#Service",
    "src://app.ts#free",
  ]);
});

test("find --depth 2 on a file drills into anchor children", async () => {
  const r = await run(["--cwd", repo(), "find", "src://app.ts", "--depth", "2"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri), [
    "src://app.ts#Service",
    "src://app.ts#free",
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
  ]);
});

test("find stops at leaf symbols (classes show their methods, methods stop)", async () => {
  const r = await run(["--cwd", repo(), "find", "src://util/helpers.ts"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri), [
    "src://util/helpers.ts#add",
    "src://util/helpers.ts#Helper",
    "src://util/helpers.ts#Helper.greet",
  ]);
});

test("find on a class lists its instances (no recursion)", async () => {
  const r = await run(["--cwd", repo(), "find", "issue://"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), [
    "issue://one.md",
    "issue://two.md",
  ]);
});

test("find on a non-existent path fails cleanly", async () => {
  const r = await run(["--cwd", repo(), "find", "src://ghost.ts"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not-found/);
});

test("find --kind filters by structure kind", async () => {
  const r = await run(["--cwd", repo(), "find", "src://", "--kind", "Method"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as any;
  assert.deepEqual(out.entries.map((e: any) => e.uri).sort(), [
    "src://app.ts#Service.run",
    "src://app.ts#Service.stop",
    "src://util/helpers.ts#Helper.greet",
  ]);
});
