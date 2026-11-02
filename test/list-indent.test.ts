import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstance, stringifyInstance } from "../src/document.ts";

test("serialising keeps a file's sequence indentation", () => {
  const file = parseInstance("---\nclass: issue\ntitle: A\nreporters:\n    - alice\n    - bob\n---\n\n# Body\n");
  const out = stringifyInstance(file);
  assert.ok(out.includes("    - alice"), out);
  assert.ok(!/\n  - alice/.test(out), out);
});

test("serialising keeps flush-left sequence items too", () => {
  const file = parseInstance("---\nclass: issue\ntitle: A\nreporters:\n- alice\n- bob\n---\n\n# Body\n");
  const out = stringifyInstance(file);
  assert.ok(out.includes("- alice"), out);
  assert.ok(!/\n  - alice/.test(out), out);
});

test("a file whose indentation loom already matches is written byte-identically", () => {
  const raw = "---\nclass: issue\ntitle: A\nreporters:\n  - alice\n---\n\n# Body\n";
  const file = parseInstance(raw);
  assert.equal(stringifyInstance(file), raw);
});
