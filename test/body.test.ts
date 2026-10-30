import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyUnifiedDiff,
  joinProse,
  splitProse,
  toRelative,
  toUris,
} from "../src/body.ts";
import { unifiedDiff } from "../src/diff.ts";
import { LoomError } from "../src/diagnostics.ts";
import type { ClassRoots } from "../src/path-resolution.ts";

const patchFailed = (cause: unknown): boolean =>
  cause instanceof LoomError && cause.diagnostic.code === "body/patch-failed";

const ROOTS: ClassRoots = new Map<string, string | null>([
  ["issue", "design/issue"],
  ["decision", "design/decision"],
  ["resource", "design/resource"],
]);

const BLOCK = "<!-- loom:links start -->\n- [B](b.md)\n<!-- loom:links end -->";

test("splitProse returns the whole markdown when there is no links block", () => {
  const split = splitProse("Alpha\nBravo\n");
  assert.equal(split.block, null);
  assert.equal(split.prose, "Alpha\nBravo\n");
});

test("splitProse separates the protected block from the prose", () => {
  const split = splitProse(`\n${BLOCK}\n\nAlpha\n`);
  assert.equal(split.block, BLOCK);
  assert.equal(split.prose, "Alpha\n");
});

test("splitProse keeps prose written before the block", () => {
  const split = splitProse(`Preamble.\n\n${BLOCK}\n\nAlpha\n`);
  assert.equal(split.block, BLOCK);
  assert.match(split.prose, /Preamble\./);
  assert.match(split.prose, /Alpha/);
});

test("joinProse restores a document the splitter produced", () => {
  const markdown = `\n${BLOCK}\n\nAlpha\n`;
  assert.equal(joinProse(splitProse(markdown)), markdown);
});

test("joinProse is idempotent across a second round trip", () => {
  const once = joinProse(splitProse(`\n${BLOCK}\n\nAlpha\n`));
  assert.equal(joinProse(splitProse(once)), once);
});

test("toUris rewrites relative markdown links as design uris", () => {
  const prose = "See [D1](../decision/d1.md) and [B](b.md).\n";
  assert.equal(
    toUris(prose, "design/issue/a.md", ROOTS),
    "See [D1](decision:d1.md) and [B](issue:b.md).\n",
  );
});

test("toRelative rewrites design uris as relative markdown links", () => {
  const prose = "See [D1](decision:d1.md) and [B](issue:b.md).\n";
  assert.equal(
    toRelative(prose, "design/issue/a.md", ROOTS),
    "See [D1](../decision/d1.md) and [B](b.md).\n",
  );
});

test("link translation round-trips", () => {
  const onDisk = "See [D1](../decision/d1.md) and [B](b.md).\n";
  const uris = toUris(onDisk, "design/issue/a.md", ROOTS);
  assert.equal(toRelative(uris, "design/issue/a.md", ROOTS), onDisk);
});

test("a fragment on a relative link survives translation", () => {
  const prose = "[D1](../decision/d1.md#rationale)\n";
  const uris = toUris(prose, "design/issue/a.md", ROOTS);
  assert.equal(uris, "[D1](decision:d1.md#rationale)\n");
  assert.equal(toRelative(uris, "design/issue/a.md", ROOTS), prose);
});

test("external and in-page links are left alone in both directions", () => {
  const prose = "[w](https://example.com) [m](mailto:a@b.c) [s](#section)\n";
  assert.equal(toUris(prose, "design/issue/a.md", ROOTS), prose);
  assert.equal(toRelative(prose, "design/issue/a.md", ROOTS), prose);
});

test("an unknown uri scheme is not mistaken for a class", () => {
  const prose = "[x](ftp://host/file)\n";
  assert.equal(toRelative(prose, "design/issue/a.md", ROOTS), prose);
});

test("image links translate like ordinary links", () => {
  const prose = "![chart](../resource/chart.png)\n";
  assert.equal(
    toUris(prose, "design/issue/a.md", ROOTS),
    "![chart](resource:chart.png)\n",
  );
});

test("a path outside every class root becomes a repo uri", () => {
  const prose = "[r](../../README.md)\n";
  const uris = toUris(prose, "design/issue/a.md", ROOTS);
  assert.equal(uris, "[r](repo:README.md)\n");
  assert.equal(toRelative(uris, "design/issue/a.md", ROOTS), prose);
});

test("applyUnifiedDiff applies a hunk against matching context", () => {
  const before = "Alpha\nBravo\nCharlie\n";
  const diff = "@@ -1,3 +1,3 @@\n Alpha\n-Bravo\n+Bravissimo\n Charlie\n";
  assert.equal(applyUnifiedDiff(before, diff), "Alpha\nBravissimo\nCharlie\n");
});

test("applyUnifiedDiff reverses what unifiedDiff produced", () => {
  const before = "one\ntwo\nthree\nfour\nfive\n";
  const after = "one\ntwo\nTHREE\nfour\nfive\n";
  assert.equal(applyUnifiedDiff(before, unifiedDiff(before, after)), after);
});

test("applyUnifiedDiff applies several hunks", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const diff = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -7,2 +7,2 @@\n g\n-h\n+H\n";
  assert.equal(applyUnifiedDiff(before, diff), "a\nB\nc\nd\ne\nf\ng\nH\n");
});

test("applyUnifiedDiff refuses a hunk whose context does not match", () => {
  const before = "Alpha\nBravo\n";
  const diff = "@@ -1,2 +1,2 @@\n Alpha\n-Delta\n+Echo\n";
  assert.throws(() => applyUnifiedDiff(before, diff), patchFailed);
});

test("applyUnifiedDiff rejects a diff with no hunks", () => {
  assert.throws(() => applyUnifiedDiff("Alpha\n", "not a diff\n"), patchFailed);
});
