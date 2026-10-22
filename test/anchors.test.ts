import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeComment,
  DEFAULT_ANCHOR_POLICY,
  extractAnchors,
  extractReverseLinks,
  resolveAnchor,
  shortestUnambiguousName,
} from "../src/source.ts";

const names = (code: string, lang: string) =>
  extractAnchors(code, lang).map((a) => a.fullName);

test("anchors are filtered to the configured kinds", () => {
  const ts = `
import { x } from "./x";
const TOP = 1;
type Alias = string;
export interface Shape { area(): number; }
export enum Colour { Red }
export class Alpha { run() {} }
export function free() {}
`;
  assert.deepEqual(names(ts, "typescript"), ["Shape", "Colour", "Alpha", "Alpha.run", "free"]);
});

test("nested anchors get dotted names", () => {
  const py = `
class Worker:
    def process(self): pass
    class Inner:
        def deep(self): pass
`;
  assert.deepEqual(names(py, "python"), [
    "Worker", "Worker.process", "Worker.Inner", "Worker.Inner.deep",
  ]);
});

test("transparent kinds are skipped but their children are kept", () => {
  const rs = `
pub trait Draw { fn draw(&self); }
pub struct Sq;
impl Draw for Sq { fn draw(&self) {} }
mod inner { pub fn nested() {} }
`;
  // Impl and Module are transparent, so `draw` and `nested` hoist to the top.
  const found = names(rs, "rust");
  assert.ok(found.includes("draw"), `expected hoisted draw, got ${found.join(", ")}`);
  assert.ok(found.includes("nested"), `expected hoisted nested, got ${found.join(", ")}`);
  assert.equal(found.includes("Draw.draw"), false, "impl must not contribute a level");
});

test("a unique bare name resolves", () => {
  const anchors = extractAnchors("export class A { run() {} }", "typescript");
  const r = resolveAnchor(anchors, "run");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.anchor.fullName, "A.run");
});

test("an ambiguous bare name is an error listing qualified candidates", () => {
  const ts = `class Alpha { run() {} }
class Beta { run() {} }`;
  const r = resolveAnchor(extractAnchors(ts, "typescript"), "run");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "ambiguous");
  assert.deepEqual(!r.ok && r.reason === "ambiguous" ? r.candidates.sort() : [], [
    "Alpha.run", "Beta.run",
  ]);
});

test("a dotted name disambiguates", () => {
  const ts = `class Alpha { run() {} }
class Beta { run() {} }`;
  const anchors = extractAnchors(ts, "typescript");
  const r = resolveAnchor(anchors, "Beta.run");
  assert.equal(r.ok && r.anchor.line, 2);
});

test("a missing anchor is not-found, not ambiguous", () => {
  const r = resolveAnchor(extractAnchors("function a() {}", "typescript"), "ghost");
  assert.equal(!r.ok && r.reason, "not-found");
});

test("overloads are distinguished by normalised parameter types", () => {
  const java = `public class C {
    public void run(String name) { }
    public void run(int count) { }
    public void run(String name, int count) { }
    public void run() { }
}`;
  const anchors = extractAnchors(java, "java");

  assert.equal(resolveAnchor(anchors, "C.run(String)").ok, true);
  assert.equal(resolveAnchor(anchors, "C.run(int)").ok, true);
  assert.equal(resolveAnchor(anchors, "C.run(String,int)").ok, true);
  assert.equal(resolveAnchor(anchors, "C.run()").ok, true);

  const r1 = resolveAnchor(anchors, "C.run(String)");
  const r2 = resolveAnchor(anchors, "C.run(int)");
  assert.notEqual(r1.ok && r1.anchor.line, r2.ok && r2.anchor.line);

  // The bare name is ambiguous and reports every qualified form.
  const bare = resolveAnchor(anchors, "C.run");
  assert.equal(!bare.ok && bare.reason, "ambiguous");
});

