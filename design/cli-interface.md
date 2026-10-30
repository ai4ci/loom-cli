# CLI interface

Current as of 0.8.8. The pre-0.8 documents live in `design/legacy/`.

## 1. Invocation

```
loom [global options] <command> [args]
```

Global options must **precede** the subcommand:

| Option | Meaning |
|---|---|
| `-v, --version` | Print the installed version. Works with no model, config or git repository. |
| `--json` | Emit JSON instead of YAML. |
| `--cwd <dir>` | Run as if invoked from `<dir>`; repository root is discovered via git. |

```bash
loom --json resolve issue:a.md     # correct
loom resolve issue:a.md --json     # not recognised as global
```

Zero configuration: loom finds `document-model.mmd` by searching the repository
(`src/config.ts` `findModelFiles`). The model's directory becomes the design
root. `.loom.yaml` is optional and only needed to override `designRoot` or the
source anchor policy.

### `<uri>` arguments are uris, never paths

Every argument spelled `<uri>` takes a design uri — `issue:a.md`, not
`design/issue/a.md`. A path-shaped argument is rejected with `uri/bare-path`
and the error names the uri to use instead:

```
$ loom resolve design/issue/a.md
uri/bare-path: "design/issue/a.md" is a filesystem path, not a design uri
  fix: address the document by class and id, as <class>:<id>
       (`loom ls <class>:` lists what exists)
```

The suggestion is computed from the class roots, so it handles absolute paths
inside the repository, `#anchor` suffixes, and paths under no class root (which
become `repo:`).

### Uri forms

A uri is `scheme:path#anchor` — a curie. `issue:a.md` is the canonical form.
The slashed forms (`issue://a.md`, `issue:/a.md`) still parse but are flagged
`legacy`; anything that round-trips a uri rewrites it to the curie form
(`src/uri.ts` `formatUri`). External schemes declared with `%% @prefix` in the
model (e.g. `gh:`) expand to absolute URLs; ordinary schemes (`https:`,
`mailto:`) pass through untouched.

## 2. Output contract

**YAML by default, JSON with `--json`.** Storage is YAML and changesets are
YAML, so structured output is YAML too — `show` output can be pasted into a
changeset. JSON is a serialisation switch over the same data structure, not a
second code path.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | The command ran and found problems: validation failures, a failed query, a malformed uri, a stale index or view. |
| `2` | Usage error or internal fault. Also what Commander returns for unknown commands. |

### Three result shapes

Every command emits exactly one of these.

**Data** — a plain result object on stdout, exit 0.

```yaml
uri: issue:a.md
scheme: issue
path: design/issue/a.md
```

**Report** — a result object carrying an embedded diagnostic summary. Emitted
by `validate`, `model check`, `apply` and the mutation sugar. Exit 0 or 1
depending on `ok`.

```yaml
instances: 3
report: design/VALIDATION.md
ok: false
errors: 1
warnings: 0
diagnostics:
  - severity: error
    code: instance/invalid-enum-value
    message: 'status: "opend" is not one of open, in_progress, closed'
    uri: issue:a.md
    fix: use one of the enum values
```

`ok` is `false` only when at least one diagnostic has `severity: error`.
Warnings never fail a run.

**Error** — a thrown diagnostic on stderr, exit 1 or 2, empty stdout. Used when
a command cannot start at all (malformed uri, missing file, a failed SQL
statement). A diagnostic carrying a `fix` prints it under the message.

### Diagnostic record

Every diagnostic is `{severity, code, message}` plus optional context:
`uri`, `path`, `line`, and `fix` (a one-line suggestion). `code` is a stable
machine-readable identifier — match on codes, not message text (§7).

## 3. Inspection

### `resolve <uri>`

Resolve a design uri to a repo-relative path, and a `src:` anchor to a line
number. Exit 0 always, including for a path that does not exist (`exists:
false` is a fact, not an error), 1 only for a malformed uri. `candidates` and
`ambiguous` matter for multi-root classes (the `src` family); first match wins.

### `show <uri>`

Frontmatter (as parsed), the protected links block, and the markdown body.

### `body get|set|append|patch <uri>`

Read and edit the prose of an instance without touching frontmatter or links.

- `body get` prints the body; design uris appearing as markdown links in the
  prose are shown in curie form.
- `body set <uri> <text>` (or `--file <path>`) replaces the whole body.
  Text read **from disk or stdin through the CLI** is canonicalised: relative
  links matching a class root become uris, external prefix URLs become curies.
  Links that resolve are rewritten to relative paths on write.
- `body append` adds to the end; `body patch` applies a unified diff
  (`body/patch-failed` when it does not apply). Both canonicalise input text
  like `set`.

`--dry-run` shows the unified diff without writing.

