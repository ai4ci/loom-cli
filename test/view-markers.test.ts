// Regression tests for multiple view markers in one file, and for the
// qualified end marker `<!-- loom view: <name> end -->`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/cli.ts";
import { scanViewMarkers } from "../src/render.ts";
import { makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issues/> .
    class issue {
        +string title
        +string status
    }

    %% @view a
    %% SELECT id FROM issue WHERE status = 'open'

    %% @view b
    %% SELECT id FROM issue WHERE status = 'closed'
`;

function issueRepo(issues: string[][]): string {
  const files: Record<string, string> = {
    "design/document-model.mmd": MODEL,
  };
  for (const [id, status] of issues) {
    files[`design/issues/${id}.md`] = `---
class: issue
id: ${id}
status: ${status}
---
# ${id}
`;
  }
  return makeRepo(files);
}

test("scanViewMarkers pairs each opener with its own end, not the next one", () => {
  const text = `<!-- loom view: a -->
<!-- loom view: end -->

<!-- loom view: b -->
<!-- loom view: end -->
`;
  const ms = scanViewMarkers(text);
  assert.deepEqual(ms.map((m) => m.view), ["a", "b"]);
  assert.ok(ms[0]!.end <= ms[1]!.start, `a ends before b starts (${ms[0]!.end} > ${ms[1]!.start})`);
  // Section b must contain the b marker and its end, nothing from a's section.
  const b = text.slice(ms[1]!.start, ms[1]!.end);
  assert.match(b, /loom view: b/);
  assert.match(b, /loom view: end/);
  assert.doesNotMatch(b, /loom view: a/);
});

test("a qualified end marker terminates its own view", () => {
  const text = `<!-- loom view: a -->
<!-- loom view: a end -->
<!-- loom view: b -->
<!-- loom view: end -->
`;
  const ms = scanViewMarkers(text);
  assert.deepEqual(ms.map((m) => m.view), ["a", "b"]);
  const a = text.slice(ms[0]!.start, ms[0]!.end);
  assert.match(a, /a end/);
});

test("a view without an end marker ends at the next opener or EOF", () => {
  const text = `<!-- loom view: a -->
prose in a

<!-- loom view: b -->
prose in b
`;
  const ms = scanViewMarkers(text);
  assert.deepEqual(ms.map((m) => m.view), ["a", "b"]);
  assert.ok(ms[0]!.end <= ms[1]!.start);
  assert.ok(ms[1]!.end === text.length);
});

test("two views in one page render without scrambling", async () => {
  const root = issueRepo([["a", "open"], ["b", "closed"]]);
  const page = path.join(root, "design/page.md");
  writeFileSync(page, `# Page

<!-- loom view: a -->
<!-- loom view: end -->

middle

<!-- loom view: b -->
<!-- loom view: end -->
`);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err + r.out);
  const out = readFileSync(page, "utf8");
  const aStart = out.indexOf("<!-- loom view: a -->");
  const bStart = out.indexOf("<!-- loom view: b -->");
  assert.ok(aStart !== -1 && bStart !== -1, `both markers present:\n${out}`);
  const aSection = out.slice(aStart, bStart);
  const bSection = out.slice(bStart);
  assert.ok(aSection.includes("- a.md"), `a section has a row for a:\n${aSection}`);
  assert.ok(!aSection.includes("- b.md"), `a section must not contain b's row:\n${aSection}`);
  assert.ok(bSection.includes("- b.md"), `b section has a row for b:\n${bSection}`);
  assert.ok(!bSection.includes("- a.md"), `b section must not contain a's row:\n${bSection}`);
  assert.ok(!bSection.includes("end -->\n\n|"), `no leftover end marker inside b's table:\n${bSection}`);
  // middle survived unharmed.
  assert.match(out, /\nmiddle\n/);
});

test("a missing end marker is inserted on render", async () => {
  const root = issueRepo([["a", "open"]]);
  const page = path.join(root, "design/page.md");
  writeFileSync(page, `# Page\n\n<!-- loom view: a -->\n`);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err + r.out);
  const out = readFileSync(page, "utf8");
  assert.match(out, /<!-- loom view: a -->/);
  assert.match(out, /<!-- loom view: (a )?end -->/);
  assert.ok(!out.includes("[undefined:"), `no unresolved view error:\n${out}`);
});

test("a view query error still terminates before the next view", async () => {
  const root = issueRepo([]);
  const page = path.join(root, "design/page.md");
  writeFileSync(page, `<!-- loom view: nope -->
<!-- loom view: end -->

<!-- loom view: a -->
<!-- loom view: end -->
`);
  const r = await run(["--cwd", root, "render"]);
  const out = readFileSync(page, "utf8");
  assert.ok(out.indexOf("loom view: a") < out.lastIndexOf("loom view: a"), `markers intact:\n${out}`);
  assert.match(out, /_Unknown view "nope"\._/);
  assert.doesNotMatch(out, /--> end|end --> --/);
});

test("render is idempotent once qualified ends are written", async () => {
  const root = issueRepo([["a", "open"]]);
  const page = path.join(root, "design/page.md");
  writeFileSync(page, `<!-- loom view: a -->\n`);
  await run(["--cwd", root, "render"]);
  const once = readFileSync(page, "utf8");
  await run(["--cwd", root, "render"]);
  assert.equal(readFileSync(page, "utf8"), once);
  const r = await run(["--cwd", root, "--json", "render", "--check"]);
  assert.equal(r.code, 0);
});
