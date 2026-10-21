import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  decision: design/decision\n";

const OPEN = (title: string, extra = "") =>
  instance(`class: issue\ntitle: ${title}\nstatus: open${extra ? `\n${extra}` : ""}`);

function repo(): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": OPEN("Aye", "blocks: [issue://b.md]\nspec: notes/s.md"),
    "design/issue/b.md": OPEN("Bee"),
    "design/decision/d.md": instance("class: decision\ntitle: Dee"),
    "notes/s.md": "x",
  });
}

test("rebuild creates the database and reports its tables", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "rebuild"]);
  assert.equal(r.code, 0);

  const out = parse(r.out) as Record<string, any>;
  assert.ok(existsSync(path.join(root, out.database)));
  assert.deepEqual(out.tables.map((t: any) => t.name).sort(), ["decision", "edge", "issue"]);
  assert.equal(out.tables.find((t: any) => t.name === "issue").rows, 2);
  assert.equal(out.tables.find((t: any) => t.name === "edge").rows, 1);
});

test("non-instantiable classes get no table", async () => {
  const root = repo();
  const out = parse((await run(["--cwd", root, "rebuild"])).out) as Record<string, any>;
  const names = out.tables.map((t: any) => t.name);
  for (const absent of ["IssueStatus", "resource", "src"]) {
    assert.equal(names.includes(absent), false, `${absent} should have no table`);
  }
});

test("attributes get native column types", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "query", "DESCRIBE issue"]);
  const rows = (parse(r.out) as Record<string, any>).rows as any[];
  const types = Object.fromEntries(rows.map((row) => [row.column_name, row.column_type]));

  assert.equal(types.uri, "VARCHAR");
  assert.equal(types.title, "VARCHAR");
  assert.equal(types.status, "VARCHAR");
  assert.equal(types.spec, "VARCHAR");
});

test("a date attribute compares without a cast", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n",
    "design/document-model.mmd": `classDiagram
    class issue {
        +string title
        +date created
        +int weight
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: A\ncreated: 2026-03-09\nweight: 7"),
  });
  await run(["--cwd", root, "rebuild"]);

  const r = await run(["--cwd", root, "query", "SELECT uri, weight + 1 AS w FROM issue WHERE created > DATE '2026-01-01'"]);
  assert.equal(r.code, 0);
  assert.deepEqual((parse(r.out) as Record<string, any>).rows, [{ uri: "issue://a.md", w: 8 }]);
});

test("the edge table holds subject, relation, object triples", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "query", "SELECT * FROM edge"]);
  assert.deepEqual((parse(r.out) as Record<string, any>).rows, [
    { subject: "issue://a.md", relation: "blocks", object: "issue://b.md" },
  ]);
});

test("rebuilding twice gives the same database", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const first = (await run(["--cwd", root, "query", "SELECT * FROM issue ORDER BY uri"])).out;
  await run(["--cwd", root, "rebuild"]);
  const second = (await run(["--cwd", root, "query", "SELECT * FROM issue ORDER BY uri"])).out;
  assert.equal(second, first);
});

test("rebuild picks up a change to an instance", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "set", "issue://b.md", "status=closed"]);
  await run(["--cwd", root, "rebuild"]);

  const r = await run(["--cwd", root, "query", "SELECT uri FROM issue WHERE status = 'closed'"]);
  assert.deepEqual((parse(r.out) as Record<string, any>).rows, [{ uri: "issue://b.md" }]);
});

test("a list attribute becomes a duckdb list", async () => {
  const root = makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n",
    "design/document-model.mmd": `classDiagram
    class issue {
        +string title
        +List~string~ tags
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: A\ntags: [x, y]"),
  });
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "query", "SELECT UNNEST(tags) AS tag FROM issue ORDER BY tag"]);
  assert.deepEqual((parse(r.out) as Record<string, any>).rows, [{ tag: "x" }, { tag: "y" }]);
});

test("query reports a bad statement without crashing", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "query", "SELECT * FROM nonexistent"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /query\/failed/);
});

test("query rebuilds automatically when there is no database yet", async () => {
  const root = repo();
  const r = await run(["--cwd", root, "query", "SELECT count(*) AS n FROM issue"]);
  assert.equal(r.code, 0);
  assert.deepEqual((parse(r.out) as Record<string, any>).rows, [{ n: 2 }]);
});
