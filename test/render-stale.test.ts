import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
