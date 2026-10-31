import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClassRoots } from "../src/path-resolution.ts";
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

test("a class with no prefix and no parent defaults under @base", () => {
  const s = schema([cls("issue")]);
  const { roots } = resolveClassRoots(s, new Map(), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("issue"), "design/issue");
});

test("a repo: prefix resolves repo-rooted", () => {
  const s = schema([cls("adr")]);
  const { roots } = resolveClassRoots(s, new Map([["adr", "repo:architecture/records/"]]), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("adr"), "architecture/records");
});

test("a relative prefix resolves against @base, not the parent", () => {
  const s = schema([cls("issue"), cls("sub", ["issue"])]);
  const p = new Map([["issue", "repo:work/issue/"], ["sub", "extended/"]]);
  const { roots } = resolveClassRoots(s, p, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("sub"), "design/extended");
});

test("subclasses of src nest under src's root", () => {
  const s = schema([cls("src"), cls("test", ["src"])]);
  const { roots } = resolveClassRoots(s, new Map([["src", "repo:lib/"]]), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("src"), "lib");
  assert.equal(roots.get("test"), "lib/test");
});

test("collision between classes with the same resolved path is reported", () => {
  const s = schema([cls("a"), cls("b")]);
  const p = new Map([["a", "repo:design/collide/"], ["b", "repo:design/collide/"]]);
  const { diagnostics } = resolveClassRoots(s, p, REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.ok(diagnostics.some((d) => d.code === "path/collision"));
});

test("inheritance chain resolves children without prefixes under their parent", () => {
  const s = schema([cls("top"), cls("mid", ["top"]), cls("bottom", ["mid"])]);
  const { roots } = resolveClassRoots(s, new Map([["top", "repo:base/"]]), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.equal(roots.get("top"), "base");
  assert.equal(roots.get("mid"), "base/mid");
  assert.equal(roots.get("bottom"), "base/mid/bottom");
});

test("a path escaping the repository is reported", () => {
  const s = schema([cls("a")]);
  const { diagnostics } = resolveClassRoots(s, new Map([["a", "../../out/"]]), REPO_ROOT, DESIGN_ROOT, EXISTS);
  assert.ok(diagnostics.some((d) => d.code === "path/escapes-repo"));
});
