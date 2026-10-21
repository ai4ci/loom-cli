import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

function repo(): string {
  return makeRepo({
    ".design-docs.yaml": "designRoot: design\nclassRoots:\n  issue: design/issue\n  src: [src, R]\n",
    "design/issue/first.md": instance(
      "class: issue\nid: first.md\ntitle: The thing is broken\nstatus: open",
      "\n<!-- design-docs:links start -->\n- blocks: [Other](other.md)\n<!-- design-docs:links end -->\n\nProse.\n",
    ),
    "R/model.R": "fit <- function(x) x\n",
  });
}

test("resolve maps a class uri to its repo-relative path", async () => {
  const r = await run(["--cwd", repo(), "resolve", "issue://first.md"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, unknown>;
  assert.equal(out.path, "design/issue/first.md");
  assert.equal(out.uri, "issue://first.md");
  assert.equal(out.exists, true);
});

test("resolve picks the root that exists for a multi-root class", async () => {
  const r = await run(["--cwd", repo(), "resolve", "src://model.R"]);
  const out = parse(r.out) as Record<string, unknown>;
  assert.deepEqual(out.candidates, ["src/model.R", "R/model.R"]);
  assert.equal(out.path, "R/model.R");
  assert.equal(out.ambiguous, false);
});

test("resolve round-trips a repo uri back to the compact scheme", async () => {
  const r = await run(["--cwd", repo(), "resolve", "repo://design/issue/first.md"]);
  assert.equal((parse(r.out) as Record<string, unknown>).uri, "issue://first.md");
});

test("resolve reports a missing file without failing", async () => {
  const r = await run(["--cwd", repo(), "resolve", "issue://absent.md"]);
  assert.equal(r.code, 0);
  assert.equal((parse(r.out) as Record<string, unknown>).exists, false);
});

test("resolve rejects a malformed uri with exit code 1", async () => {
  const r = await run(["--cwd", repo(), "resolve", "not-a-uri"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /uri\/malformed/);
});

test("show returns frontmatter, links and markdown", async () => {
  const r = await run(["--cwd", repo(), "show", "issue://first.md"]);
  assert.equal(r.code, 0);
  const out = parse(r.out) as Record<string, any>;
  assert.equal(out.frontmatter.status, "open");
  assert.equal(out.frontmatter.title, "The thing is broken");
  assert.equal(out.links, "- blocks: [Other](other.md)");
  assert.match(out.markdown, /Prose\./);
});

test("show fails with exit code 1 for a missing instance", async () => {
  const r = await run(["--cwd", repo(), "show", "issue://absent.md"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /instance\/not-found/);
});

test("--json emits JSON for the same data", async () => {
  const root = repo();
  const asYaml = parse((await run(["--cwd", root, "resolve", "issue://first.md"])).out);
  const asJson = JSON.parse((await run(["--cwd", root, "--json", "resolve", "issue://first.md"])).out);
  assert.deepEqual(asJson, asYaml);
});
