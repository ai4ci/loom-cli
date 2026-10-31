import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { run } from "../src/cli.ts";
import { instance, makeRepo } from "./helpers.ts";

/**
 * Declaration order (triage, in_progress, blocked, done) is deliberately not
 * alphabetical (blocked, done, in_progress, triage), so every ordering
 * assertion here fails if the column degrades to VARCHAR.
 */
const MODEL = `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class Stage {
        <<enumeration>>
        triage
        in_progress
        blocked
        done
    }
    class issue {
        +string title
        +Stage stage
    }
`;

function repo(stages: Record<string, string>, model = MODEL): string {
  const files: Record<string, string> = {
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": model,
  };
  for (const [name, stage] of Object.entries(stages)) {
    files[`design/issue/${name}.md`] = instance(`class: issue\ntitle: ${name}\nstage: ${stage}`);
  }
  return makeRepo(files);
}

async function rows(root: string, sql: string): Promise<any[]> {
  const r = await run(["--cwd", root, "query", sql]);
  assert.equal(r.code, 0, r.err);
  return (parse(r.out) as Record<string, any>).rows as any[];
}

test("an enumeration attribute becomes a native ENUM column", async () => {
  const root = repo({ a: "triage" });
  await run(["--cwd", root, "rebuild"]);
  const described = await rows(root, "DESCRIBE issue");
  const types = Object.fromEntries(described.map((row) => [row.column_name, row.column_type]));

  assert.equal(types.stage, "ENUM('triage', 'in_progress', 'blocked', 'done')");
  assert.equal(types.title, "VARCHAR");
});

test("ORDER BY an enum follows declaration order, not alphabetical order", async () => {
  const root = repo({ a: "done", b: "triage", c: "blocked", d: "in_progress" });
  await run(["--cwd", root, "rebuild"]);
  const ordered = await rows(root, "SELECT title FROM issue ORDER BY stage");

  assert.deepEqual(ordered.map((r) => r.title), ["b", "d", "c", "a"]);
});

test("an ordering comparison follows declaration order once the literal is cast", async () => {
  const root = repo({ a: "triage", b: "in_progress", c: "done" });
  await run(["--cwd", root, "rebuild"]);
  const later = await rows(root, "SELECT title FROM issue WHERE stage > 'triage'::Stage ORDER BY stage");

  assert.deepEqual(later.map((r) => r.title), ["b", "c"]);
});

/**
 * DuckDB resolves `enum <op> 'literal'` by casting the ENUM down to VARCHAR,
 * so an uncast ordering comparison is alphabetical. ORDER BY, MIN/MAX and
 * list_sort are unaffected. Pinned here so the gotcha is not mistaken for a
 * regression: the fix is `::<EnumName>` on the literal, as above.
 */
test("an uncast ordering comparison degrades to alphabetical", async () => {
  const root = repo({ a: "triage", b: "in_progress", c: "done" });
  await run(["--cwd", root, "rebuild"]);
  const later = await rows(root, "SELECT title FROM issue WHERE stage > 'triage'");

  assert.deepEqual(later, []);
});

test("MIN and MAX report the earliest and latest declared member", async () => {
  const root = repo({ a: "done", b: "in_progress", c: "blocked" });
  await run(["--cwd", root, "rebuild"]);
  const [row] = await rows(root, "SELECT MIN(stage) AS lo, MAX(stage) AS hi FROM issue");

  assert.equal(row.lo, "in_progress");
  assert.equal(row.hi, "done");
});

test("an enum value still compares and reads back as its plain string", async () => {
  const root = repo({ a: "blocked", b: "done" });
  await run(["--cwd", root, "rebuild"]);
  const matched = await rows(root, "SELECT title, stage FROM issue WHERE stage = 'blocked'");

  assert.deepEqual(matched, [{ title: "a", stage: "blocked" }]);
});

test("a value outside the enumeration becomes NULL rather than failing the rebuild", async () => {
  const root = repo({ a: "triage", b: "nonsense" });
  const r = await run(["--cwd", root, "rebuild"]);
  assert.equal(r.code, 0, r.err);

  const all = await rows(root, "SELECT title, stage FROM issue ORDER BY title");
  assert.deepEqual(all, [{ title: "a", stage: "triage" }, { title: "b", stage: null }]);
});

test("a list of enum values becomes an ENUM[] column", async () => {
  const root = makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class Stage {
        <<enumeration>>
        triage
        in_progress
        blocked
        done
    }
    class issue {
        +string title
        +List~Stage~ seen
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: Aye\nseen: [done, triage]"),
  });
  await run(["--cwd", root, "rebuild"]);

  const described = await rows(root, "DESCRIBE issue");
  const types = Object.fromEntries(described.map((row) => [row.column_name, row.column_type]));
  assert.equal(types.seen, "ENUM('triage', 'in_progress', 'blocked', 'done')[]");

  // list_sort orders by declared position, not alphabetically.
  const sorted = await rows(root, "SELECT list_sort(seen) AS s FROM issue");
  assert.deepEqual(sorted[0].s, ["triage", "done"]);
});

test("an enum inside a composite attribute is an ENUM field of the STRUCT", async () => {
  const root = makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class Stage {
        <<enumeration>>
        triage
        in_progress
        blocked
        done
    }
    class review {
        +string reviewer
        +Stage outcome
    }
    class issue {
        +string title
        +review audit
    }
`,
    "design/issue/a.md": instance(
      "class: issue\ntitle: Aye\naudit:\n  reviewer: Sam\n  outcome: blocked",
    ),
  });
  await run(["--cwd", root, "rebuild"]);

  const described = await rows(root, "DESCRIBE issue");
  const types = Object.fromEntries(described.map((row) => [row.column_name, row.column_type]));
  assert.match(types.audit, /^STRUCT\(reviewer VARCHAR, outcome ENUM\('triage'/);

  const [row] = await rows(root, "SELECT audit.outcome AS o FROM issue");
  assert.equal(row.o, "blocked");
});

test("an enumeration clashing with a built-in type name fails with a loom diagnostic", async () => {
  const root = makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class date {
        <<enumeration>>
        early
        late
    }
    class issue {
        +string title
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: Aye"),
  });

  const r = await run(["--cwd", root, "rebuild"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /query\/enum-type/);
  assert.match(r.err, /date/);
});

test("two enumerations keep their own independent orderings", async () => {
  const root = makeRepo({
    ".loom.yaml": "designRoot: design\n",
    "design/document-model.mmd": `classDiagram
    %% @prefix issue: <repo:design/issue/> .
    class Stage {
        <<enumeration>>
        triage
        done
    }
    class Size {
        <<enumeration>>
        large
        small
    }
    class issue {
        +string title
        +Stage stage
        +Size size
    }
`,
    "design/issue/a.md": instance("class: issue\ntitle: Aye\nstage: done\nsize: large"),
    "design/issue/b.md": instance("class: issue\ntitle: Bee\nstage: triage\nsize: small"),
  });
  await run(["--cwd", root, "rebuild"]);

  const byStage = await rows(root, "SELECT title FROM issue ORDER BY stage");
  assert.deepEqual(byStage.map((r) => r.title), ["Bee", "Aye"]);

  const bySize = await rows(root, "SELECT title FROM issue ORDER BY size");
  assert.deepEqual(bySize.map((r) => r.title), ["Aye", "Bee"]);
});
