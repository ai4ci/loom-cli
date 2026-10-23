import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalise, equivalent, formatUri, parseUri, resolveUri } from "../src/uri.ts";
import type { ClassRoots } from "../src/path-resolution.ts";

const roots: ClassRoots = new Map([
  ["issue", "design/issue"],
  ["src", "src"],
  ["test", "tests"],
]);

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
  assert.equal(resolveUri(parseUri("repo://README.md"), roots).path, "README.md");
  assert.equal(resolveUri(parseUri("issue://a.md"), roots).path, "design/issue/a.md");
  assert.equal(resolveUri(parseUri("src://a/b.R"), roots).path, "src/a/b.R");
  assert.equal(resolveUri(parseUri("test://unit/a.R"), roots).path, "tests/unit/a.R");
});

test("resolveUri returns the path unchanged for an unknown class", () => {
  assert.throws(() => resolveUri(parseUri("decision://d1.md"), roots), /unknown class/i);
});

test("canonicalise picks the most compact scheme", () => {
  assert.equal(formatUri(canonicalise("design/issue/a.md", roots)), "issue://a.md");
  assert.equal(formatUri(canonicalise("README.md", roots)), "repo://README.md");
  assert.equal(formatUri(canonicalise("tests/unit/a.R", roots)), "test://unit/a.R");
});

test("canonicalise falls back to repo when no class matches", () => {
  assert.equal(formatUri(canonicalise("design/notes.md", roots)), "repo://design/notes.md");
});

test("canonicalise preserves an anchor", () => {
  assert.equal(formatUri(canonicalise("src/a/b.R", roots, "fn")), "src://a/b.R#fn");
});

test("equivalent compares resolved paths across schemes", () => {
  assert.equal(equivalent("repo://design/issue/a.md", "issue://a.md", roots), true);
  assert.equal(equivalent("issue://a.md", "issue://b.md", roots), false);
});

test("equivalent distinguishes anchors", () => {
  assert.equal(equivalent("src://a.R#one", "src://a.R#two", roots), false);
  assert.equal(equivalent("src://a.R#one", "src://a.R#one", roots), true);
});
