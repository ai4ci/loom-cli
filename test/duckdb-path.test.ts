import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { configFrom } from "../src/config.ts";
import { LOOM_DIR, databasePath, gitBranch, loomDir } from "../src/duckdb.ts";
import { makeRepo } from "./helpers.ts";

/**
 * A real git repository, because the branch name is read from git and a
 * fixture `.git` directory cannot answer `rev-parse`.
 */
function makeGitRepo(branch: string | null): string {
  const root = makeRepo({ "design/document-model.mmd": "classDiagram\n" });
  // `makeRepo` leaves a bare `.git` directory behind; `git init` needs it gone.
  execFileSync("rm", ["-rf", path.join(root, ".git")]);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-qm", "init");
  if (branch !== null) git("checkout", "-qb", branch);
  return root;
}

const config = (root: string) => configFrom(root, {}, null);

test("the loom directory sits under the design root", () => {
  const root = makeGitRepo(null);
  assert.equal(loomDir(config(root)), `design/${LOOM_DIR}`);
});

test("databasePath nests the database under the branch name", () => {
  const root = makeGitRepo(null);
  assert.equal(databasePath(config(root)), "design/.loom/db/main/loom.duckdb");
});

test("a branch with a slash becomes a directory path, not a sanitised name", () => {
  const root = makeGitRepo("feat/my-feature");
  assert.equal(
    databasePath(config(root)),
    "design/.loom/db/feat/my-feature/loom.duckdb",
  );
});

test("two branches get two databases", () => {
  const a = config(makeGitRepo("feat/one"));
  const b = config(makeGitRepo("bug/two"));
  assert.notEqual(databasePath(a), databasePath(b));
  assert.equal(databasePath(a), "design/.loom/db/feat/one/loom.duckdb");
  assert.equal(databasePath(b), "design/.loom/db/bug/two/loom.duckdb");
});

test("gitBranch falls back to main outside a git repository", () => {
  // `makeRepo` fakes `.git` as an empty directory, so git cannot answer.
  const root = makeRepo({ "design/document-model.mmd": "classDiagram\n" });
  assert.equal(gitBranch(root), "main");
});

test("a detached HEAD does not produce a path segment named HEAD", () => {
  const root = makeGitRepo(null);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "-q", sha], { cwd: root, stdio: "pipe" });
  const branch = gitBranch(root);
  assert.notEqual(branch, "HEAD");
  assert.equal(branch, `detached/${sha.slice(0, 12)}`);
});

test("a branch name cannot escape the loom directory", () => {
  // Git forbids `..` in ref names, so this is belt and braces: the resolved
  // database must stay inside the design root whatever git reports.
  const root = makeGitRepo("feat/safe");
  const resolved = path.posix.normalize(databasePath(config(root)));
  assert.ok(resolved.startsWith("design/.loom/db/"), resolved);
});

test("connecting writes a gitignore that excludes the generated state", async () => {
  const root = makeGitRepo("feat/ignore-me");
  const cfg = config(root);
  const { ensureLoomDir } = await import("../src/duckdb.ts");
  ensureLoomDir(cfg);

  const ignoreFile = path.join(root, "design", LOOM_DIR, ".gitignore");
  assert.ok(existsSync(ignoreFile), "expected design/.loom/.gitignore");
  assert.equal(readFileSync(ignoreFile, "utf8"), "db/\nVALIDATION.md\n");
});
