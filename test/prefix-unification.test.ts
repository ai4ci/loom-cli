// Acceptance tests for the unified `%% @prefix` scheme — design/prototype.md
// cases 1–6 and design/prefix-unification.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractPrefixAnnotations, resolveClassRoots } from "../src/path-resolution.ts";
import { parseModel } from "../src/model/mermaid.ts";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const EXISTS = () => true;

function resolve(model: string, base: string) {
  const { schema, comments } = parseModel(model);
  const diagnostics: { code: string }[] = [];
  const prefixes = extractPrefixAnnotations(comments, diagnostics as any);
  const result = resolveClassRoots(schema, prefixes, "/repo", base, EXISTS);
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}

const codes = (d: { code: string }[]) => d.map((x) => x.code);

test("turtle form `<target> .` is accepted", () => {
  const diags: any[] = [];
  const p = extractPrefixAnnotations([{ text: "%% @prefix src: <repo:src/> .", line: 1 }], diags);
  assert.deepEqual(diags, []);
  assert.equal(p.get("src"), "repo:src/");
});

test("case 1: repo: targets escape the model directory; src needs no special case", () => {
  const { roots, diagnostics } = resolve(`%% @prefix issue: <repo:issues/> .
%% @prefix src: <repo:src/> .
classDiagram
    class src
    class issue {
        +string title
    }
    class test
    src <|-- test
`, "design");
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(roots.get("issue"), "issues");
  assert.equal(roots.get("src"), "src");
  assert.equal(roots.get("test"), "src/test");
});

test("case 1: without a src prefix, src defaults under @base like any class", () => {
  const { roots } = resolve(`classDiagram
    class src
    class issue {
        +string title
    }
`, "design");
  assert.equal(roots.get("src"), "design/src");
  assert.equal(roots.get("issue"), "design/issue");
});

test("case 2: model at repo root needs no annotations", () => {
  const { roots } = resolve(`classDiagram
    class src
    class issue {
        +string title
    }
    class test
    src <|-- test
`, "");
  assert.equal(roots.get("issue"), "issue");
  assert.equal(roots.get("src"), "src");
  assert.equal(roots.get("test"), "src/test");
});

test("case 3: a relative target resolves against @base, ../ included", () => {
  const { roots } = resolve(`%% @prefix src: <../src/> .
classDiagram
    class src
`, "packages/web/design");
  assert.equal(roots.get("src"), "packages/web/src");
});

test("case 4: terminal-anchor subclasses nest like any other class", () => {
  const { roots, diagnostics } = resolve(`%% @prefix src: <repo:server/src/> .
%% @prefix resource: <repo:assets/> .
classDiagram
    class src
    class resource
    class main
    class fixture
    src <|-- main
    resource <|-- fixture
`, "design");
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(roots.get("main"), "server/src/main");
  assert.equal(roots.get("fixture"), "assets/fixture");
});

test("case 5: multiple parents without a prefix are an error", () => {
  const { diagnostics } = resolve(`%% @prefix src: <repo:src/> .
%% @prefix test: <repo:tests/> .
classDiagram
    class src
    class test
    class main
    src <|-- main
    test <|-- main
`, "design");
  assert.ok(codes(diagnostics).includes("path/ambiguous-inheritance"));
});

test("case 5: an explicit prefix resolves the multiple-parent ambiguity", () => {
  const { roots, diagnostics } = resolve(`%% @prefix src: <repo:src/> .
%% @prefix test: <repo:tests/> .
%% @prefix main: <repo:src/main/> .
classDiagram
    class src
    class test
    class main
    src <|-- main
    test <|-- main
`, "design");
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(roots.get("main"), "src/main");
});

