/** Composite attributes project as DuckDB STRUCTs (plan "Later — composite attributes"). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, instance } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { loadGraph } from "../src/graph.ts";
import { loadModel } from "../src/model/load.ts";
import { rebuild, query } from "../src/duckdb.ts";

const MODEL = `classDiagram
    %% @path issue design/issue
    class issue {
        +string title
        +Contact reporter
        +List~Contact~ reviewers
    }
    class Contact {
        +string name
        +string email
        +Address address
    }
    class Address {
        +string city
        +string zip
    }
`;

function fixture() {
  return makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance(
      `class: issue
title: A
reporter:
  name: Ada
  email: ada@example.org
  address:
    city: NYC
    zip: "10001"
reviewers:
  - name: Bob
    email: bob@example.org
  - name: Carol
    email: carol@example.org`,
    ),
    "design/issue/b.md": instance(
      `class: issue
title: B
reporter:
  name: Dave
  email: dave@example.org
  address:
    city: LA
    zip: "90001"`,
    ),
  });
}

async function setup() {
  const root = fixture();
  const cfg = loadConfig(root);
  const { schema, roots } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema, roots);
  return { cfg, graph };
}

test("class-typed attribute becomes a STRUCT column with the right nested type", async () => {
  const { cfg, graph } = await setup();
  const result = await rebuild(graph);
  const issue = result.tables.find((t) => t.name === "issue");
  assert.ok(issue, "issue table created");

  const schema = await query(cfg, "DESCRIBE issue");
  const reporterRow = schema.rows.find((r) => (r as Record<string, unknown>)["column_name"] === "reporter");
  assert.ok(reporterRow);
  const type = String((reporterRow as Record<string, unknown>)["column_type"]);
  // STRUCT("name" VARCHAR, email VARCHAR, address STRUCT(city VARCHAR, zip VARCHAR))
  assert.match(type, /^STRUCT\(/);
  assert.match(type, /(?:"name"|name) VARCHAR/);
  assert.match(type, /(?:"email"|email) VARCHAR/);
  assert.match(type, /(?:"address"|address) STRUCT\(/);
});

test("list of class-typed attribute becomes a STRUCT[] column", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  const schema = await query(cfg, "DESCRIBE issue");
  const reviewersRow = schema.rows.find((r) => (r as Record<string, unknown>)["column_name"] === "reviewers");
  assert.ok(reviewersRow);
  const type = String((reviewersRow as Record<string, unknown>)["column_type"]);
  assert.match(type, /^STRUCT\(.*\)\[\]$/);
});

test("subfield access works without casts", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  const r = await query(cfg, "SELECT title, reporter.name AS who, reporter.address.city AS city FROM issue ORDER BY title");
  assert.deepEqual(r.rows, [
    { title: "A", who: "Ada", city: "NYC" },
    { title: "B", who: "Dave", city: "LA" },
  ]);
});

test("a misspelt subfield fails loudly with a Binder Error", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  await assert.rejects(
    () => query(cfg, "SELECT reporter.nam FROM issue"),
    /nam/,
    "typo in struct subfield must error",
  );
});

test("UNNEST over a STRUCT[] exposes per-element fields", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  const r = await query(
    cfg,
    "SELECT i.title, r.name FROM issue i, UNNEST(i.reviewers) r ORDER BY i.title, r.name",
  );
  assert.deepEqual(r.rows, [
    { title: "A", name: "Bob" },
    { title: "A", name: "Carol" },
  ]);
});

test("query result flattens DuckDB's {entries:{...}} wrapper to a plain object", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  const r = await query(cfg, "SELECT reporter FROM issue WHERE title = 'A'");
  const reporter = (r.rows[0] as Record<string, unknown>)["reporter"] as Record<string, unknown>;
  assert.deepEqual(reporter, {
    name: "Ada",
    email: "ada@example.org",
    address: { city: "NYC", zip: "10001" },
  });
});

test("nested STRUCT[] flattens cleanly", async () => {
  const { cfg, graph } = await setup();
  await rebuild(graph);

  const r = await query(cfg, "SELECT reviewers FROM issue WHERE title = 'A'");
  const reviewers = (r.rows[0] as Record<string, unknown>)["reviewers"];
  assert.deepEqual(reviewers, [
    { name: "Bob", email: "bob@example.org", address: null },
    { name: "Carol", email: "carol@example.org", address: null },
  ]);
});
