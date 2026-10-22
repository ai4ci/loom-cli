import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINKS_END,
  LINKS_START,
  getLinksBlock,
  parseInstance,
  setLinksBlock,
  stringifyInstance,
} from "../src/document.ts";

const FULL = `---
class: issue
id: my-first-issue.md
title: The thing is broken
status: open
---

${LINKS_START}
- blocks: [Other](../issue/other.md)
${LINKS_END}

Free prose that the tool never touches.
`;

test("parseInstance splits frontmatter from markdown", () => {
  const f = parseInstance(FULL);
  assert.equal(f.frontmatter?.get("status"), "open");
  assert.match(f.markdown, /Free prose/);
  assert.doesNotMatch(f.markdown, /^class:/m);
});

test("a document with no frontmatter parses as pure markdown", () => {
  const f = parseInstance("# Title\n\nbody\n");
  assert.equal(f.frontmatter, null);
  assert.equal(f.markdown, "# Title\n\nbody\n");
});

test("round-trip is byte-identical when nothing is changed", () => {
  for (const raw of [
    FULL,
    "# no frontmatter\n",
    "---\na: 1\n---\n",
    "---\na: 1\n---\nno trailing newline",
    "---\nunicode: \u00e9\u00e0\u4e2d\u6587 \ud83c\udf1f\n---\n\nbody\n",
    "---\nbase: &a\n  x: 1\nderived:\n  <<: *a\n---\n\nbody\n",
    `---\na: 1\n---\n\nprose first\n\n${LINKS_START}\n- late block\n${LINKS_END}\n`,
  ]) {
    assert.equal(stringifyInstance(parseInstance(raw)), raw);
  }
});

test("CRLF files round-trip with their line endings intact", () => {
  const crlf = FULL.replace(/\n/g, "\r\n");
  const f = parseInstance(crlf);
  assert.equal(f.eol, "\r\n");
  assert.equal(stringifyInstance(f), crlf);
});

test("comments and key order survive an edit to another key", () => {
  const raw = `---
# why this matters
title: The thing   # trailing note
status: open
---

body
`;
  const f = parseInstance(raw);
  f.frontmatter?.set("status", "closed");
  const out = stringifyInstance(f);
  assert.match(out, /# why this matters/);
  assert.match(out, /# trailing note/);
  assert.match(out, /status: closed/);
  assert.ok(out.indexOf("title:") < out.indexOf("status:"), "key order preserved");
});

test("writing is idempotent after one normalising pass", () => {
  // The yaml Document API collapses whitespace before a trailing comment, so
  // the first write may normalise; every write after that must be identical.
  const raw = `---\ntitle: The thing   # note\n---\n\nbody\n`;
  const once = stringifyInstance(parseInstance(raw));
  const twice = stringifyInstance(parseInstance(once));
  assert.equal(twice, once);
});

test("normalisation never changes a value or drops a comment", () => {
  const raw = `---\n# keep me\na: open   # and me\nb: 3\n---\n\nbody\n`;
  const once = stringifyInstance(parseInstance(raw));
  const f = parseInstance(once);
  assert.equal(f.frontmatter?.get("a"), "open");
  assert.equal(f.frontmatter?.get("b"), 3);
  assert.match(once, /# keep me/);
  assert.match(once, /# and me/);
});

test("getLinksBlock returns the protected content, or null", () => {
  assert.equal(getLinksBlock(parseInstance(FULL).markdown), "- blocks: [Other](../issue/other.md)");
  assert.equal(getLinksBlock("no block here\n"), null);
});

test("setLinksBlock replaces an existing block in place", () => {
  const f = parseInstance(FULL);
  const out = setLinksBlock(f.markdown, "- blocks: [New](../issue/new.md)");
  assert.equal(getLinksBlock(out), "- blocks: [New](../issue/new.md)");
  assert.match(out, /Free prose/);
  assert.equal(out.match(/loom:links start/g)?.length, 1);
});

test("setLinksBlock inserts a missing block ahead of the prose", () => {
  const out = setLinksBlock("\nSome prose.\n", "- blocks: [A](a.md)");
  assert.equal(getLinksBlock(out), "- blocks: [A](a.md)");
  assert.ok(out.indexOf(LINKS_START) < out.indexOf("Some prose."));
});

test("setLinksBlock is idempotent", () => {
  const once = setLinksBlock("\nSome prose.\n", "- blocks: [A](a.md)");
  assert.equal(setLinksBlock(once, "- blocks: [A](a.md)"), once);
});

test("setLinksBlock handles an empty document", () => {
  const out = setLinksBlock("", "- blocks: [A](a.md)");
  assert.equal(getLinksBlock(out), "- blocks: [A](a.md)");
  assert.equal(setLinksBlock(out, "- blocks: [A](a.md)"), out);
});
