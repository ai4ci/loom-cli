import assert from "node:assert/strict";
import test from "node:test";

import { formatUri, parseUri } from "../src/uri.ts";

/** The diagnostic code of the LoomError `fn` throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { diagnostic?: { code?: string } }).diagnostic?.code ?? "(no code)";
  }
  return "(did not throw)";
}

test("a curie parses into scheme and path", () => {
  assert.deepEqual(parseUri("issue:my-issue.md"), {
    scheme: "issue",
    path: "my-issue.md",
  });
});

test("a curie keeps every path segment, unlike an authority", () => {
  // `issue:design/notes.md` puts `design` in the authority slot under
  // RFC 3986; the curie form has no authority, so the path stays whole.
  assert.deepEqual(parseUri("issue:design/notes.md"), {
    scheme: "issue",
    path: "design/notes.md",
  });
});

test("a curie carries an anchor as a fragment", () => {
  assert.deepEqual(parseUri("src:src/foo.ts#handleTask"), {
    scheme: "src",
    path: "src/foo.ts",
    anchor: "handleTask",
  });
});

test("the legacy two-slash form still parses, and is flagged", () => {
  const parsed = parseUri("issue://my-issue.md");
  assert.equal(parsed.scheme, "issue");
  assert.equal(parsed.path, "my-issue.md");
  assert.equal(parsed.legacy, true);
});

test("the legacy form keeps the whole path, as loom always meant it to", () => {
  const parsed = parseUri("issue://design/notes.md");
  assert.equal(parsed.path, "design/notes.md");
});

test("the one-slash form is legacy too, not a distinct spelling", () => {
  const parsed = parseUri("issue:/my-issue.md");
  assert.equal(parsed.scheme, "issue");
  assert.equal(parsed.path, "my-issue.md");
  assert.equal(parsed.legacy, true);
  assert.equal(formatUri(parsed), "issue:my-issue.md");
});

test("a curie is not flagged as legacy", () => {
  assert.equal(parseUri("issue:my-issue.md").legacy, undefined);
});

test("formatUri emits the curie form, never the legacy one", () => {
  assert.equal(formatUri({ scheme: "issue", path: "a.md" }), "issue:a.md");
  assert.equal(
    formatUri({ scheme: "src", path: "a.ts", anchor: "f" }),
    "src:a.ts#f",
  );
});

test("formatUri drops the legacy flag, so round-tripping migrates", () => {
  assert.equal(formatUri(parseUri("issue:a.md")), "issue:a.md");
});

test("the scheme is lowercased in both forms", () => {
  assert.equal(parseUri("Issue:a.md").scheme, "issue");
  assert.equal(parseUri("Issue:a.md").scheme, "issue");
});

test("a bare path is still a bare path, not a curie", () => {
  // The colon comes after a slash, so there is no scheme to find.
  assert.equal(codeOf(() => parseUri("design/issues/a.md")), "uri/bare-path");
  assert.equal(codeOf(() => parseUri("design/a:b.md")), "uri/bare-path");
});

test("a curie with an empty path is malformed", () => {
  assert.equal(codeOf(() => parseUri("issue:")), "uri/malformed");
  assert.equal(codeOf(() => parseUri("issue:")), "uri/malformed");
});

test("the one-slash form is no longer malformed, it is the curie form", () => {
  // `issue:/a.md` normalises to the same place as `issue:a.md`.
  assert.equal(parseUri("issue:/a.md").path, "a.md");
});

test("an underscore is a legal scheme character (snake_case class names)", () => {
  const parsed = parseUri("issue_status:a.md");
  assert.equal(parsed.scheme, "issue_status");
  assert.equal(parsed.path, "a.md");
});
