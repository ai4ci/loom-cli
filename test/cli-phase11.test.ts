import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    class issue {
        +string title
    }
    issue "1" --> "0..*" src : implemented-by
`;

const CONFIG = "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src]\n";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/** A repository with one commit, so HEAD can be compared against. */
function committed(files: Record<string, string>): string {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": MODEL,
    ...files,
  });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

test("a renamed function is inferred from HEAD and offered as a fix", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#runApp]"),
    "src/app.ts": "export function runApp() {\n  return compute(1, 2, 3);\n}\n",
  });
  // Rename the function, keeping the body identical.
  writeFileSync(path.join(root, "src/app.ts"), "export function launchApp() {\n  return compute(1, 2, 3);\n}\n");

  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const d = (parse(r.out) as any).diagnostics.find((x: any) => x.code === "graph/renamed-symbol");
  assert.ok(d, "expected a rename diagnostic");
  assert.match(d.fix, /launchApp/);
});

test("--fix rewrites an inferred rename", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#runApp]"),
    "src/app.ts": "export function runApp() {\n  return compute(1, 2, 3);\n}\n",
  });
  writeFileSync(path.join(root, "src/app.ts"), "export function launchApp() {\n  return compute(1, 2, 3);\n}\n");

  const fixed = await run(["--cwd", root, "validate", "--fix"]);
  assert.equal(fixed.code, 0, "the repaired repository validates clean");
  assert.match(
    readFileSync(path.join(root, "design/issue/one.md"), "utf8"),
    /src:\/\/app\.ts#launchApp/,
  );
});

test("a genuinely deleted function is not reported as a rename", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#gone]"),
    "src/app.ts": "export function gone() {\n  return 1;\n}\nexport function other() {\n  return 999;\n}\n",
  });
  // Remove it entirely; `other` is unrelated and has a different body.
  writeFileSync(path.join(root, "src/app.ts"), "export function other() {\n  return 999;\n}\n");

  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const codes = (parse(r.out) as any).diagnostics.map((d: any) => d.code);
  assert.ok(codes.includes("graph/missing-symbol"));
  assert.equal(codes.includes("graph/renamed-symbol"), false);
});

test("a rename with a changed body is not inferred", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#runApp]"),
    "src/app.ts": "export function runApp() {\n  return compute(1, 2, 3);\n}\n",
  });
  writeFileSync(
    path.join(root, "src/app.ts"),
    "export function launchApp() {\n  const a = somethingEntirelyDifferent();\n  return a * 42;\n}\n",
  );
  const r = await run(["--cwd", root, "validate"]);
  const codes = (parse(r.out) as any).diagnostics.map((d: any) => d.code);
  assert.equal(codes.includes("graph/renamed-symbol"), false);
});

test("drift detection is skipped outside a git repository", async () => {
  const root = makeRepo({
    ".design-docs.yaml": CONFIG,
    "design/document-model.mmd": MODEL,
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src://app.ts#gone]"),
    "src/app.ts": "export function other() {}\n",
  });
  // makeRepo creates a .git directory but no commits, so HEAD does not resolve.
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const codes = (parse(r.out) as any).diagnostics.map((d: any) => d.code);
  assert.ok(codes.includes("graph/missing-symbol"), "still reports the broken anchor");
});
