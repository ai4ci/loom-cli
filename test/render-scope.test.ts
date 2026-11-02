import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

/** Real git repo (render's check-ignore pass needs one). */
function gitRepo(files: Record<string, string>): string {
  const root = makeRepo(files);
  execFileSync("rm", ["-rf", path.join(root, ".git")]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

// A model with one named view, `backlog`.
const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class issue {
        +string title
    }

    %% @view backlog
    %% SELECT uri, title FROM issue
`;

function repoWithIssue(extra: Record<string, string> = {}): string {
  return makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: Alpha"),
    ...extra,
  });
}

// Defect 1: markers inside fenced blocks and inline code are documentation.
test("render leaves markers inside fenced code blocks alone", async () => {
  const docs = [
    "# Docs",
    "",
    "```markdown",
    "<!-- loom view: backlog -->",
    "<!-- loom view: backlog end -->",
    "```",
    "",
  ].join("\n");
  const root = repoWithIssue({ "design/doc.md": docs });
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(path.join(root, "design/doc.md"), "utf8"), docs);
});

test("render leaves markers inside inline code spans alone", async () => {
  const docs = "Run `loom render` when a `<!-- loom view: backlog -->` needs refreshing.\n";
  const root = repoWithIssue({ "AGENTS.md": docs });
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(path.join(root, "AGENTS.md"), "utf8"), docs);
});

test("render --check does not report fenced markers as stale", async () => {
  const docs = ["```markdown", "<!-- loom view: backlog -->", "```", ""].join("\n");
  const root = repoWithIssue({ "design/doc.md": docs });
  const check = await run(["--cwd", root, "render", "--check"]);
  assert.equal(check.code, 0, check.out);
});

// Defect 2: vendored trees are not loom's to overwrite.
test("render does not touch markdown under node_modules", async () => {
  const marker = "<!-- loom view: backlog -->\n\nprose\n";
  const root = repoWithIssue();
  mkdirSync(path.join(root, "node_modules/fake"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/fake/README.md"), marker);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(path.join(root, "node_modules/fake/README.md"), "utf8"), marker);
});

test("render skips markdown paths git ignores", async () => {
  const marker = "<!-- loom view: backlog -->\n\nprose\n";
  const root = gitRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/a.md": instance("class: issue\ntitle: Alpha"),
    ".gitignore": "build/\n",
  });
  mkdirSync(path.join(root, "build"), { recursive: true });
  writeFileSync(path.join(root, "build/GENERATED.md"), marker);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(path.join(root, "build/GENERATED.md"), "utf8"), marker);
});

// Defect 3: an unknown named view is an error, not file content.
test("render fails on an unknown view and leaves the file byte-identical", async () => {
  const real = "<!-- loom view: typo -->\n\nPROSE THAT MUST SURVIVE\n\n<!-- loom view: typo end -->\n";
  const root = repoWithIssue({ "design/bad.md": real });
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 1, `${r.code} ${r.out}${r.err}`);
  assert.match(`${r.out}${r.err}`, /render\/unknown-view/);
  assert.equal(readFileSync(path.join(root, "design/bad.md"), "utf8"), real);
});

test("render --check fails on an unknown view too", async () => {
  const real = "<!-- loom view: typo -->\n\nx\n";
  const root = repoWithIssue({ "design/bad.md": real });
  const check = await run(["--cwd", root, "render", "--check"]);
  assert.equal(check.code, 1, check.out);
  assert.match(check.out + check.err, /render\/unknown-view/);
});


test("one unknown view aborts the whole run, even healthy files", async () => {
  const healthy = "<!-- loom view: backlog -->\n\n<!-- loom view: backlog end -->\n";
  const root = repoWithIssue({
    "design/good.md": healthy,
    "design/bad.md": "<!-- loom view: typo -->\n\nx\n\n<!-- loom view: typo end -->\n",
  });
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 1);
  assert.equal(readFileSync(path.join(root, "design/good.md"), "utf8"), healthy);
});
