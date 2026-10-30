import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClassRoots, extractPathAnnotations } from "../src/path-resolution.ts";
import type { SchemaIR, ClassDef, Relation } from "../src/model/types.ts";

function cls(name: string, parents: string[] = [], instantiable = true): [string, ClassDef] {
  return [name, { name, annotations: [], attributes: [], members: [], parents, line: 0, declarations: 1 }];
}

function schema(defs: [string, ClassDef][], relations: Relation[] = []): SchemaIR {
  // Ensure terminal anchors and abstract/reserved classes exist
  const classes = new Map(defs);
  for (const k of ["src", "resource"]) {
    if (!classes.has(k)) classes.set(k, { name: k, annotations: [], attributes: [], members: [], parents: [], line: 0, declarations: 1 });
  }
  return { classes, relations, prefixes: new Map() };
}

const REPO_ROOT = "/repo";
const DESIGN_ROOT = "design";
const EXISTS = () => true;

test("a class with no annotation and no parent defaults to designRoot", () => {
  const s = schema([cls("issue")]);
  const { roots } = resolveClassRoots(s, new Map(), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("issue"), "design/issue");
});

test("a class with an absolute @path resolves repo-rooted", () => {
  const s = schema([cls("adr")]);
  const ann = new Map([["adr", { absolute: "architecture/records", relative: null, line: 1 }]]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("adr"), "architecture/records");
});

test("a class with a relative @path and no UML parent treats it as repo-relative", () => {
  const s = schema([cls("orphan")]);
  const ann = new Map([["orphan", { absolute: null, relative: "design/misc", line: 1 }]]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("orphan"), "design/misc");
});

test("a relative @path resolves against the first UML parent's root", () => {
  const s = schema([cls("issue"), cls("sub", ["issue"])]);
  const ann = new Map([
    ["issue", { absolute: "design/issue", relative: null, line: 1 }],
    ["sub", { absolute: null, relative: "extended", line: 2 }],
  ]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("sub"), "design/issue/extended");
});

test("a subclass of src with a relative @path resolves against src's root", () => {
  const s = schema([cls("src"), cls("test", ["src"])]);
  const ann = new Map([
    ["src", { absolute: "lib", relative: null, line: 1 }],
    ["test", { absolute: null, relative: "fixtures", line: 2 }],
  ]);
  const { roots, diagnostics } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("src"), "lib");
  assert.equal(roots.get("test"), "lib/fixtures");
});

test("a relative @path accumulates through a chain of relative parents", () => {
  const s = schema([cls("a"), cls("b", ["a"]), cls("c", ["b"])]);
  const ann = new Map([
    ["a", { absolute: "base", relative: null, line: 1 }],
    ["b", { absolute: null, relative: "mid", line: 2 }],
    ["c", { absolute: null, relative: "deep", line: 3 }],
  ]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("a"), "base");
  assert.equal(roots.get("b"), "base/mid");
  assert.equal(roots.get("c"), "base/mid/deep");
});

test("collision between classes with the same resolved path is reported", () => {
  const s = schema([cls("a"), cls("b")]);
  const ann = new Map([
    ["a", { absolute: "design/collide", relative: null, line: 1 }],
    ["b", { absolute: "design/collide", relative: null, line: 2 }],
  ]);
  const { diagnostics } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.ok(diagnostics.some((d) => d.code === "path/collision"));
});

test("inheritance chain resolves children without annotations under their parent", () => {
  const s = schema([cls("top"), cls("mid", ["top"]), cls("bottom", ["mid"])]);
  const ann = new Map([["top", { absolute: "base", relative: null, line: 1 }]]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("top"), "base");
  assert.equal(roots.get("mid"), "base/mid");
  assert.equal(roots.get("bottom"), "base/mid/bottom");
});

test("a relative @path on a sub-subclass inherits through the chain", () => {
  const s = schema([cls("issue"), cls("feature", ["issue"]), cls("epic", ["feature"])]);
  const ann = new Map([
    ["issue", { absolute: "design/issue", relative: null, line: 1 }],
    ["epic", { absolute: null, relative: "big", line: 2 }],
  ]);
  const { roots } = resolveClassRoots(s, ann, REPO_ROOT, DESIGN_ROOT, EXISTS);
  // epic's relative @path resolves against issue (first resolved ancestor), not feature (unresolved)
  assert.equal(roots.get("issue"), "design/issue");
  assert.equal(roots.get("epic"), "design/issue/big");
});
