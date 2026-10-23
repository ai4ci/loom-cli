import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModel } from "../src/model/mermaid.ts";
import {
  effectiveAttributes,
  effectiveRelations,
  isSubclassOf,
  validateModel,
} from "../src/model/schema.ts";
import { MODEL } from "./fixtures.ts";

function codesOf(model: string): string[] {
  const { schema, diagnostics } = parseModel(model);
  return [...diagnostics, ...validateModel(schema)].map((d) => d.code);
}

test("the reference model validates clean", () => {
  assert.deepEqual(codesOf(MODEL), []);
});

test("inherited attributes are visible on the subclass", () => {
  const { schema } = parseModel(MODEL);
  assert.deepEqual(
    effectiveAttributes(schema, "issue").map((a) => a.name).sort(),
    ["assignee", "created", "priority", "status", "tags", "title"],
  );
});

test("relations are inherited by subclasses", () => {
  const { schema } = parseModel(`classDiagram
    class base {
        <<abstract>>
    }
    class derived
    class other
    base <|-- derived
    base --> other : rel
`);
  assert.deepEqual(effectiveRelations(schema, "derived").map((r) => r.name), ["rel"]);
});

test("isSubclassOf is reflexive and transitive", () => {
  const { schema } = parseModel(`classDiagram
    class a
    class b
    class c
    a <|-- b
    b <|-- c
`);
  assert.equal(isSubclassOf(schema, "c", "a"), true);
  assert.equal(isSubclassOf(schema, "a", "a"), true);
  assert.equal(isSubclassOf(schema, "a", "c"), false);
});

test("an unknown attribute type is rejected", () => {
  assert.ok(codesOf("classDiagram\n    class a {\n        +Nonsense x\n    }\n")
    .includes("model/unknown-type"));
});

test("a duplicate class is rejected", () => {
  assert.ok(codesOf("classDiagram\n    class a\n    class a\n").includes("model/duplicate-class"));
});

test("an attribute colliding with a relation name is rejected", () => {
  assert.ok(codesOf(`classDiagram
    class a {
        +string blocks
    }
    class b
    a --> b : blocks
`).includes("model/name-collision"));
});

test("a collision with an inherited name is rejected", () => {
  assert.ok(codesOf(`classDiagram
    class base {
        <<abstract>>
        +string title
    }
    class derived {
        +int title
    }
    base <|-- derived
`).includes("model/name-collision"));
});

test("an enumeration with no members is rejected", () => {
  assert.ok(codesOf(`classDiagram
    class a {
        +Empty x
    }
    class Empty {
        <<enumeration>>
    }
`).includes("model/empty-enumeration"));
});

test("an inheritance cycle is rejected", () => {
  assert.ok(codesOf("classDiagram\n    class a\n    class b\n    a <|-- b\n    b <|-- a\n")
    .includes("model/inheritance-cycle"));
});

test("structured attributes on a reserved class are rejected", () => {
  assert.ok(codesOf("classDiagram\n    class src {\n        +string x\n    }\n")
    .includes("model/reserved-has-attributes"));
  assert.ok(codesOf("classDiagram\n    class resource {\n        +string x\n    }\n")
    .includes("model/reserved-has-attributes"));
});

test("a src subclass may not declare attributes either", () => {
  assert.ok(codesOf(`classDiagram
    class src
    class test {
        +string owner
    }
    src <|-- test
`).includes("model/reserved-has-attributes"));
});

test("a value type declaring relations is rejected", () => {
  assert.ok(codesOf(`classDiagram
    class a {
        +Contact reporter
    }
    class Contact {
        <<abstract>>
        +string name
    }
    class b
    Contact --> b : rel
`).includes("model/value-type-has-relations"));
});

test("a cycle in value-type containment is rejected", () => {
  assert.ok(codesOf(`classDiagram
    class a {
        +X x
    }
    class X {
        <<abstract>>
        +Y y
    }
    class Y {
        <<abstract>>
        +X x
    }
`).includes("model/value-type-cycle"));
});

test("a relation endpoint naming an unknown class is rejected", () => {
  assert.ok(codesOf("classDiagram\n    class a\n    a --> ghost : rel\n")
    .includes("model/unknown-class"));
});

test("a class that can be a relation target without a title is warned about", () => {
  const { schema } = parseModel(`classDiagram
    class a
    class b
    a --> b : rel
`);
  const d = validateModel(schema).find((x) => x.code === "model/no-title-attribute");
  assert.ok(d);
  assert.equal(d.severity, "warning");
});

test("inheritance naming an unknown class is rejected", () => {
  assert.ok(codesOf("classDiagram\n    class a\n    a <|-- ghost\n").includes("model/unknown-class"));
});