### `ls <uri>` / `find <uri>`

`ls` lists what can be linked to at one level: instances of a class
(`loom ls issue:`), directories and files under a source root
(`loom ls src:`), or linkable symbols in a file (`loom ls
src:auth.ts`). `--linked` / `--unlinked` filter by whether the entry
already has an inbound design link; `--kind` filters anchors by structure kind.

`find` is the recursive counterpart: it walks directories, files and anchors
below the uri, unlimited depth by default. `--depth n` counts structural
levels — directories and anchor dots alike; a file within the budget lists its
anchors, a file at the boundary is named but not opened.

### `locate <uri> --line <n>`

The address of a line: its innermost linkable ancestor (declaration or
anchor), with the qualified name to link.

### `refs <srcUri>`

Find design documents referencing a code symbol (the reverse of `ls`).

### `similar <query> [--limit n]`

Rank documents by semantic similarity (bag-of-features embeddings, 256
dimensions, cosine). If the query looks like a uri (`scheme:...`) and an
instance with that uri exists, similarity is to that document; otherwise the
query text is embedded. Result is a ranked list of `{uri, title, score}`.

## 4. Model and validation

### `model check [--model <file>]`

Parse and validate the mermaid model itself: unknown types, untyped
attributes, duplicate classes, inheritance cycles, composition arrows,
malformed `%% @path` / `%% @prefix` / `%% @view` annotations, enum and value
type rules (§7 `model/`).

### `validate [uri] [--model <file>] [--fix]`

Validate the repository (or one instance) against the model: frontmatter
against class definitions, links against relations and cardinalities, source
anchors against the code, file placement against class roots. Writes a human
report to `designRoot/VALIDATION.md` and returns the report shape.

`--fix` repairs what is mechanically repairable — stale link blocks,
non-canonical uris, renamed symbols — by planning and applying a changeset.

## 5. Mutation

### `apply <changeset.yaml> [--dry-run]`

Apply an atomic multi-operation changeset. All uris are validated first; then
the whole graph is validated in memory; only then are files written. On any
error nothing is written.

```yaml
ops:
  - { op: create, uri: "issue:b.md", attrs: { title: "B" } }
  - { op: set,    uri: "issue:a.md", attr: status, value: closed }
  - { op: link,   from: "issue:a.md", rel: blocks, to: "issue:b.md" }
  - { op: unlink, from: "issue:a.md", rel: blocks, to: "issue:b.md" }
  - { op: rename, from: "issue:a.md", to: "issue:archive/a.md" }
  - { op: delete, uri: "issue:a.md" }
  - { op: body,   uri: "issue:a.md", mode: set, text: "new prose" }
```

`--dry-run` returns `{dryRun: true, changes: [{path, action, diff}], ...}`
with a unified diff per file and writes nothing.

### Single-operation sugar

Each sugar command is one changeset op; all accept `--dry-run`.

| Command | Op |
|---|---|
| `create <uri> [key=value ...]` | `create` (values parsed as yaml scalars) |
| `set <uri> <key>=<value> ...` | `set` |
| `link <from> <rel> <to>` | `link` — instances, or `src` to a document |
| `unlink <from> <rel> <to>` | `unlink` (removes reverse-link comments too) |
| `rename <from> <to>` | `rename` (rewrites every inbound uri) |
| `delete <uri>` | `delete` |
| `body set/append/patch` | `body` |

