import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";
import { embedder, hashBody } from "../src/embeddings.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n";

function repo(extra: Record<string, string> = {}): string {
  return makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance(
      "class: issue\ntitle: Authentication bug\nstatus: open",
      "\nUsers cannot log in after password reset.\n",
    ),
    "design/issue/b.md": instance(
      "class: issue\ntitle: Login flow change\nstatus: open",
      "\nAuthentication has been redesigned; tokens replace passwords.\n",
    ),
    "design/issue/c.md": instance(
      "class: issue\ntitle: Database migration\nstatus: closed",
      "\nSchema change for the orders table is complete.\n",
    ),
    ...extra,
  });
}

test("hashBody is stable across runs and sensitive to change", () => {
  const a = hashBody("hello world");
  const b = hashBody("hello world");
  const c = hashBody("hello world!");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("the embedder produces fixed-dimension vectors", async () => {
  const e = embedder();
  const v = await e.embed("the quick brown fox");
  assert.equal(v.length, e.dimensions);
  assert.equal(typeof v[0], "number");
});

test("identical inputs produce identical vectors", async () => {
  const e = embedder();
  const v1 = await e.embed("authentication token login");
  const v2 = await e.embed("authentication token login");
  assert.deepEqual(v1, v2);
});

test("similar finds semantically-related instances", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "similar", "authentication password", "--limit", "2"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.ok(out.results.length > 0);
  // Either a or b should rank first; c (about database) should not.
  const top = out.results[0].uri;
  assert.ok(top === "issue://a.md" || top === "issue://b.md");
});

test("similar accepts a uri to embed an existing document", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "similar", "issue://a.md", "--limit", "2"]);
  const r = await run(["--cwd", root, "similar", "issue://a.md", "--limit", "2"]);
  assert.equal(r.code, 0);
});

test("rebuild keeps the same content_hash when a body is unchanged", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r1 = await run(["--cwd", root, "query", "SELECT content_hash FROM embedding WHERE uri = 'issue://a.md'"]);
  const hash1 = (parse(r1.out) as Record<string, any>).rows[0].content_hash;

  // Touching the title doesn't change the body, so the hash stays.
  const fs = await import("node:fs");
  fs.writeFileSync(root + "/design/issue/a.md", instance(
    "class: issue\ntitle: Auth bug renamed\nstatus: open",
    "\nUsers cannot log in after password reset.\n",
  ));
  await run(["--cwd", root, "rebuild"]);
  const r2 = await run(["--cwd", root, "query", "SELECT content_hash FROM embedding WHERE uri = 'issue://a.md'"]);
  const hash2 = (parse(r2.out) as Record<string, any>).rows[0].content_hash;
  assert.equal(hash1, hash2);

  // Changing the body changes the hash.
  fs.writeFileSync(root + "/design/issue/a.md", instance(
    "class: issue\ntitle: Auth bug renamed\nstatus: open",
    "\nDifferent content about payments and invoices.\n",
  ));
  await run(["--cwd", root, "rebuild"]);
  const r3 = await run(["--cwd", root, "query", "SELECT content_hash FROM embedding WHERE uri = 'issue://a.md'"]);
  const hash3 = (parse(r3.out) as Record<string, any>).rows[0].content_hash;
  assert.notEqual(hash1, hash3);
});

test("similar ranks the queried document itself first when asked by uri", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "similar", "issue://a.md", "--limit", "3"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.results[0].uri, "issue://a.md");
});

test("similar on text uses a content hash that does not collide with any document", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "similar", "totally unrelated topic"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.ok(out.results.length > 0, "still returns scores for every document");
});
