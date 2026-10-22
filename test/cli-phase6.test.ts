import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n";

function repo(): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/open-a.md": instance("class: issue\ntitle: Open A\nstatus: open"),
    "design/issue/open-b.md": instance("class: issue\ntitle: Open B\nstatus: open"),
    "design/issue/closed-c.md": instance("class: issue\ntitle: Closed C\nstatus: closed"),
    "design/INDEX.md": `---
class: index
view:
  class: issue
  where:
    status: open
  orderBy: title
---
`,
  });
}

test("index regenerates a query-based index", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "index"]);
  assert.equal(r.code, 0);

  const written = readFileSync(path.join(root, "design/INDEX.md"), "utf8");
  assert.match(written, /- \[Open A\]\(issue\/open-a\.md\)/);
  assert.match(written, /- \[Open B\]\(issue\/open-b\.md\)/);
  assert.doesNotMatch(written, /Closed C/);
});

test("index regenerates a SQL-query-based index", async () => {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: A\nstatus: open"),
    "design/issue/b.md": instance("class: issue\ntitle: B\nstatus: closed"),
    "design/INDEX.md": `---
class: index
view:
  query: "SELECT uri, title FROM issue WHERE status = 'closed' ORDER BY title"
---
`,
  });
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "index"]);

  const written = readFileSync(path.join(root, "design/INDEX.md"), "utf8");
  assert.match(written, /- \[B\]\(issue\/b\.md\)/);
  assert.doesNotMatch(written, /A/);
});

test("index regenerates idempotently", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "index"]);
  const once = readFileSync(path.join(root, "design/INDEX.md"), "utf8");
  await run(["--cwd", root, "index"]);
  const twice = readFileSync(path.join(root, "design/INDEX.md"), "utf8");
  assert.equal(twice, once);
});

test("--check detects a stale index", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  // Manually edit the index to be stale
  const stalePath = path.join(root, "design/INDEX.md");
  const stale = readFileSync(stalePath, "utf8")
    .replace(/<!-- design-docs:links start -->\n([\s\S]*?)\n<!-- design-docs:links end -->/,
             "<!-- design-docs:links start -->\n- [Stale](stale.md)\n<!-- design-docs:links end -->");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(stalePath, stale);

  const r = await run(["--cwd", root, "index", "--check"]);
  assert.equal(r.code, 1);
  const out = parse(r.out) as Record<string, any>;
  assert.ok(out.stale.includes("design/INDEX.md"));
});

test("--check passes when indexes are up to date", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "index", "--check"]);
  assert.equal(r.code, 0);
});

test("--check passes when there are no indexes", async () => {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: A\nstatus: open"),
  });
  const r = await run(["--cwd", root, "index", "--check"]);
  assert.equal(r.code, 0);
});

test("index reports which files were updated", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "index"]);
  const out = parse(r.out) as Record<string, any>;
  assert.deepEqual(out.updated.sort(), ["design/INDEX.md"]);
});

test("an index file with no view is left untouched", async () => {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: A\nstatus: open"),
    "design/INDEX.md": `---
class: index
---
Some manual content here.
`,
  });
  const r = await run(["--cwd", root, "index"]);
  const out = parse(r.out) as Record<string, any>;
  assert.deepEqual(out.updated, []);
});