test("case 6: absolute targets are external and ignore @base", () => {
  const { roots, external } = resolve(`%% @prefix issue: <issue/> .
%% @prefix gh: <https://github.com/my-org/my-repo/issues/> .
%% @prefix data: <file:///srv/shared-data/> .
classDiagram
    class issue {
        +string title
    }
    class gh
    class data
`, "design");
  assert.equal(roots.get("issue"), "design/issue");
  assert.equal(external.get("gh"), "https://github.com/my-org/my-repo/issues/");
  assert.equal(external.get("data"), "file:///srv/shared-data/");
});

test("an abstract parent has no root; its subclass defaults under @base", () => {
  const { roots } = resolve(`classDiagram
    class resource {
        <<abstract>>
    }
    class fixture
    resource <|-- fixture
`, "design");
  assert.equal(roots.get("resource"), null);
  assert.equal(roots.get("fixture"), "design/fixture");
});

test("%% @path is removed: a hard error naming the @prefix replacement", () => {
  const diags: { code: string; fix?: string }[] = [];
  extractPrefixAnnotations([{ text: "%% @path issue /docs/issues", line: 1 }], diags as any);
  assert.deepEqual(codes(diags), ["model/path-removed"]);
  assert.match(diags[0]!.fix!, /%% @prefix issue: <repo:docs\/issues\/> \./);
});

// --- LOOM_REPO_ROOT (case 3, mitigation B) -------------------------------

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "loom-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

test("case 3: repo: anchors at the git root by default", async () => {
  const root = gitRepo({
    "packages/web/design/document-model.mmd": `%% @prefix src: <repo:src/> .
classDiagram
    class src
`,
    "src/a.ts": "export const a = 1;\n",
  });
  const r = await run(["--cwd", path.join(root, "packages/web"), "--json", "resolve", "src:a.ts"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(JSON.parse(r.out).path, "src/a.ts");
});

test("case 3: LOOM_REPO_ROOT makes a package a self-contained loom", async () => {
  const root = gitRepo({
    "packages/web/design/document-model.mmd": `%% @prefix src: <repo:src/> .
classDiagram
    class src
`,
    "packages/web/src/a.ts": "export const a = 1;\n",
  });
  process.env["LOOM_REPO_ROOT"] = path.join(root, "packages/web");
  try {
    const r = await run(["--cwd", path.join(root, "packages/web"), "--json", "resolve", "src:a.ts"]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(JSON.parse(r.out).path, "src/a.ts");
    assert.equal(JSON.parse(r.out).exists, true);
  } finally {
    delete process.env["LOOM_REPO_ROOT"];
  }
});

test("validate works end-to-end with a relative prefix", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `%% @prefix issue: <issues/> .
classDiagram
    class issue {
        +string title
    }
`,
    "design/issues/a.md": instance("title: A"),
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 0, r.err + r.out);
});

test("rebuild writes the generated namespaces.ttl next to the model", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `%% @prefix src: <repo:src/> .
%% @prefix gh: <https://github.com/org/repo/issues/> .
classDiagram
    class src
    class main
    class gh
    class issue {
        +string title
    }
    class status {
        <<enumeration>>
        open
    }
    src <|-- main
`,
  });
  const r = await run(["--cwd", root, "rebuild"]);
  assert.equal(r.code, 0, r.err + r.out);
  const { readFileSync } = await import("node:fs");
  const ttl = readFileSync(path.join(root, "design/.loom/namespaces.ttl"), "utf8");
  assert.match(ttl, /^# Generated by loom from design\/document-model\.mmd — do not edit\./);
  assert.match(ttl, /^@base <repo:design\/> \.$/m);
  assert.match(ttl, /^@prefix issue: <repo:design\/issue\/> \.$/m);
  assert.match(ttl, /^@prefix src: <repo:src\/> \.$/m);
  assert.match(ttl, /^@prefix main: <repo:src\/main\/> \.$/m);
  assert.match(ttl, /^@prefix gh: <https:\/\/github\.com\/org\/repo\/issues\/> \.$/m);
  assert.doesNotMatch(ttl, /status:/);
});