Link dispatch is on the **subject's** scheme: `loom link issue:a.md blocks
issue:b.md` writes frontmatter; `loom link src:auth.ts#login implements
issue:a.md` writes a comment into the code. `--line <n>` converts a line to
its innermost anchor at input time (never stored).

### `render [--check] [--debug]`

Expand inline views (see `design/inline-views.md`): `<!-- loom view: ... -->`
markers in markdown and `%% @view` definitions in the model.

- default: rewrite each marker's section in place with the query result.
- `--check`: no-write dry run; exit 1 naming stale repo-relative files, exit 0
  silently when everything is fresh. For CI.
- `--debug`: also emit `<file>: view <name>` plus the resolved SQL (indented
  two spaces) to stderr; inline markers are named `(inline)`.

Uri columns render as `[title](relative-path)` links; external-prefix targets
render as links to the expanded URL; uris that do not resolve stay plain text.

## 6. Projection

### `rebuild`

Rebuild the DuckDB projection at `design/.loom/db/<branch>/loom.duckdb` — one
database file per git branch, so model changes on a branch never collide with
`main`. `main` itself uses `design/.loom/db/main/loom.duckdb`. The `.loom/`
directory is created on demand with a `.gitignore` containing `db/`.

One table per instantiable class: `uri`, `id`, `path`, plus one column per
attribute. Enumerations become native DuckDB ENUM types. Class-typed
attributes project as `STRUCT`s, lists as arrays. Edges land in an RDF-style
triple store: `edge(subject, relation, object)`.

`query`, `similar` and `index` rebuild automatically when the database is
missing.

### `query <sql>`

Run arbitrary SQL. Errors are `query/failed`; a missing database is
`query/no-database`.

```bash
loom query "SELECT uri, title FROM issue WHERE status = 'open'"
loom query "SELECT subject, object FROM edge WHERE relation = 'blocks'"
```

### `index [--check]`

Regenerate navigational indexes: any markdown file with `class: index`
frontmatter defines a filtered or SQL-driven listing rendered into its
protected `loom:links` block. `--check` exits 1 when any index is stale.

### `prefetch <languages...>`

Warm the tree-sitter grammar cache for offline use; otherwise grammars load
lazily on first parse.

## 7. Diagnostic codes

Codes are stable identifiers; match on these rather than on message text.

| Namespace | Raised by | Codes |
|---|---|---|
| `cli/` | argument parsing | `bad-assignment`, `missing-argument`, `missing-option`, `file-not-found` |
| `uri/` | uri handling | `malformed`, `bare-path`, `not-a-class` |
| `path/` | class root resolution | `collision`, `escapes-root`, `escapes-repo`, `missing-directory` *(warning)*, `unknown-class` |
| `model/` | model parsing and validation | see below |
| `instance/` | one instance against the model | see below |
| `graph/` | cross-file checks | see below |
| `source/` | source addressing and reverse links | `dangling-reverse-link`, `invalid-reverse-relation`, `ambiguous-anchor`, `unsupported-language`, `not-annotatable`, `verification-failed`, `not-found` |
| `changeset/` | changeset parsing and application | see below |
| `query/` | derived database | `no-database`, `failed`, `enum-type` |
| `ls/` | discovery | `not-found`, `not-a-class`, `not-a-directory` |
| `body/` | prose editing | `patch-failed` |

**`model/`** — `syntax`, `unknown-type`, `untyped-attribute`,
`malformed-member`, `duplicate-class`, `unknown-class`, `name-collision`,
`ambiguous`, `empty-enumeration`, `inheritance-cycle`, `reserved-has-attributes`,
`value-type-has-relations`, `value-type-cycle`, `composition-arrow`,
`unnamed-relation`, `no-title-attribute` *(warning)*, `not-found`,
`duplicate-prefix`, `prefix-delimiter`, `duplicate-view`.

**`instance/`** — `unknown-class`, `not-instantiable`, `class-mismatch`,
`id-mismatch`, `missing-required`, `unknown-key`, `type-mismatch`,
`invalid-enum-value`, `invalid-uri`, `wrong-target-class`, `cardinality`,
`not-found`.

**`graph/`** — `orphan-file`, `dangling-link`, `inbound-cardinality`,
`missing-path`, `missing-resource`, `missing-source-file`, `missing-symbol`,
`renamed-symbol`, `stale-links`, `non-canonical-uri`.

**`changeset/`** — `unparseable`, `no-ops`, `malformed-op`, `unknown-op`,
`missing-field`, `not-found`, `already-exists`, `not-instantiable`,
`unknown-relation`, `rename-across-classes`.

`model/no-title-attribute` and `path/missing-directory` are the only warnings.
Everything else is an error — including `source/ambiguous-anchor`, because an
address that resolves to several things is harder to handle at every layer
than one that simply fails.

## 8. Known rough edges

Recorded rather than silently fixed, because each is a contract change.

**`index --check` changes shape between pass and fail.** On success it emits
`{updated: [], unchanged: []}`; on failure `{ok: false, stale: [...]}`. The
failure shape is the useful one; the success shape should match it with
`ok: true, stale: []`.

**Two error-reporting styles.** Some failures produce a structured report on
stdout; others throw and write `code: message` to stderr with empty stdout.
The split is pragmatic — a thrown error aborts before a report can be
assembled — but an agent must handle both.

**Global options must precede the command.** Commander's default behaviour,
but an easy mistake — `loom validate --json` silently ignores `--json`.

## 9. Not built

Deferred deliberately.

- **MCP server.** A thin wrapper exposing `validate`, `query`, `refs`,
  `similar`, `body` and `apply` as first-class agent tools. Held back until
  the CLI contract has been exercised by real use.
- **RDF / Turtle export.** The decisions are recorded in
  `design/open-issues.md`; waiting for a consumer.
- **In-file agent watermarks.** Header comments deterring direct edits.
- **Git pre-commit enforcer.** A hook running `loom validate && loom render
  --check && loom index --check`.
- **Concurrency.** Two agents running `apply` at once can interleave writes;
  the fix, if needed, is a lockfile around the write phase.
