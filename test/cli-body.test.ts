import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

// The block loom itself would render for the `decided-by` relation below, so a
// body edit has nothing legitimate to change about it.
const LINKS = "<!-- loom:links start -->\n- decided-by: [D1](../decision/d1.md)\n<!-- loom:links end -->";

function repo(files: Record<string, string> = {}): string {
  return makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": GRAPH_MODEL,
    "design/decision/d1.md": instance("class: decision\ntitle: D1"),
    "design/issue/a.md": instance(
      "class: issue\ntitle: A\nstatus: open\ndecided-by: decision://d1.md",
      `\n${LINKS}\n\nAlpha\nBravo\nCharlie\n`,
    ),
    ...files,
  });
}

const read = (root: string, rel = "design/issue/a.md") =>
  readFileSync(path.join(root, rel), "utf8");

async function body(root: string, args: string[]): Promise<ReturnType<typeof run>> {
  return run(["--cwd", root, "body", ...args]);
}

test("body get returns the prose without the protected link block", async () => {
  const root = repo();
  const result = await body(root, ["get", "issue://a.md"]);
  assert.equal(result.code, 0, result.err);
  const value = parse(result.out) as { body: string };
  assert.equal(value.body, "Alpha\nBravo\nCharlie\n");
});

test("body get translates relative links into design uris", async () => {
  const root = repo({
    "design/issue/a.md": instance(
      "class: issue\ntitle: A\nstatus: open",
      "\nSee [D1](../decision/d1.md).\n\n",
    ),
  });
  const result = await body(root, ["get", "issue://a.md"]);
  assert.equal(result.code, 0, result.err);
  const value = parse(result.out) as { body: string };
  assert.match(value.body, /\[D1\]\(decision:\/\/d1\.md\)/);
});

test("body set replaces the prose and leaves frontmatter and links alone", async () => {
  const root = repo();
  const result = await body(root, ["set", "issue://a.md", "Replaced.\n"]);
  assert.equal(result.code, 0, result.err);

  const text = read(root);
  assert.match(text, /^---\nclass: issue\ntitle: A\nstatus: open\ndecided-by: decision:\/\/d1\.md\n---\n/);
  assert.match(text, /<!-- loom:links start -->\n- decided-by: \[D1\]\(\.\.\/decision\/d1\.md\)\n<!-- loom:links end -->/);
  assert.match(text, /Replaced\./);
  assert.doesNotMatch(text, /Bravo/);
});

test("body set writes design uris to disk as relative markdown links", async () => {
  const root = repo();
  const result = await body(root, ["set", "issue://a.md", "See [D1](decision://d1.md).\n"]);
  assert.equal(result.code, 0, result.err);
  assert.match(read(root), /See \[D1\]\(\.\.\/decision\/d1\.md\)\./);
});

test("body set round-trips through body get", async () => {
  const root = repo();
  const written = "See [D1](decision://d1.md).\n";
  assert.equal((await body(root, ["set", "issue://a.md", written])).code, 0);
  const value = parse((await body(root, ["get", "issue://a.md"])).out) as { body: string };
  assert.equal(value.body, written);
});

test("body append adds to the end of the prose", async () => {
  const root = repo();
  const result = await body(root, ["append", "issue://a.md", "Delta\n"]);
  assert.equal(result.code, 0, result.err);
  const value = parse((await body(root, ["get", "issue://a.md"])).out) as { body: string };
  assert.equal(value.body, "Alpha\nBravo\nCharlie\nDelta\n");
});

test("body patch applies a unified diff to the prose", async () => {
  const root = repo();
  const diff = "@@ -1,3 +1,3 @@\n Alpha\n-Bravo\n+Bravissimo\n Charlie\n";
  const result = await body(root, ["patch", "issue://a.md", diff]);
  assert.equal(result.code, 0, result.err);
  const value = parse((await body(root, ["get", "issue://a.md"])).out) as { body: string };
  assert.equal(value.body, "Alpha\nBravissimo\nCharlie\n");
});

test("body patch fails without writing when the context does not match", async () => {
  const root = repo();
  const before = read(root);
  const diff = "@@ -1,3 +1,3 @@\n Alpha\n-Nope\n+Yes\n Charlie\n";
  const result = await body(root, ["patch", "issue://a.md", diff]);
  assert.notEqual(result.code, 0);
  assert.equal(read(root), before);
});

test("a body edit never disturbs the protected block's own links", async () => {
  const root = repo();
  assert.equal((await body(root, ["set", "issue://a.md", "Nothing to see.\n"])).code, 0);
  assert.match(read(root), /- decided-by: \[D1\]\(\.\.\/decision\/d1\.md\)/);
});

test("body get rejects a uri with no instance file", async () => {
  const root = repo();
  const result = await body(root, ["get", "issue://missing.md"]);
  assert.notEqual(result.code, 0);
});

test("body set --dry-run reports the diff without writing", async () => {
  const root = repo();
  const before = read(root);
  const result = await body(root, ["set", "issue://a.md", "Replaced.\n", "--dry-run"]);
  assert.equal(result.code, 0, result.err);
  assert.equal(read(root), before);
  assert.match(result.out, /Replaced\./);
});

test("prefetch takes the languages to fetch on the command line", async () => {
  const root = repo();
  const result = await run(["--cwd", root, "prefetch", "java"]);
  assert.equal(result.code, 0, result.err);
  const value = parse(result.out) as { prefetched: string[] };
  assert.deepEqual(value.prefetched, ["java"]);
});

test("prefetch accepts several languages", async () => {
  const root = repo();
  const result = await run(["--cwd", root, "prefetch", "python", "r"]);
  assert.equal(result.code, 0, result.err);
  const value = parse(result.out) as { prefetched: string[] };
  assert.deepEqual(value.prefetched, ["python", "r"]);
});

test("prefetch with no language named is an error, not a hidden default set", async () => {
  const root = repo();
  const result = await run(["--cwd", root, "prefetch"]);
  assert.notEqual(result.code, 0);
});
