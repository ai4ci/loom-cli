import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL, MODEL } from "./fixtures.ts";

function repo(extra: Record<string, string> = {}, model = GRAPH_MODEL): string {
  return makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": model,
    "design/issue/a.md": instance("class: issue\ntitle: Aye\nstatus: open"),
    "design/issue/b.md": instance("class: issue\ntitle: Bee\nstatus: open"),
    "design/decision/d1.md": instance("class: decision\ntitle: Dee"),
    ...extra,
  });
}

test("resolve on a bare path names the mistake and the uri to use instead", async () => {
  const r = await run(["--cwd", repo(), "resolve", "design/issue/a.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /issue:a\.md/);
});

test("show on a bare path suggests the same uri", async () => {
  const r = await run(["--cwd", repo(), "show", "design/issue/a.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /issue:a\.md/);
});

test("a mutation subject given as a bare path is caught too", async () => {
  const r = await run(["--cwd", repo(), "set", "design/issue/a.md", "status=closed"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /issue:a\.md/);
});

test("link reports the bare path it could not read", async () => {
  const r = await run(["--cwd", repo(), "link", "design/issue/a.md", "blocks", "issue:b.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /issue:a\.md/);
});

test("a bare path writes nothing", async () => {
  const root = repo();
  const before = await run(["--cwd", root, "show", "issue:a.md"]);
  await run(["--cwd", root, "set", "design/issue/a.md", "status=closed"]);
  const after = await run(["--cwd", root, "show", "issue:a.md"]);
  assert.equal(after.out, before.out);
});

test("an absolute path inside the repository is mapped back to its uri", async () => {
  const root = repo();
  const absolute = path.join(root, "design", "decision", "d1.md");
  const r = await run(["--cwd", root, "resolve", absolute]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /decision:d1\.md/);
});

test("a path under no class root is suggested as a repo uri", async () => {
  const root = repo({ "README.md": "# Readme\n" });
  const r = await run(["--cwd", root, "resolve", "README.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /repo:README\.md/);
});

test("an anchor on a bare source path survives into the suggestion", async () => {
  const root = makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance("class: issue\nstatus: open\ntitle: Aye\ncreated: 2026-01-01"),
    "src/auth.ts": "export function login() {\n  return true;\n}\n",
  });
  const r = await run(["--cwd", root, "resolve", "src/auth.ts#login"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /src:auth\.ts#login/);
});

/**
 * Without a model there is no class to name, so the missing model is the
 * honest first problem to report. Pinned so the suggestion lookup degrading
 * to nothing cannot turn into a crash.
 */
test("a repository with no model reports the missing model, not a crash", async () => {
  const root = makeRepo({ "notes/a.md": "# Notes\n" });
  const r = await run(["--cwd", root, "resolve", "notes/a.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /model\/not-found/);
});

test("a bare path outside every class root still suggests a repo uri", async () => {
  const root = repo({ "notes/a.md": "# Notes\n" });
  const r = await run(["--cwd", root, "resolve", "notes/a.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/bare-path/);
  assert.match(r.err, /repo:notes\/a\.md/);
});

test("a thrown diagnostic prints its fix hint", async () => {
  const r = await run(["--cwd", repo(), "resolve", "design/issue/a.md"]);
  assert.match(r.err, /fix:/);
});

test("a well-formed uri is unaffected", async () => {
  const r = await run(["--cwd", repo(), "resolve", "issue:a.md"]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /bare-path/);
});

test("validate names a bare path written into frontmatter", async () => {
  const root = repo({
    "design/issue/c.md": instance(
      "class: issue\ntitle: Cee\nstatus: open\nblocks: [design/issue/b.md]",
    ),
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /design\/issue\/b\.md/);
  assert.match(r.out, /bare-path|filesystem path/);
});
