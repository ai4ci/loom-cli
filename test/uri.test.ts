import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalise, equivalent, formatUri, parseUri, resolveUri } from "../src/uri.ts";
import { configFrom } from "../src/config.ts";

const cfg = configFrom("/repo", {
  designRoot: "design",
  classRoots: { issue: "design/issue", src: ["src", "R"], test: ["tests"] },
});

test("parseUri splits scheme, path and anchor", () => {
  assert.deepEqual(parseUri("issue://my-first-issue.md"), {
    scheme: "issue",
    path: "my-first-issue.md",
  });
  assert.deepEqual(parseUri("src://my/pkg/MyClass.java#myFunction"), {
    scheme: "src",
    path: "my/pkg/MyClass.java",
    anchor: "myFunction",
  });
});

test("parseUri normalises redundant path segments", () => {
  assert.equal(parseUri("issue://./a/../b.md").path, "b.md");
  assert.equal(parseUri("issue:///a//b.md").path, "a/b.md");
});

test("parseUri rejects malformed input", () => {
  for (const bad of ["not-a-uri", "issue:/single-slash.md", "://no-scheme", ""]) {
    assert.throws(() => parseUri(bad), /uri/i, `expected ${bad} to be rejected`);
  }
});

test("parseUri rejects paths escaping the root", () => {
  assert.throws(() => parseUri("issue://../outside.md"), /escapes/i);
});

test("formatUri is the inverse of parseUri", () => {
  for (const raw of ["issue://a.md", "src://a/b.R#fn", "repo://README.md"]) {
    assert.equal(formatUri(parseUri(raw)), raw);
  }
});

test("resolveUri maps schemes to repo-relative paths", () => {
  assert.equal(resolveUri(parseUri("repo://README.md"), cfg).path, "README.md");
  assert.equal(resolveUri(parseUri("design://issue/a.md"), cfg).path, "design/issue/a.md");
  assert.equal(resolveUri(parseUri("issue://a.md"), cfg).path, "design/issue/a.md");
  assert.equal(resolveUri(parseUri("test://unit/a.R"), cfg).path, "tests/unit/a.R");
});

test("resolveUri defaults an unconfigured class to designRoot/<class>", () => {
  assert.equal(resolveUri(parseUri("decision://d1.md"), cfg).path, "design/decision/d1.md");
});

test("resolveUri reports every candidate for a multi-root class", () => {
  const r = resolveUri(parseUri("src://a/b.R"), cfg);
  assert.deepEqual(r.candidates, ["src/a/b.R", "R/a/b.R"]);
  assert.equal(r.path, "src/a/b.R", "first root wins absent an existence check");
});

test("resolveUri lets an existence check pick a later root", () => {
  const r = resolveUri(parseUri("src://a/b.R"), cfg, (p) => p === "R/a/b.R");
  assert.equal(r.path, "R/a/b.R");
  assert.equal(r.ambiguous, false);
});

test("resolveUri flags ambiguity when several roots match", () => {
  const r = resolveUri(parseUri("src://a/b.R"), cfg, () => true);
  assert.equal(r.ambiguous, true);
});

test("canonicalise picks the most compact scheme", () => {
  assert.equal(formatUri(canonicalise("design/issue/a.md", cfg)), "issue://a.md");
  assert.equal(formatUri(canonicalise("design/notes.md", cfg)), "design://notes.md");
  assert.equal(formatUri(canonicalise("README.md", cfg)), "repo://README.md");
  assert.equal(formatUri(canonicalise("tests/unit/a.R", cfg)), "test://unit/a.R");
});

test("canonicalise prefers the longest matching root when roots nest", () => {
  // design/issue nests inside design, so the class scheme must win.
  assert.equal(formatUri(canonicalise("design/issue/deep/a.md", cfg)), "issue://deep/a.md");
});

test("canonicalise preserves an anchor", () => {
  assert.equal(formatUri(canonicalise("src/a/b.R", cfg, "fn")), "src://a/b.R#fn");
});

test("equivalent compares resolved paths across schemes", () => {
  assert.equal(equivalent("design://issue/a.md", "issue://a.md", cfg), true);
  assert.equal(equivalent("repo://design/issue/a.md", "issue://a.md", cfg), true);
  assert.equal(equivalent("issue://a.md", "issue://b.md", cfg), false);
});

test("equivalent distinguishes anchors", () => {
  assert.equal(equivalent("src://a.R#one", "src://a.R#two", cfg), false);
  assert.equal(equivalent("src://a.R#one", "src://a.R#one", cfg), true);
});
