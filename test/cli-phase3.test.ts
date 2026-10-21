import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { parseChangeset } from "../src/changeset.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  decision: design/decision\n";

const OPEN = (title: string, extra = "") =>
  instance(`class: issue\ntitle: ${title}\nstatus: open${extra ? `\n${extra}` : ""}`);

const withLinks = (frontmatter: string, links: string) =>
  instance(frontmatter, `\n<!-- design-docs:links start -->\n${links}\n<!-- design-docs:links end -->\n\nProse.\n`);

function repo(files: Record<string, string>): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    ...files,
  });
}

function changeset(root: string, body: string): string {
  const file = path.join(root, "change.yaml");
  writeFileSync(file, body);
  return file;
}

function snapshot(root: string, dir = "design/issue"): Record<string, string> {
  const base = path.join(root, dir);
  if (!existsSync(base)) return {};
  return Object.fromEntries(
    readdirSync(base).map((name) => [name, readFileSync(path.join(base, name), "utf8")]),
  );
}

test("parseChangeset reads the documented op shapes", async () => {
  const { ops, diagnostics } = parseChangeset(`ops:
  - { op: create, uri: "issue://new.md", attrs: { title: "N", status: open } }
  - { op: set, uri: "issue://new.md", attrs: { status: closed } }
  - { op: link, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
  - { op: unlink, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
  - { op: rename, from: "issue://a.md", to: "issue://archive/a.md" }
  - { op: delete, uri: "issue://a.md" }
`);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ops.map((o) => o.op), ["create", "set", "link", "unlink", "rename", "delete"]);
});

test("parseChangeset rejects an unknown op and missing fields", async () => {
  assert.ok(parseChangeset("ops:\n  - { op: explode, uri: 'issue://a.md' }\n")
    .diagnostics.some((d) => d.code === "changeset/unknown-op"));
  assert.ok(parseChangeset("ops:\n  - { op: link, from: 'issue://a.md' }\n")
    .diagnostics.some((d) => d.code === "changeset/missing-field"));
});

test("create writes a new instance with a generated link block", async () => {
  const root = repo({ "design/issue/b.md": OPEN("Bee") });
  const file = changeset(root, `ops:
  - op: create
    uri: "issue://a.md"
    attrs: { title: "A", status: open, blocks: ["issue://b.md"] }
`);
  const r = await run(["--cwd", root, "apply", file]);
  assert.equal(r.code, 0);

  const written = readFileSync(path.join(root, "design/issue/a.md"), "utf8");
  assert.match(written, /title: A/);
  assert.match(written, /- blocks: \[Bee\]\(b\.md\)/);
});

