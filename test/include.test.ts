import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    %% @prefix slide: <repo:design/slide/> .
    %% @view allSlides
    %% SELECT uri, title FROM slide ORDER BY uri
    class slide {
        +string title
    }
    slide "0..*" --> "0..*" slide : follows
`;

function repo(files: Record<string, string> = {}): string {
  return makeRepo({
    "design/document-model.mmd": MODEL,
    "design/slide/a.md": instance("class: slide\ntitle: Slide A", "## Heading two\n\nBody text.\n\n### Deeper\n"),
    "design/slide/b.md": instance("class: slide\ntitle: Slide B", "# Top\n\nSee [A](a.md).\n"),
    ...files,
  });
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), "utf8");

test("an include with no level transcludes verbatim and writes its end marker", async () => {
  const root = repo({ "deck.md": "# Deck\n\n<!-- loom include: slide:a.md -->\n\ntail\n" });
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0, r.out + r.err);

  const out = read(root, "deck.md");
  assert.match(out, /## Heading two/);
  assert.match(out, /### Deeper/);
  assert.match(out, /<!-- loom include: slide:a\.md end -->/);
  assert.match(out, /tail/);

  // Idempotent: a second render changes nothing.
  await run(["--cwd", root, "render"]);
  assert.equal(read(root, "deck.md"), out);
});

test("h3 emits the title as a heading and shifts the content below it", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:a.md h3 -->\n" });
  await run(["--cwd", root, "render"]);

  const out = read(root, "deck.md");
  assert.match(out, /### Slide A/);
  assert.match(out, /#### Heading two/);
  assert.match(out, /##### Deeper/);
});

test("notitle shifts the shallowest heading to the named level", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:a.md h3 notitle -->\n" });
  await run(["--cwd", root, "render"]);

  const out = read(root, "deck.md");
  assert.doesNotMatch(out, /Slide A/);
  assert.match(out, /### Heading two/);
  assert.match(out, /#### Deeper/);
});

test("a document with no title degrades to content only", async () => {
  const root = repo({
    "design/slide/c.md": instance("class: slide", "## Only heading\n"),
    "deck.md": "<!-- loom include: slide:c.md h2 -->\n",
  });
  await run(["--cwd", root, "render"]);
  assert.match(read(root, "deck.md"), /## Only heading/);
});

test("headings past level six are left as literal text", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:a.md h6 notitle -->\n" });
  await run(["--cwd", root, "render"]);
  assert.match(read(root, "deck.md"), /####### Deeper/);
});

test("headings inside a fenced block in the included prose are not shifted", async () => {
  const root = repo({
    "design/slide/d.md": instance("class: slide\ntitle: D", "## Real\n\n```sh\n# not a heading\n```\n"),
    "deck.md": "<!-- loom include: slide:d.md h3 notitle -->\n",
  });
  await run(["--cwd", root, "render"]);

  const out = read(root, "deck.md");
  assert.match(out, /### Real/);
  assert.match(out, /^# not a heading$/m);
});

test("links in transcluded prose are rewritten relative to the including file", async () => {
  const root = repo({ "docs/deck.md": "<!-- loom include: slide:b.md -->\n" });
  await run(["--cwd", root, "render"]);
  assert.match(read(root, "docs/deck.md"), /\[A\]\(\.\.\/design\/slide\/a\.md\)/);
});

test("a marker arriving inside transcluded prose is inert", async () => {
  const root = repo({
    "design/slide/e.md": instance("class: slide\ntitle: E", "<!-- loom view: allSlides -->\n"),
    "deck.md": "<!-- loom include: slide:e.md -->\n",
  });
  await run(["--cwd", root, "render"]);
  const once = read(root, "deck.md");
  // The nested marker is carried across as text, never expanded in the host.
  assert.match(once, /<!-- loom view: allSlides -->/);
  assert.doesNotMatch(once, /\| uri \|/);

  await run(["--cwd", root, "render"]);
  assert.equal(read(root, "deck.md"), once);
});

test("the projected body holds markers collapsed, not expanded output", async () => {
  const root = repo({
    "design/slide/e.md": instance("class: slide\ntitle: E", "<!-- loom view: allSlides -->\n"),
  });
  await run(["--cwd", root, "render"]);
  // e.md now has an expanded view section on disk.
  assert.match(read(root, "design/slide/e.md"), /\| uri \|/);

  const r = await run(["--cwd", root, "query", "SELECT body FROM slide WHERE uri = 'slide:e.md'"]);
  const body = String((parse(r.out) as { rows: { body: string }[] }).rows[0]?.body);
  assert.match(body, /<!-- loom view: allSlides -->/);
  assert.doesNotMatch(body, /\| uri \|/);
  assert.doesNotMatch(body, /end -->/);
});

test("a malformed include is an error and nothing is written", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:a.md h3 notitel -->\n" });
  const before = read(root, "deck.md");

  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /render\/bad-include/);
  assert.equal(read(root, "deck.md"), before);
});

test("an include of a document that does not exist is an error", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:nope.md -->\n" });
  const before = read(root, "deck.md");

  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /render\/missing-include/);
  assert.equal(read(root, "deck.md"), before);
});

test("render --check sees an include whose source has changed", async () => {
  const root = repo({ "deck.md": "<!-- loom include: slide:a.md -->\n" });
  await run(["--cwd", root, "render"]);
  assert.equal((await run(["--cwd", root, "render", "--check"])).code, 0);

  writeFileSync(
    path.join(root, "design/slide/a.md"),
    instance("class: slide\ntitle: Slide A", "## Heading two\n\nRewritten.\n"),
  );
  const r = await run(["--cwd", root, "render", "--check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /deck\.md/);
});
