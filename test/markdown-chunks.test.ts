import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { detectLang, extractAnchors, extractReverseLinks } from "../src/source.ts";
import { instance, makeRepo } from "./helpers.ts";

const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix src: <repo:src/> .
    class issue {
        +string title
    }
    src "0..*" --> "0..*" issue : implements
`;

const RMD = `---
title: Analysis
---

# Setup

\`\`\`{r setup, include=FALSE}
library(dplyr)
\`\`\`

\`\`\`{r}
unlabelled <- 1
\`\`\`

\`\`\`{python clean}
x = 1
\`\`\`
`;

const QMD = `---
title: Report
---

\`\`\`{r}
#| label: clean
tidy <- function(x) x
\`\`\`
`;

test("Rmd and qmd files are addressed through the markdown grammar", () => {
  assert.equal(detectLang("notes/analysis.Rmd"), "markdown");
  assert.equal(detectLang("notes/report.qmd"), "markdown");
});

test("labelled chunks are anchors; unlabelled ones are not", () => {
  const anchors = extractAnchors(RMD, "markdown");
  assert.deepEqual(anchors.map((a) => a.fullName).sort(), ["clean", "setup"]);
  assert.equal(anchors.every((a) => a.kind === "Chunk"), true);
});

test("a quarto `#| label:` names a chunk too", () => {
  const anchors = extractAnchors(QMD, "markdown");
  assert.deepEqual(anchors.map((a) => a.fullName), ["clean"]);
});

test("a reverse link inside a chunk is read with the chunk's comment style", () => {
  const code = RMD.replace("library(dplyr)", "# implements: issue:one.md\nlibrary(dplyr)");
  const links = extractReverseLinks(code, "markdown");
  assert.deepEqual(links.map((l) => [l.relation, l.target, l.enclosingSymbol]), [
    ["implements", "issue:one.md", "setup"],
  ]);
});

test("linking source to a document writes a comment inside the chunk", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/analysis.Rmd": RMD,
  });

  const linked = await run(["--cwd", root, "link", "src:analysis.Rmd#setup", "implements", "issue:one.md"]);
  assert.equal(linked.code, 0, linked.out + linked.err);
  const written = readFileSync(path.join(root, "src/analysis.Rmd"), "utf8");
  assert.match(written, /```\{r setup, include=FALSE\}\n# implements: issue:one\.md\n/);

  const validated = await run(["--cwd", root, "validate"]);
  assert.equal(validated.code, 0, validated.out);

  const unlinked = await run(["--cwd", root, "unlink", "src:analysis.Rmd#setup", "implements", "issue:one.md"]);
  assert.equal(unlinked.code, 0, unlinked.out + unlinked.err);
  assert.equal(readFileSync(path.join(root, "src/analysis.Rmd"), "utf8"), RMD);
});

test("a python chunk gets a python comment", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/analysis.Rmd": RMD,
  });
  await run(["--cwd", root, "link", "src:analysis.Rmd#clean", "implements", "issue:one.md"]);
  assert.match(
    readFileSync(path.join(root, "src/analysis.Rmd"), "utf8"),
    /```\{python clean\}\n# implements: issue:one\.md\n/,
  );
});

test("chunks are listed as linkable anchors", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/analysis.Rmd": RMD,
  });
  const r = await run(["--cwd", root, "--json", "ls", "src:analysis.Rmd"]);
  assert.equal(r.code, 0, r.out + r.err);
  const names = JSON.stringify(parse(r.out));
  assert.match(names, /setup/);
  assert.match(names, /clean/);
});

test("a whole markdown file cannot be annotated: name a chunk", async () => {
  const root = makeRepo({
    "design/document-model.mmd": MODEL,
    "design/issue/one.md": instance("class: issue\ntitle: One"),
    "src/analysis.Rmd": RMD,
  });
  const r = await run(["--cwd", root, "link", "src:analysis.Rmd", "implements", "issue:one.md"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /source\/not-annotatable/);
});