test("set changes a value and leaves comments alone", async () => {
  const root = repo({
    "design/issue/a.md": instance("class: issue\n# keep me\ntitle: A\nstatus: open"),
  });
  const file = changeset(root, `ops:
  - { op: set, uri: "issue://a.md", attrs: { status: closed } }
`);
  assert.equal((await run(["--cwd", root, "apply", file])).code, 0);

  const written = readFileSync(path.join(root, "design/issue/a.md"), "utf8");
  assert.match(written, /status: closed/);
  assert.match(written, /# keep me/);
});

test("link adds an edge and updates the block at both ends", async () => {
  const root = repo({
    "design/issue/a.md": withLinks("class: issue\ntitle: Aye\nstatus: open", "- nothing yet"),
    "design/issue/b.md": withLinks("class: issue\ntitle: Bee\nstatus: open", "- nothing yet"),
  });
  const file = changeset(root, `ops:
  - { op: link, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
`);
  assert.equal((await run(["--cwd", root, "apply", file])).code, 0);

  assert.match(readFileSync(path.join(root, "design/issue/a.md"), "utf8"), /- blocks: \[Bee\]\(b\.md\)/);
  const bee = readFileSync(path.join(root, "design/issue/b.md"), "utf8");
  assert.match(bee, /### Backlinks/);
  assert.match(bee, /- blocks: \[Aye\]\(a\.md\)/);
});

test("applying the same link changeset twice is a no-op", async () => {
  const root = repo({
    "design/issue/a.md": OPEN("A"),
    "design/issue/b.md": OPEN("B"),
  });
  const file = changeset(root, `ops:
  - { op: set, uri: "issue://a.md", attrs: { status: closed } }
  - { op: link, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
`);
  await run(["--cwd", root, "apply", file]);
  const once = snapshot(root);
  await run(["--cwd", root, "apply", file]);
  assert.deepEqual(snapshot(root), once);
});

test("unlink removes the edge", async () => {
  const root = repo({
    "design/issue/a.md": OPEN("A", "blocks: [issue://b.md]"),
    "design/issue/b.md": OPEN("B"),
  });
  const file = changeset(root, `ops:
  - { op: unlink, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
`);
  assert.equal((await run(["--cwd", root, "apply", file])).code, 0);
  assert.doesNotMatch(readFileSync(path.join(root, "design/issue/a.md"), "utf8"), /issue:\/\/b\.md/);
});

test("delete removes the file", async () => {
  const root = repo({ "design/issue/a.md": OPEN("A") });
  const file = changeset(root, `ops:\n  - { op: delete, uri: "issue://a.md" }\n`);
  assert.equal((await run(["--cwd", root, "apply", file])).code, 0);
  assert.equal(existsSync(path.join(root, "design/issue/a.md")), false);
});

test("a changeset that fails validation writes nothing at all", async () => {
  const root = repo({
    "design/issue/a.md": OPEN("A"),
    "design/issue/b.md": OPEN("B"),
  });
  const before = snapshot(root);
  const file = changeset(root, `ops:
  - { op: set, uri: "issue://b.md", attrs: { status: closed } }
  - { op: set, uri: "issue://a.md", attrs: { status: nonsense } }
`);
  const r = await run(["--cwd", root, "apply", file]);
  assert.equal(r.code, 1);
  assert.deepEqual(snapshot(root), before, "the working tree must be untouched");
});

test("--dry-run writes nothing and shows the diff", async () => {
  const root = repo({ "design/issue/a.md": OPEN("A") });
  const before = snapshot(root);
  const file = changeset(root, `ops:
  - { op: set, uri: "issue://a.md", attrs: { status: closed } }
`);
  const r = await run(["--cwd", root, "apply", file, "--dry-run"]);
  assert.equal(r.code, 0);
  assert.deepEqual(snapshot(root), before);

  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.changes[0].path, "design/issue/a.md");
  assert.match(out.changes[0].diff, /-status: open/);
  assert.match(out.changes[0].diff, /\+status: closed/);
});

test("rename moves the file and rewrites every inbound uri", async () => {
  const root = repo({
    "design/issue/a.md": OPEN("A"),
    "design/issue/b.md": OPEN("B", "blocks: [issue://a.md]"),
    "design/issue/c.md": OPEN("C", "blocks: [issue://a.md]"),
    "design/issue/d.md": OPEN("D"),
  });
  const r = await run(["--cwd", root, "rename", "issue://a.md", "issue://archive/a.md"]);
  assert.equal(r.code, 0);

  assert.equal(existsSync(path.join(root, "design/issue/a.md")), false);
  assert.ok(existsSync(path.join(root, "design/issue/archive/a.md")));
  for (const name of ["b", "c"]) {
    assert.match(readFileSync(path.join(root, `design/issue/${name}.md`), "utf8"), /issue:\/\/archive\/a\.md/);
  }
  const out = parse(r.out) as Record<string, any>;
  assert.deepEqual(out.written.sort(), [
    "design/issue/archive/a.md", "design/issue/b.md", "design/issue/c.md",
  ], "d.md has no inbound link and must not be rewritten");
  assert.deepEqual(out.removed, ["design/issue/a.md"]);
  assert.equal((await run(["--cwd", root, "validate"])).code, 0);
});

test("rename updates the moved instance's own id", async () => {
  const root = repo({ "design/issue/a.md": instance("class: issue\nid: a.md\ntitle: A\nstatus: open") });
  await run(["--cwd", root, "rename", "issue://a.md", "issue://b.md"]);
  assert.match(readFileSync(path.join(root, "design/issue/b.md"), "utf8"), /id: b\.md/);
});

test("the single-op sugar commands build the same changeset", async () => {
  const root = repo({ "design/issue/a.md": OPEN("A"), "design/issue/b.md": OPEN("B") });
  assert.equal((await run(["--cwd", root, "link", "issue://a.md", "blocks", "issue://b.md"])).code, 0);
  assert.match(readFileSync(path.join(root, "design/issue/a.md"), "utf8"), /issue:\/\/b\.md/);

  assert.equal((await run(["--cwd", root, "set", "issue://a.md", "status=closed"])).code, 0);
  assert.match(readFileSync(path.join(root, "design/issue/a.md"), "utf8"), /status: closed/);
});

test("create refuses to overwrite an existing instance", async () => {
  const root = repo({ "design/issue/a.md": OPEN("A") });
  const file = changeset(root, `ops:
  - { op: create, uri: "issue://a.md", attrs: { title: "X", status: open } }
`);
  const r = await run(["--cwd", root, "apply", file]);
  assert.equal(r.code, 1);
  assert.ok((parse(r.out) as Record<string, any>).diagnostics
    .some((d: any) => d.code === "changeset/already-exists"));
});
