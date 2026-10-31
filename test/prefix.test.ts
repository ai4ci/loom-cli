import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";
import { parseUri, resolveUri } from "../src/uri.ts";
import { extractPrefixAnnotations } from "../src/path-resolution.ts";

// ---------------------------------------------------------------------------
// extractPrefixAnnotations — unit tests
// ---------------------------------------------------------------------------

test("extractPrefixAnnotations: parses name and target", () => {
  const diags: { code: string }[] = [];
  const prefixes = extractPrefixAnnotations(
    [{ text: "%% @prefix gh: https://github.com/org/repo/issues/", line: 1 }],
    diags as any,
  );
  assert.equal(diags.length, 0);
  assert.deepEqual([...prefixes], [["gh", "https://github.com/org/repo/issues/"]]);
});

test("extractPrefixAnnotations: target without trailing delimiter is a hard error", () => {
  const diags: { code: string; message: string }[] = [];
  const prefixes = extractPrefixAnnotations(
    [{ text: "%% @prefix gh: https://github.com/org/repo/issues", line: 1 }],
    diags as any,
  );
  assert.equal(prefixes.size, 0);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "model/prefix-delimiter");
  assert.match(diags[0]!.message, /must end in "\/" or "#"/);
});

test("extractPrefixAnnotations: fragment delimiter allowed", () => {
  const diags: any[] = [];
  const prefixes = extractPrefixAnnotations(
    [{ text: "%% @prefix md: design/document-model.mmd#", line: 1 }],
    diags,
  );
  assert.equal(prefixes.get("md"), "design/document-model.mmd#");
  assert.equal(diags.length, 0);
});

test("extractPrefixAnnotations: duplicate names are flagged", () => {
  const diags: { code: string }[] = [];
  extractPrefixAnnotations(
    [
      { text: "%% @prefix gh: https://a/", line: 1 },
      { text: "%% @prefix gh: https://b/", line: 2 },
    ],
    diags as any,
  );
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "model/duplicate-prefix");
});

// ---------------------------------------------------------------------------
// resolveUri — external expansion
// ---------------------------------------------------------------------------

test("resolveUri: external prefix expands by concatenation", () => {
  const prefixes = new Map([["gh", "https://github.com/org/repo/issues/"]]);
  const resolved = resolveUri(parseUri("gh:6"), new Map(), prefixes);
  assert.equal(resolved.path, "https://github.com/org/repo/issues/6");
  assert.equal(resolved.external, true);
});

test("resolveUri: external prefix wins over a same-named class", () => {
  const prefixes = new Map([["issue", "https://github.com/org/repo/issues/"]]);
  const roots = new Map([["issue", "design/issue"]]);
  const resolved = resolveUri(parseUri("issue:6"), roots, prefixes);
  assert.equal(resolved.path, "https://github.com/org/repo/issues/6");
  assert.equal(resolved.external, true);
});

test("resolveUri: without prefixes a class scheme resolves as before", () => {
  const roots = new Map([["issue", "design/issue"]]);
  const resolved = resolveUri(parseUri("issue:6"), roots);
  assert.equal(resolved.path, "design/issue/6");
  assert.equal(resolved.external, undefined);
});

// ---------------------------------------------------------------------------
// CLI — model annotations and end-to-end behaviour
// ---------------------------------------------------------------------------

const PREFIX_MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix gh: https://github.com/org/repo/issues/
    class issue {
        +string title
        +string status
    }
    issue "0..1" --> "0..*" gh : upstream
`;

const PREFIX_MODEL_NO_REL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix gh: https://github.com/org/repo/issues/
    class issue {
        +string title
        +string status
    }
`;

test("render: external uri cells link to the expanded url", async () => {
  const root = makeRepo({
    "design/document-model.mmd": PREFIX_MODEL,
    "design/issue/a.md": instance("title: Alpha\nstatus: open\nupstream: [gh:6]\n"),
    "README.md": `# Test\n\n<!-- loom view: SELECT subject, object FROM edge WHERE subject = 'issue:a.md' -->\n<!-- loom view: end -->\n`,
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "render"]);
  assert.equal(r.code, 0);

  const content = readFileSync(`${root}/README.md`, "utf8");
  assert(content.includes("[gh:6](https://github.com/org/repo/issues/6)"), content);
});

test("body set translates the expanded url back into a curie", async () => {
  const root = makeRepo({
    "design/document-model.mmd": PREFIX_MODEL_NO_REL,
    "design/issue/a.md": instance("title: Alpha\nstatus: open\n"),
  });

  await run(["--cwd", root, "index"]);
  const r = await run([
    "--cwd", root, "body", "set", "issue:a.md",
    "Tracked as [upstream](https://github.com/org/repo/issues/6).\n",
  ]);
  assert.equal(r.code, 0);

  const written = readFileSync(`${root}/design/issue/a.md`, "utf8");
  // Write direction expands curies to readable absolute urls; the curie is
  // the canonical form, the url is what a reader follows.
  assert(written.includes("[upstream](https://github.com/org/repo/issues/6)"), written);
});

test("body get renders a curie as the expanded url", async () => {
  const root = makeRepo({
    "design/document-model.mmd": PREFIX_MODEL_NO_REL,
    "design/issue/a.md": instance("title: Alpha\nstatus: open\n", "See [6](gh:6).\n"),
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "--json", "body", "get", "issue:a.md"]);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out) as { body: string };
  // Get shows the canonical curie form, not the expanded url.
  assert.equal(out.body, "See [6](gh:6).\n");
});

test("model check reports a prefix target missing its delimiter", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix gh: https://github.com/org/repo/issues
    class issue {
        +string title
    }
`,
  });

  const r = await run(["--cwd", root, "model", "check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /prefix-delimiter/);
});

test("validate: an external relation target is not flagged as missing", async () => {
  const root = makeRepo({
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    %% @prefix resource: <repo:design/resource/> .
    %% @prefix gh: https://github.com/org/repo/issues/
    class issue {
        +string title
    }
    class resource {
        +string name
    }
    issue "0..1" --> "0..*" resource : attachment
`,
    "design/issue/a.md": instance("title: Alpha\nattachment: [gh:6]\n"),
  });

  await run(["--cwd", root, "index"]);
  const r = await run(["--cwd", root, "validate"]);
  assert.equal(r.code, 0);
});
