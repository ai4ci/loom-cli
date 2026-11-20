import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { absolute, loadConfig } from "../src/config.ts";
import { databasePath, query } from "../src/duckdb.ts";
import { instance, makeRepo } from "./helpers.ts";
import { run } from "../src/cli.ts";

const MODEL = `classDiagram
    %% @prefix issue: <repo:design/implementation/issues/> .
    class IssueStatus {
        <<enumeration>>
        open
        closed
    }
    class issue {
        +string title
        +IssueStatus status
    }

    %% @view openIssues
    %% SELECT uri, title FROM issue WHERE status = 'open'
`;

test("render --check detects a hand-edited instance without a rebuild", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/implementation/issues/issue-019.md":
      instance("class: issue\ntitle: Citation styles\nstatus: open"),
    "design/INDEX.md": "# Index\n\n<!-- loom view: openIssues -->\n",
  });
  assert.equal((await run(["--cwd", root, "rebuild"])).code, 0);
  assert.equal((await run(["--cwd", root, "render"])).code, 0);

  const file = root + "/design/implementation/issues/issue-019.md";
  writeFileSync(file, readFileSync(file, "utf8").replace("status: open", "status: closed"));

  const check = await run(["--cwd", root, "render", "--check"]);
  assert.equal(check.code, 1, check.out);
  assert.ok(check.out.includes("INDEX.md"));
});

test("index --check detects a hand-edited instance without a rebuild", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/implementation/issues/issue-019.md":
      instance("class: issue\ntitle: Citation styles\nstatus: open"),
    "design/INDEX.md": `---
class: index
view:
  class: issue
  where:
    status: open
---

# Index
`,
  });
  assert.equal((await run(["--cwd", root, "rebuild"])).code, 0);
  assert.equal((await run(["--cwd", root, "index"])).code, 0);

  const file = root + "/design/implementation/issues/issue-019.md";
  writeFileSync(file, readFileSync(file, "utf8").replace("status: open", "status: closed"));

  const check = await run(["--cwd", root, "index", "--check"]);
  assert.equal(check.code, 1, check.out);
});

test("refresh preserves unchanged rows and sees additions, deletions and edits with the same mtime", async () => {
  const dir = "design/implementation/issues";
  const doc = (title: string, target?: string) => instance(
    "class: issue\ntitle: " + title + "\nstatus: open" + (target ? "\nblocks: [issue:" + target + ".md]" : ""),
    title + " prose.\n",
  );
  const root = makeRepo({
    "design/document-model.mmd": MODEL + '\n    issue "0..*" --> "0..*" issue : blocks\n',
    [dir + "/a.md"]: doc("A", "b"),
    [dir + "/b.md"]: doc("B", "a"),
    [dir + "/c.md"]: doc("C", "b"),
  });
  const cfg = loadConfig(root);
  assert.equal((await run(["--cwd", root, "rebuild"])).code, 0);
  const readOriginal = () => query(cfg, "SELECT rowid AS rid FROM issue WHERE id = 'a.md'");
  const original = await readOriginal();
  assert.equal((await run(["--cwd", root, "render"])).code, 0);
  assert.deepEqual(await readOriginal(), original);

  const file = path.join(root, dir, "b.md");
  const time = new Date("2024-01-01T00:00:00Z");
  utimesSync(file, time, time);
  assert.equal((await run(["--cwd", root, "render"])).code, 0);
  writeFileSync(file, doc("X", "d"));
  utimesSync(file, time, time);
  unlinkSync(path.join(root, dir, "c.md"));
  writeFileSync(path.join(root, dir, "d.md"), doc("D"));

  const result = await run(["--cwd", root, "render"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(await readOriginal(), original);
  assert.deepEqual((await query(cfg, "SELECT title, body FROM issue ORDER BY id")).rows, [
    { title: "A", body: "A prose." }, { title: "X", body: "X prose." }, { title: "D", body: "D prose." },
  ]);
  assert.deepEqual((await query(cfg, "SELECT subject, object FROM edge ORDER BY subject")).rows, [
    { subject: "issue:a.md", object: "issue:b.md" }, { subject: "issue:b.md", object: "issue:d.md" },
  ]);
});

test("render upgrades an older projection and rebuilds when the model changes", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/implementation/issues/a.md": instance("class: issue\ntitle: A\nstatus: open", "The body.\n"),
    "deck.md": "<!-- loom view: SELECT body FROM issue -->\n",
  });
  const cfg = loadConfig(root);
  const target = absolute(cfg, databasePath(cfg));
  mkdirSync(path.dirname(target), { recursive: true });
  const old = await DuckDBInstance.create(target);
  const connection = await old.connect();
  try {
    await connection.run("CREATE TABLE issue (uri VARCHAR PRIMARY KEY, id VARCHAR, path VARCHAR, title VARCHAR, status VARCHAR)");
    await connection.run("CREATE TABLE edge (subject VARCHAR, relation VARCHAR, object VARCHAR)");
  } finally {
    connection.closeSync();
    old.closeSync();
  }

  let result = await run(["--cwd", root, "render"]);
  assert.equal(result.code, 0, result.err);
  assert.match(readFileSync(path.join(root, "deck.md"), "utf8"), /- The body\./);

  writeFileSync(path.join(root, "design/document-model.mmd"), MODEL.replace("+string title", "+string title\n        +string tag?"));
  writeFileSync(path.join(root, "deck.md"), "<!-- loom view: SELECT coalesce(tag, 'missing') FROM issue -->\n");
  result = await run(["--cwd", root, "render"]);
  assert.equal(result.code, 0, result.err);
  assert.match(readFileSync(path.join(root, "deck.md"), "utf8"), /- missing/);

  writeFileSync(path.join(root, "design/document-model.mmd"), MODEL.replace("+string title", "+string title\n        +string label?"));
  writeFileSync(path.join(root, "design/implementation/issues/a.md"), instance(
    "class: issue\ntitle: A\nstatus: open", "<!-- loom include: issue:a.md typo -->\n",
  ));
  result = await run(["--cwd", root, "render"]);
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /render\/bad-include/);
  assert.deepEqual((await query(cfg, "SELECT tag, body FROM issue")).rows, [{ tag: null, body: "The body." }]);
});
