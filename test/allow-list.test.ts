import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./helpers.ts";
import { run } from "../src/cli.ts";
import { instance } from "./helpers.ts";
import { parse } from "yaml";

test("a comment whose relation is unknown prose is ignored, not an error", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix main: <repo:src/main/java/> .
    class issue {
        +string title
    }
    class main
    main "0..*" --> "0..*" issue : implements
    src <|-- main
`,
    "design/issue/issue-001.md": instance("class: issue\ntitle: One"),
    "src/main/java/BibliographicApis.java":
      "public interface BibliographicApis {\n    // TODO: https://www.crossref.org/labs/citation-formatting-service/\n    // NOTE: nothing\n    void foo();\n}\n",
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 0, r.out);
});

test("a comment whose relation IS permitted but target dangles still errors", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix main: <repo:src/main/java/> .
    class issue {
        +string title
    }
    class main
    main "0..*" --> "0..*" issue : implements
    src <|-- main
`,
    "design/issue/issue-001.md": instance("class: issue\ntitle: One"),
    "src/main/java/BibliographicApis.java":
      "public interface BibliographicApis {\n    // implements: issue:does-not-exist.md\n    void foo();\n}\n",
  });
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 1, r.out);
  const out = parse(r.out) as any;
  assert.ok(out.diagnostics.some((d: any) => d.code === "source/dangling-reverse-link"));
});
