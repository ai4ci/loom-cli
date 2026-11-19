import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix src: <repo:src/> .
    class issue {
        +string title
    }
    issue "0..*" --> "0..*" issue : blocks
    issue "0..*" --> "0..*" src : implemented-by
    src "0..*" --> "0..*" issue : implements
`;

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/** A repository with one commit, so renames can be read out of git. */
function committed(files: Record<string, string>): string {
  const root = makeRepo({ "design/document-model.mmd": MODEL, ...files });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const diagnostics = (out: string): { code: string; fix?: string }[] =>
  (parse(out) as { diagnostics: { code: string; fix?: string }[] }).diagnostics;

// --- #7: unlinking something whose other end has gone -----------------------

test("a reverse link survives its document being deleted long enough to unlink it", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/app.ts": "export function runApp() {\n  // implements: issue:one.md\n  return 1;\n}\n",
  });
  rmSync(path.join(root, "design/issue/one.md"));

  const r = await run(["--cwd", root, "unlink", "src:app.ts#runApp", "implements", "issue:one.md"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.doesNotMatch(readFileSync(path.join(root, "src/app.ts"), "utf8"), /implements: issue:one\.md/);
});

test("linking to a document that does not exist is still refused", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });

  const r = await run(["--cwd", root, "link", "src:app.ts#runApp", "implements", "issue:nope.md"]);
  assert.equal(r.code, 1);
  assert.ok(diagnostics(r.out).some((d) => d.code === "changeset/not-found"));
});

// --- #8: links to files git knows were moved --------------------------------

test("a committed rename of a source file is reported with the new uri", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src:app.ts#runApp]"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });
  git(root, "mv", "src/app.ts", "src/main.ts");
  git(root, "commit", "-q", "-m", "move");

  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1);
  const d = diagnostics(r.out).find((x) => x.code === "graph/renamed-file");
  assert.ok(d, `expected graph/renamed-file, got ${JSON.stringify(diagnostics(r.out))}`);
  assert.match(d.fix ?? "", /src:main\.ts#runApp/);
});

test("--fix rewrites links to a renamed source file, anchor and all", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src:app.ts#runApp]"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });
  git(root, "mv", "src/app.ts", "src/main.ts");
  git(root, "commit", "-q", "-m", "move");

  const fixed = await run(["--cwd", root, "validate", "--fix"]);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.match(readFileSync(path.join(root, "design/issue/one.md"), "utf8"), /src:main\.ts#runApp/);
});

test("a staged but uncommitted rename is detected too", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src:app.ts]"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });
  git(root, "mv", "src/app.ts", "src/main.ts");

  const r = await run(["--cwd", root, "validate"]);
  assert.ok(diagnostics(r.out).some((d) => d.code === "graph/renamed-file"));
});

test("a renamed instance file is followed as well", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nblocks: [issue:two.md]"),
    "design/issue/two.md": instance("class: issue\ntitle: Two"),
  });
  git(root, "mv", "design/issue/two.md", "design/issue/three.md");
  git(root, "commit", "-q", "-m", "move");

  const fixed = await run(["--cwd", root, "validate", "--fix"]);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.match(readFileSync(path.join(root, "design/issue/one.md"), "utf8"), /issue:three\.md/);
});

test("a deleted file is reported missing, not renamed", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src:app.ts]"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });
  git(root, "rm", "-q", "src/app.ts");
  git(root, "commit", "-q", "-m", "delete");

  const r = await run(["--cwd", root, "validate"]);
  const codes = diagnostics(r.out).map((d) => d.code);
  assert.ok(codes.includes("graph/missing-source-file"));
  assert.equal(codes.includes("graph/renamed-file"), false);
});

test("an untracked move git cannot see is reported missing", async () => {
  const root = committed({
    "design/issue/one.md": instance("class: issue\ntitle: One\nimplemented-by: [src:app.ts]"),
    "src/app.ts": "export function runApp() {\n  return 1;\n}\n",
  });
  // A plain filesystem move, never staged: git has no rename to offer.
  writeFileSync(path.join(root, "src/main.ts"), readFileSync(path.join(root, "src/app.ts"), "utf8"));
  rmSync(path.join(root, "src/app.ts"));

  const r = await run(["--cwd", root, "validate"]);
  const codes = diagnostics(r.out).map((d) => d.code);
  assert.ok(codes.includes("graph/missing-source-file"));
  assert.equal(codes.includes("graph/renamed-file"), false);
});