test("parameter types are normalised", () => {
  const java = `class C {
    void a(java.util.List<String> v) { }
    void b(int... rest) { }
}`;
  const anchors = extractAnchors(java, "java");
  // Qualified paths reduce to their last segment; generics are kept.
  assert.equal(resolveAnchor(anchors, "C.a(List<String>)").ok, true);
  // Varargs become an array.
  assert.equal(resolveAnchor(anchors, "C.b(int[])").ok, true);
});

test("typescript parameter types drop the leading colon", () => {
  const ts = `class C { run(a: string, b: number) {} }`;
  assert.equal(resolveAnchor(extractAnchors(ts, "typescript"), "C.run(string,number)").ok, true);
});

test("a parameter with no resolvable type becomes an underscore", () => {
  const py = `class C:
    def run(self, a): pass`;
  assert.equal(resolveAnchor(extractAnchors(py, "python"), "C.run(_,_)").ok, true);
});

test("shortestUnambiguousName strips a redundant qualifier", () => {
  const ts = `class A { run() {} }`;
  const anchors = extractAnchors(ts, "typescript");
  const a = anchors.find((x) => x.name === "run")!;
  assert.equal(shortestUnambiguousName(a, anchors), "run");
});

test("shortestUnambiguousName keeps what is needed", () => {
  const ts = `class Alpha { run() {} }
class Beta { run() {} }`;
  const anchors = extractAnchors(ts, "typescript");
  const a = anchors.find((x) => x.fullName === "Alpha.run")!;
  assert.equal(shortestUnambiguousName(a, anchors), "Alpha.run");
});

test("declarations without a body report no bodySpan", () => {
  const java = `interface I { void decl(); }
abstract class A { abstract void abs(); void real() { } }`;
  const anchors = extractAnchors(java, "java");
  const by = (n: string) => anchors.find((a) => a.fullName === n);
  assert.equal(by("I.decl")?.bodySpan, undefined);
  assert.equal(by("A.abs")?.bodySpan, undefined);
  assert.ok(by("A.real")?.bodySpan, "a real method has a body");
});

// --- attribution -----------------------------------------------------------

test("a comment attributes to the innermost enclosing body", () => {
  const ts = `class Service {
  run() {
    // here
  }
}`;
  const anchors = extractAnchors(ts, "typescript");
  const at = ts.indexOf("// here");
  assert.equal(attributeComment(at, anchors)?.fullName, "Service.run");
});

test("a comment in a class body attributes to the class, not the next method", () => {
  const ts = `class Service {
  // here
  run() { }
}`;
  const anchors = extractAnchors(ts, "typescript");
  const at = ts.indexOf("// here");
  assert.equal(attributeComment(at, anchors)?.fullName, "Service");
});

test("a comment outside every body attributes to nothing", () => {
  const ts = `// here
class Service { run() { } }`;
  const anchors = extractAnchors(ts, "typescript");
  assert.equal(attributeComment(ts.indexOf("// here"), anchors), null);
});

test("decorators do not break attribution", () => {
  const py = `class C:
    @fixture
    @other
    def thing(self):
        # here
        pass`;
  const anchors = extractAnchors(py, "python");
  assert.equal(attributeComment(py.indexOf("# here"), anchors)?.fullName, "C.thing");
});

test("extractReverseLinks uses body containment", () => {
  const ts = `// file level
export class Service {
  // documents: issue://cls.md
  run() {
    // implements: issue://run.md
    return 1;
  }
}`;
  const links = extractReverseLinks(ts, "typescript");
  const byTarget = Object.fromEntries(links.map((l) => [l.target, l.enclosingSymbol ?? null]));
  assert.equal(byTarget["issue://run.md"], "Service.run");
  assert.equal(byTarget["issue://cls.md"], "Service");
});

test("the default policy is exported and excludes containers", () => {
  assert.ok(DEFAULT_ANCHOR_POLICY.anchorKinds.includes("Function"));
  assert.ok(DEFAULT_ANCHOR_POLICY.transparentKinds.includes("Impl"));
  assert.equal(DEFAULT_ANCHOR_POLICY.anchorKinds.includes("Module"), false);
});
