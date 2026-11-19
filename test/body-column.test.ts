import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class issue {
        +string title
    }
`;

const BODY = "Some prose.\n\nA second paragraph.\n";

function repo(extra: Record<string, string> = {}): string {
  return makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance(
      "class: issue\ntitle: A",
      `${BODY}<!-- loom:links start -->\n- blocks: [B](b.md)\n<!-- loom:links end -->\n`,
    ),
    ...extra,
  });
}

const rows = (out: string): Record<string, unknown>[] =>
  (parse(out) as { rows: Record<string, unknown>[] }).rows;

test("the markdown body is projected as a queryable column", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);

  const r = await run(["--cwd", root, "query", "SELECT uri, body FROM issue"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(rows(r.out)[0]?.["body"], BODY.trim());
});

test("the projected body excludes the protected link block", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  const r = await run(["--cwd", root, "query", "SELECT body FROM issue"]);
  assert.doesNotMatch(String(rows(r.out)[0]?.["body"]), /loom:links|blocks:/);
});

test("links in the projected body are in curie form, not relative", async () => {
  const root = repo({
    "design/issue/b.md": instance("class: issue\ntitle: B"),
  });
  await run(["--cwd", root, "body", "set", "issue:a.md", "See [B](issue:b.md)."]);

  const r = await run(["--cwd", root, "query", "SELECT body FROM issue WHERE uri = 'issue:a.md'"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(rows(r.out)[0]?.["body"], "See [B](issue:b.md).");
});

test("an edited body is visible to the next query", async () => {
  const root = repo();
  await run(["--cwd", root, "rebuild"]);
  await run(["--cwd", root, "body", "set", "issue:a.md", "Rewritten."]);

  const r = await run(["--cwd", root, "query", "SELECT body FROM issue"]);
  assert.match(String(rows(r.out)[0]?.["body"]), /Rewritten\./);
});

test("a class that declares its own body attribute keeps it", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class issue {
        +string title
        +string body
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: A\nbody: declared", "prose\n"),
  });
  await run(["--cwd", root, "rebuild"]);

  const r = await run(["--cwd", root, "query", "SELECT body FROM issue"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(rows(r.out)[0]?.["body"], "declared");
});
