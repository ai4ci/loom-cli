import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModel } from "../src/model/mermaid.ts";
import { validateInstance } from "../src/instance.ts";
import { configFrom } from "../src/config.ts";
import { MODEL } from "./fixtures.ts";

const cfg = configFrom("/repo", { classRoots: { issue: "design/issue", src: ["src"] } });
const { schema } = parseModel(MODEL);

function codes(data: Record<string, unknown>, className = "issue"): string[] {
  return validateInstance(schema, cfg, {
    uri: `${className}://a.md`,
    className,
    data,
  }).map((d) => d.code);
}

const VALID = {
  class: "issue",
  id: "a.md",
  title: "A thing",
  created: "2026-01-05",
  status: "open",
  tags: ["x", "y"],
};

test("a well-formed instance validates clean", () => {
  assert.deepEqual(codes(VALID), []);
});

test("optional attributes may be omitted or present", () => {
  assert.deepEqual(codes({ ...VALID, assignee: "ada", priority: 3 }), []);
});

test("a missing required attribute is reported", () => {
  const { status, ...without } = VALID;
  assert.ok(codes(without).includes("instance/missing-required"));
});

test("an unknown key is reported", () => {
  assert.ok(codes({ ...VALID, nonsense: 1 }).includes("instance/unknown-key"));
});

test("a wrong scalar type is reported", () => {
  assert.ok(codes({ ...VALID, title: 42 }).includes("instance/type-mismatch"));
  assert.ok(codes({ ...VALID, priority: "high" }).includes("instance/type-mismatch"));
});

test("a bad date is reported", () => {
  assert.ok(codes({ ...VALID, created: "not-a-date" }).includes("instance/type-mismatch"));
});

test("a value outside an enumeration is reported", () => {
  assert.ok(codes({ ...VALID, status: "pending" }).includes("instance/invalid-enum-value"));
});

test("a scalar where a list is declared is reported", () => {
  assert.ok(codes({ ...VALID, tags: "x" }).includes("instance/type-mismatch"));
});

test("relations accept a list of uris", () => {
  assert.deepEqual(codes({ ...VALID, blocks: ["issue://b.md"] }), []);
});

test("a relation uri pointing at the wrong class is reported", () => {
  assert.ok(codes({ ...VALID, blocks: ["src://a.R"] }).includes("instance/wrong-target-class"));
});

test("a subclass is accepted where the parent class is the declared target", () => {
  const sub = parseModel(`${MODEL}
    class bug
    issue <|-- bug
`).schema;
  const found = validateInstance(sub, cfg, {
    uri: "issue://a.md",
    className: "issue",
    data: { ...VALID, blocks: ["bug://b.md"] },
  });
  assert.deepEqual(found.map((d) => d.code), []);
});

test("a malformed relation uri is reported", () => {
  assert.ok(codes({ ...VALID, blocks: ["nonsense"] }).includes("instance/invalid-uri"));
});

test("outbound cardinality is enforced", () => {
  // implemented-by is "0..*" src per issue, so any count is fine
  assert.deepEqual(codes({ ...VALID, "implemented-by": ["src://a.R", "src://b.R"] }), []);

  const limited = parseModel(`classDiagram
    class a {
        +string title
    }
    class b {
        +string title
    }
    a "0..*" --> "1" b : one
`).schema;
  const tooMany = validateInstance(limited, cfg, {
    uri: "a://x.md",
    className: "a",
    data: { title: "t", one: ["b://p.md", "b://q.md"] },
  });
  assert.ok(tooMany.some((d) => d.code === "instance/cardinality"));
});

test("an instance of an abstract class is reported", () => {
  assert.ok(codes({ title: "t", created: "2026-01-05" }, "designDoc")
    .includes("instance/not-instantiable"));
});

test("an instance of an unknown class is reported", () => {
  assert.ok(codes({}, "ghost").includes("instance/unknown-class"));
});

test("a declared class that disagrees with the location is reported", () => {
  assert.ok(codes({ ...VALID, class: "designDoc" }).includes("instance/class-mismatch"));
});

test("a declared id that disagrees with the location is reported", () => {
  assert.ok(codes({ ...VALID, id: "elsewhere.md" }).includes("instance/id-mismatch"));
});
