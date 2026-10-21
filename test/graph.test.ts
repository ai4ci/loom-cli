import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { loadModel } from "../src/model/load.ts";
import { loadGraph, renderLinks, validateGraph } from "../src/graph.ts";
import { instance, makeRepo } from "./helpers.ts";
import { GRAPH_MODEL } from "./fixtures.ts";

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  decision: design/decision\n";

function build(files: Record<string, string>) {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": GRAPH_MODEL,
    ...files,
  });
  const cfg = loadConfig(root);
  const { schema } = loadModel(cfg);
  return { root, cfg, schema, ...loadGraph(cfg, schema) };
}

function codes(files: Record<string, string>): string[] {
  const built = build(files);
  return [...built.diagnostics, ...validateGraph(built.graph)].map((d) => d.code);
}

const OPEN = (title: string, extra = "") =>
  instance(`class: issue\ntitle: ${title}\nstatus: open${extra ? `\n${extra}` : ""}`);

test("loadGraph finds every instance across class roots", () => {
  const { graph } = build({
    "design/issue/a.md": OPEN("A"),
    "design/issue/nested/b.md": OPEN("B"),
    "design/decision/d.md": instance("class: decision\ntitle: D"),
  });
  assert.deepEqual(
    [...graph.instances.keys()].sort(),
    ["decision://d.md", "issue://a.md", "issue://nested/b.md"],
  );
});

test("loadGraph records edges as triples", () => {
  const { graph } = build({
    "design/issue/a.md": OPEN("A", "blocks: [issue://b.md]"),
    "design/issue/b.md": OPEN("B"),
  });
  assert.deepEqual(graph.edges, [
    { from: "issue://a.md", relation: "blocks", to: "issue://b.md" },
  ]);
});

test("a clean repository produces no diagnostics", () => {
  assert.deepEqual(codes({
    "design/issue/a.md": OPEN("A", "blocks: [issue://b.md]"),
    "design/issue/b.md": OPEN("B"),
  }), []);
});

test("a dangling relation target is reported", () => {
  assert.ok(codes({ "design/issue/a.md": OPEN("A", "blocks: [issue://ghost.md]") })
    .includes("graph/dangling-link"));
});

test("a non-markdown file under a class root is ignored", () => {
  assert.deepEqual(codes({ "design/issue/a.md": OPEN("A"), "design/issue/notes.txt": "hi" }), []);
});

test("a markdown file under a class root with no frontmatter is an orphan", () => {
  assert.ok(codes({ "design/issue/loose.md": "# just prose\n" }).includes("graph/orphan-file"));
});

test("inbound cardinality is enforced across files", () => {
  // decided-by allows at most one issue per decision.
  const found = codes({
    "design/issue/a.md": OPEN("A", "decided-by: [decision://d.md]"),
    "design/issue/b.md": OPEN("B", "decided-by: [decision://d.md]"),
    "design/decision/d.md": instance("class: decision\ntitle: D"),
  });
  assert.ok(found.includes("graph/inbound-cardinality"));
});

test("inbound cardinality passes when the limit is respected", () => {
  assert.deepEqual(codes({
    "design/issue/a.md": OPEN("A", "decided-by: [decision://d.md]"),
    "design/decision/d.md": instance("class: decision\ntitle: D"),
  }), []);
});

test("a resource target is checked for existence but needs no instance file", () => {
  assert.deepEqual(codes({
    "design/issue/a.md": OPEN("A", "attachment: [resource://spec.pdf]"),
    "design/resource/spec.pdf": "%PDF",
  }), []);
  assert.ok(codes({ "design/issue/a.md": OPEN("A", "attachment: [resource://gone.pdf]") })
    .includes("graph/missing-resource"));
});

test("a path attribute must resolve to a real file", () => {
  assert.deepEqual(codes({
    "design/issue/a.md": OPEN("A", "spec: notes/spec.md"),
    "notes/spec.md": "x",
  }), []);
  assert.ok(codes({ "design/issue/a.md": OPEN("A", "spec: notes/absent.md") })
    .includes("graph/missing-path"));
});

test("per-instance findings are included in the whole-graph pass", () => {
  assert.ok(codes({ "design/issue/a.md": instance("class: issue\ntitle: A\nstatus: pending") })
    .includes("instance/invalid-enum-value"));
});

test("renderLinks writes outbound links then backlinks, deterministically", () => {
  const { graph } = build({
    "design/issue/a.md": OPEN("A", "blocks: [issue://b.md]\ndecided-by: [decision://d.md]"),
    "design/issue/b.md": OPEN("Bee", "blocks: [issue://a.md]"),
    "design/decision/d.md": instance("class: decision\ntitle: Dee"),
  });
  const rendered = renderLinks(graph, graph.instances.get("issue://a.md")!);
  assert.equal(rendered, [
    "- blocks: [Bee](b.md)",
    "- decided-by: [Dee](../decision/d.md)",
    "",
    "### Backlinks",
    "- blocks: [Bee](b.md)",
  ].join("\n"));
});

test("renderLinks falls back to the instance id when a target has no title", () => {
  const { graph } = build({
    "design/issue/a.md": OPEN("A", "attachment: [resource://spec.pdf]"),
    "design/resource/spec.pdf": "%PDF",
  });
  const rendered = renderLinks(graph, graph.instances.get("issue://a.md")!);
  assert.equal(rendered, "- attachment: [spec.pdf](../resource/spec.pdf)");
});

test("renderLinks returns an empty string for an unconnected instance", () => {
  const { graph } = build({ "design/issue/a.md": OPEN("A") });
  assert.equal(renderLinks(graph, graph.instances.get("issue://a.md")!), "");
});

test("a stale protected link block is reported", () => {
  const found = codes({
    "design/issue/a.md": instance(
      "class: issue\ntitle: A\nstatus: open\nblocks: [issue://b.md]",
      "\n<!-- design-docs:links start -->\n- blocks: [Wrong](zzz.md)\n<!-- design-docs:links end -->\n",
    ),
    "design/issue/b.md": OPEN("B"),
  });
  assert.ok(found.includes("graph/stale-links"));
});

test("a non-canonical uri in the yaml is reported as fixable", () => {
  const built = build({
    "design/issue/a.md": OPEN("A", "blocks: [design://issue/b.md]"),
    "design/issue/b.md": OPEN("B"),
  });
  const d = validateGraph(built.graph).find((x) => x.code === "graph/non-canonical-uri");
  assert.ok(d);
  assert.ok(d.fix);
});
