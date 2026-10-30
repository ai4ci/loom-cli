import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { extractViewAnnotations, scanViewMarkers, substituteParams } from "../src/render.ts";
import { makeRepo, instance } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";
import { run } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// extractViewAnnotations — unit tests
// ---------------------------------------------------------------------------

test("extractViewAnnotations: simple single-line view", () => {
  const comments = [
    { text: "%% @view adrs", line: 2 },
    { text: "%% SELECT uri, title FROM decision", line: 3 },
  ];
  const diags: { code: string; message: string; line?: number }[] = [];
  const views = extractViewAnnotations(comments, diags as any);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.name, "adrs");
  assert.equal(views[0]!.sql.trim(), "SELECT uri, title FROM decision");
  assert.equal(diags.length, 0);
});

test("extractViewAnnotations: multi-line body", () => {
  const comments = [
    { text: "%% @view open_issues", line: 4 },
    { text: "%% SELECT uri, title, status", line: 5 },
    { text: "%% FROM issue", line: 6 },
    { text: "%% WHERE status = 'open'", line: 7 },
  ];
  const diags: any[] = [];
  const views = extractViewAnnotations(comments, diags);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.name, "open_issues");
  assert(views[0]!.sql.includes("SELECT"));
  assert(views[0]!.sql.includes("WHERE status"));
});

test("extractViewAnnotations: non-view comments are ignored", () => {
  const comments = [
    { text: "%% @path issue design/issue", line: 1 },
    { text: "%% this is a regular comment", line: 2 },
    { text: "%% @view simple", line: 3 },
    { text: "%% SELECT 1 AS n", line: 4 },
  ];
  const diags: any[] = [];
  const views = extractViewAnnotations(comments, diags);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.name, "simple");
});

test("extractViewAnnotations: duplicate names produce a diagnostic", () => {
  const comments = [
    { text: "%% @view dup", line: 3 },
    { text: "%% SELECT 1", line: 4 },
    { text: "%% @view dup", line: 5 },
    { text: "%% SELECT 2", line: 6 },
  ];
  const diags: any[] = [];
  const views = extractViewAnnotations(comments, diags);
  assert.equal(views.length, 2);
  assert.equal(diags.length, 1);
  assert(diags[0]!.code === "model/duplicate-view");
});

// ---------------------------------------------------------------------------
// scanViewMarkers — unit tests
// ---------------------------------------------------------------------------

test("scanViewMarkers: basic marker", () => {
  const md = "Hello\n<!-- loom view: adrs -->\nWorld\n<!-- loom view: end -->\nEnd";
  const markers = scanViewMarkers(md);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.view, "adrs");
  assert(markers[0]!.start >= 0);
  assert(markers[0]!.end > markers[0]!.start);
});

test("scanViewMarkers: marker with query-string parameters", () => {
  const md = "<!-- loom view: open_issues?status=open&limit=5 -->\n...\n<!-- loom view: end -->";
  const markers = scanViewMarkers(md);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.view, "open_issues");
  assert.equal(markers[0]!.params["status"], "open");
  assert.equal(markers[0]!.params["limit"], "5");
});

test("scanViewMarkers: inline SQL marker", () => {
  const md = "<!-- loom view: SELECT uri, title FROM issue -->\n<!-- loom view: end -->";
  const markers = scanViewMarkers(md);
  assert.equal(markers.length, 1);
  assert(markers[0]!.view.startsWith("SELECT"));
});

test("scanViewMarkers: without end marker", () => {
  const md = "<!-- loom view: adrs -->";
  const markers = scanViewMarkers(md);
  assert.equal(markers.length, 1);
  // end should equal start when no closing marker
  assert.equal(markers[0]!.end, markers[0]!.start);
});

test("scanViewMarkers: multiple markers", () => {
  const md = "<!-- loom view: a -->\n<!-- loom view: end -->\n...\n<!-- loom view: b -->\n<!-- loom view: end -->";
  const markers = scanViewMarkers(md);
  assert.equal(markers.length, 2);
  assert.equal(markers[0]!.view, "a");
  assert.equal(markers[1]!.view, "b");
});

// ---------------------------------------------------------------------------
// substituteParams — unit tests
// ---------------------------------------------------------------------------

test("substituteParams: single param", () => {
  const sql = "SELECT * FROM issue WHERE status = $status";
  const result = substituteParams(sql, { status: "open" });
  assert.equal(result, "SELECT * FROM issue WHERE status = 'open'");
});

test("substituteParams: multi-value list param", () => {
  const sql = "SELECT * FROM issue WHERE status IN $statuses";
  const result = substituteParams(sql, { statuses: "open,closed" });
  assert(result.includes("'open', 'closed'"));
});

test("substituteParams: escaped comma in list value", () => {
  const sql = "SELECT * FROM issue WHERE tags IN $tags";
  const result = substituteParams(sql, { tags: "foo\\,bar,baz" });
  assert(result.includes("'foo,bar'"));
  assert(result.includes("'baz'"));
});

// ---------------------------------------------------------------------------
// Integration: render command via CLI
// ---------------------------------------------------------------------------

test("render: named view renders its content into the file", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @path issue test/issues
    class issue {
        +string title
        +string status
    }

    %% @view open_issues
    %% SELECT uri, title, status
    %% FROM issue
    %% WHERE status = 'open'
`,
    "test/issues/open.md": instance("title: First\nstatus: open\n"),
    "test/issues/open2.md": instance("title: Second\nstatus: open\n"),
    "test/issues/closed.md": instance("title: Done\nstatus: closed\n"),
    "README.md": `# Test\n\n<!-- loom view: open_issues -->\n<!-- loom view: end -->\n`,
  });

  // Index first so the DB exists
  const idx = await run(["--cwd", root, "index"]);
  assert.equal(idx.code, 0);

  // Render
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  // The rendered file should have marker content replaced with a table
  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("<!-- loom view: open_issues -->"));
  assert(content.includes("<!-- loom view: end -->"));
  // Should contain table header
  assert(content.includes("| uri"));
  assert(content.includes("| title"));
  assert(content.includes("| status"));
  // Should contain the open issues (URI derived from filename)
  assert(content.includes("issue://open.md"));
  assert(content.includes("issue://open2.md"));
  assert(!content.includes("issue://closed.md")); // closed is filtered by WHERE
});

test("render: inline SQL renders into the file", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @path issue test/issues
    class issue {
        +string title
        +string status
    }
`,
    "test/issues/a.md": instance("uri: issue://a\ntitle: Alpha\nstatus: open\n"),
    "README.md": `# Test\n\n<!-- loom view: SELECT count(*) AS cnt FROM issue -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("cnt"));
  assert(content.includes("1"));
});

test("render: unknown view produces error message inline", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "README.md": `# Test\n\n<!-- loom view: nonexistent -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("Unknown view"));
});
