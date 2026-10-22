import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModel } from "../src/model/mermaid.ts";
import { MODEL } from "./fixtures.ts";

test("parseModel reads classes, annotations and attributes", () => {
  const { schema, diagnostics } = parseModel(MODEL);
  assert.deepEqual(diagnostics, []);

  const issue = schema.classes.get("issue")!;
  assert.deepEqual(issue.attributes.map((a) => a.name), [
    "status", "assignee", "tags", "priority",
  ]);
  assert.equal(issue.attributes.find((a) => a.name === "status")!.required, true);
  assert.equal(issue.attributes.find((a) => a.name === "assignee")!.required, false);
});

test("parseModel ignores methods", () => {
  const { schema } = parseModel(MODEL);
  assert.equal(schema.classes.get("issue")!.attributes.some((a) => a.name === "getSummary"), false);
});

test("parseModel types attributes as primitive, enum, class or list", () => {
  const { schema } = parseModel(MODEL);
  const by = (n: string) =>
    schema.classes.get("issue")!.attributes.find((a) => a.name === n)!;

  assert.deepEqual(by("status").type, { kind: "enum", className: "IssueStatus" });
  assert.deepEqual(by("assignee").type, { kind: "primitive", name: "string" });
  assert.deepEqual(by("tags").type, { kind: "primitive", name: "string" });
  assert.equal(by("tags").list, true);
  assert.equal(by("assignee").list, false);
  assert.deepEqual(by("priority").type, { kind: "primitive", name: "int" });
});

test("parseModel records annotations and enumeration members", () => {
  const { schema } = parseModel(MODEL);
  assert.deepEqual(schema.classes.get("designDoc")!.annotations, ["abstract"]);
  assert.deepEqual(schema.classes.get("IssueStatus")!.annotations, ["enumeration"]);
  assert.deepEqual(schema.classes.get("IssueStatus")!.members, ["open", "closed"]);
});

test("parseModel records inheritance", () => {
  const { schema } = parseModel(MODEL);
  assert.deepEqual(schema.classes.get("issue")!.parents, ["designDoc"]);
});

test("parseModel reads relations with both cardinalities", () => {
  const { schema } = parseModel(MODEL);
  const blocks = schema.relations.find((r) => r.name === "blocks")!;
  assert.equal(blocks.from, "issue");
  assert.equal(blocks.to, "issue");
  assert.deepEqual(blocks.toCardinality, { min: 0, max: null });

  // "each issue is implemented-by 0..* src; each src by exactly 1 issue"
  const impl = schema.relations.find((r) => r.name === "implemented-by")!;
  assert.equal(impl.from, "issue");
  assert.equal(impl.to, "src");
  assert.deepEqual(impl.fromCardinality, { min: 1, max: 1 });
  assert.deepEqual(impl.toCardinality, { min: 0, max: null });
});

test("a reversed arrow flips source and target but keeps each cardinality with its class", () => {
  const { schema } = parseModel(`classDiagram
    class a
    class b
    a "1" <-- "0..*" b : owns
`);
  const owns = schema.relations.find((r) => r.name === "owns")!;
  assert.equal(owns.from, "b");
  assert.equal(owns.to, "a");
  assert.deepEqual(owns.fromCardinality, { min: 0, max: null });
  assert.deepEqual(owns.toCardinality, { min: 1, max: 1 });
});

test("parseModel rejects composition and aggregation arrows", () => {
  for (const glyph of ["*--", "o--", "--*", "--o"]) {
    const { diagnostics } = parseModel(`classDiagram\n    class a\n    class b\n    a ${glyph} b : owns\n`);
    assert.ok(
      diagnostics.some((d) => d.code === "model/composition-arrow"),
      `expected ${glyph} to be rejected`,
    );
  }
});

test("parseModel rejects an unnamed association", () => {
  const { diagnostics } = parseModel("classDiagram\n    class a\n    class b\n    a --> b\n");
  assert.ok(diagnostics.some((d) => d.code === "model/unnamed-relation"));
});

test("parseModel reports a syntax error with a line number", () => {
  const { diagnostics } = parseModel("classDiagram\n    class a {\n        +string[] bad\n    }\n");
  const syntax = diagnostics.find((d) => d.code === "model/syntax");
  assert.ok(syntax, "expected a syntax diagnostic");
  assert.equal(typeof syntax.line, "number");
});

test("parseModel accepts standalone member and annotation statements", () => {
  const { schema, diagnostics } = parseModel(`classDiagram
    class a
    a : +string title
    <<abstract>> a
`);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(schema.classes.get("a")!.attributes.map((x) => x.name), ["title"]);
  assert.deepEqual(schema.classes.get("a")!.annotations, ["abstract"]);
});

test("cardinality shorthands parse", () => {
  const { schema } = parseModel(`classDiagram
    class a
    class b
    a "*" --> "1..*" b : r1
    a "0..1" --> "2" b : r2
`);
  const r1 = schema.relations.find((r) => r.name === "r1")!;
  const r2 = schema.relations.find((r) => r.name === "r2")!;
  assert.deepEqual(r1.fromCardinality, { min: 0, max: null });
  assert.deepEqual(r1.toCardinality, { min: 1, max: null });
  assert.deepEqual(r2.fromCardinality, { min: 0, max: 1 });
  assert.deepEqual(r2.toCardinality, { min: 2, max: 2 });
});

test("a relation with no cardinality defaults to 0..*", () => {
  const { schema } = parseModel("classDiagram\n    class a\n    class b\n    a --> b : r\n");
  const r = schema.relations.find((x) => x.name === "r")!;
  assert.deepEqual(r.toCardinality, { min: 0, max: null });
  assert.deepEqual(r.fromCardinality, { min: 0, max: null });
});
