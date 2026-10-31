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
    { text: "%% @prefix issue: <repo:design/issue/> .", line: 1 },
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
    %% @prefix issue: <repo:test/issues/> .
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
  // Should contain the open issues as links
  assert(content.includes("[First](test/issues/open.md)"), content);
  assert(content.includes("[Second](test/issues/open2.md)"), content);
  assert(!content.includes("closed"), content); // closed is filtered by WHERE
});

test("render: inline SQL renders into the file", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:test/issues/> .
    class issue {
        +string title
        +string status
    }
`,
    "test/issues/a.md": instance("uri: issue:a\ntitle: Alpha\nstatus: open\n"),
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

test("render --check exits 1 when a marker would be updated, and writes nothing", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "README.md": `# Test\n\n<!-- loom view: SELECT count(*) AS cnt FROM issue -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render", "--check"]);
  assert.equal(r.code, 1, "--check on a stale file should exit 1");

  // Nothing was written: the file still holds the bare marker.
  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("<!-- loom view: SELECT count(*)"), "--check must not write");

  // The stale file is named so CI can point at it.
  assert.match(r.out + r.err, /README\.md/);
});

test("render --check exits 0 and is silent when everything is fresh", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "README.md": `# Test\n\n<!-- loom view: SELECT count(*) AS cnt FROM issue -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  await run(["--cwd", root, "render"]); // render first, so the file is fresh
  const r = await run(["--cwd", root, "render", "--check"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("cnt"));
});

test("render --debug prints resolved SQL per view to stderr", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "README.md": `# Test\n\n<!-- loom view: SELECT count(*) AS cnt FROM issue -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render", "--debug"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /SELECT count\(\*\) AS cnt FROM issue/);
  assert.match(r.err, /README\.md/);

  // The file was still rendered normally.
  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("cnt"));
});

test("render: uri columns become markdown links with titles", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance("title: Alpha\nstatus: open\n"),
    "design/issue/b.md": instance("title: Beta\nstatus: open\n\nBlocked by [[a]].\n"),
    "README.md": `# Test\n\n<!-- loom view: SELECT uri, title FROM issue ORDER BY uri -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  // Title in the link text, repo-relative link target from the README's dir.
  assert(content.includes("[Alpha](design/issue/a.md)"), content);
  assert(content.includes("[Beta](design/issue/b.md)"), content);
  // Plain uri text no longer appears as a bare cell.
  assert(!content.includes("| issue:"), content);
});

test("render: edge columns become markdown links too", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "design/issue/a.md": instance("title: Alpha\nstatus: open\n"),
    "design/issue/b.md": instance("title: Beta\nstatus: open\nblocks: [issue:a.md]\n"),
    "README.md": `# Test\n\n<!-- loom view: SELECT subject, relation, object FROM edge -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  // Both ends resolve to live files, so both become links.
  assert(content.includes("[Beta](design/issue/b.md)"), content);
  assert(content.includes("[Alpha](design/issue/a.md)"), content);
});

test("render: unknown uris fall back to a plain-text cell", async () => {
  const root = makeRepo({
    "design/document-model.mmd": GRAPH_MODEL,
    "README.md": `# Test\n\n<!-- loom view: SELECT 'issue:missing.md' AS uri -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  // Unresolvable uri: no link (target doesn't exist), keep the uri text.
  assert(content.includes("issue:missing.md"), content);
  assert(!content.includes("]("), content);
});

test("render --debug names the view when the marker uses one", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `${GRAPH_MODEL}
%% @view openIssues
%% SELECT title FROM issue WHERE status = 'open'
`,
    "README.md": `# Test\n\n<!-- loom view: openIssues -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render", "--debug"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /openIssues/);
  assert.match(r.err, /SELECT title FROM issue/);
});
