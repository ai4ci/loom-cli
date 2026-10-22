# CLI interface

The command surface of `design-docs`. This is the contract an agent or script
codes against; [implementation-plan.md](./implementation-plan.md) says *why*
each piece exists, [source-linkage.md](./source-linkage.md) settles how source
code is addressed, and [scope.md](./scope.md) states the requirements.

**Status.** Every command here is built. Where this document and the code
disagree, the code is right and this document is a bug.

## 1. Invocation

```
design-docs [global options] <command> [arguments] [command options]
```

Global options must appear **before** the command name, because they are
declared on the root program:

```
design-docs --json resolve issue://a.md      # correct
design-docs resolve issue://a.md --json      # not recognised as global
```

| Global option | Default | Effect |
|---|---|---|
| `--json` | off | Emit JSON instead of YAML. Same data, different serialisation. |
| `--cwd <dir>` | `process.cwd()` | Directory from which configuration is discovered. Everything else resolves relative to the repo root found from here. |
| `--help`, `-h` | — | Commander's generated help. Works on the root and on every subcommand. |

There is no `--version` flag. See §7.

Configuration is found by walking up from `--cwd` for `.design-docs.yaml`,
falling back to the nearest git root with all defaults applied. See
implementation-plan §2.1 for the file's shape.

## 2. Output contract

**YAML by default, JSON with `--json`.** Storage is YAML and changesets are
YAML, so structured output is YAML too — `show` output can be pasted into a
changeset. JSON is a serialisation switch over the same data structure, not a
second code path.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | The command ran and found problems: validation failures, a failed query, a malformed uri, a stale index. |
| `2` | Usage error or internal fault. Also what Commander returns for unknown commands. |

### Three result shapes

Every command emits exactly one of these, and an agent has to handle all three.

**Data** — a plain result object on stdout, exit 0.

```yaml
uri: issue://a.md
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
    message: '"status" must be one of open, closed, got "nonsense"'
    uri: issue://bad.md
```

**Error** — stdout is empty, stderr carries `code: message`, exit 1. Thrown for
conditions that abort before a report can be assembled: a malformed uri, a
missing file, a failed SQL statement.

```
instance/not-found: no file at design/issue/ghost.md
```

### Diagnostic record

```yaml
severity: error | warning
code: <namespace>/<kebab-case>   # stable identifier, see §6
message: <human-readable>
uri: <canonical uri>             # when there is a subject
line: <1-indexed>                # when known
fix: <what to do>                # when the repair is unambiguous
```

`ok` is `false` only when at least one diagnostic has `severity: error`.
Warnings never fail a run.

### Idempotence

`rebuild`, `index`, and re-applying an identical changeset are all no-ops on a
second run. `validate --fix` converges: running it twice produces no further
writes.

## 3. Inspection

### `resolve <uri>`

Resolve a design uri to a repo-relative path, and a `src://` anchor to a line
number.

| | |
|---|---|
| Arguments | `<uri>` — any design uri, optionally with a `#symbol` anchor |
| Exit | 0 always, including for a path that does not exist; 1 only for a malformed uri |

```yaml
uri: src://app.ts#runApp      # canonical, most-compact form
scheme: src
path: src/app.ts              # repo-relative
absolutePath: /abs/src/app.ts
anchor: runApp                # present only when the uri had one
line: 1                       # present only when the anchor resolved
candidates:                   # every root tried, in precedence order
  - src/app.ts
ambiguous: false              # true when several roots matched on disk
exists: true
```

`exists: false` is a fact, not an error — exit stays 0, so `resolve` is safe to
use as a lookup before deciding what to do.

`candidates` and `ambiguous` matter for multi-root classes (the `src` family).
First match wins; `ambiguous: true` means the choice was arbitrary and the
config should disambiguate.

### `show <uri>`

Read one instance.

```yaml
uri: issue://a.md
path: design/issue/a.md
frontmatter:            # parsed yaml header, or null
  class: issue
  title: Aye
  status: open
links: null             # protected link block content, or null when absent
markdown: "\nProse.\n"  # everything after the frontmatter, verbatim
```

Exits 1 with `instance/not-found` when the file is missing.

### `ls <uri>`

List what can be linked to. The uri space is one hierarchy in which `#anchor`
is a deeper level than the path, so `ls` is directory descent and needs no mode
switch.

```
design-docs ls issue://                  # instances of a class
design-docs ls src://                    # directories and files
design-docs ls src://pkg/app.ts          # linkable anchors in the file
design-docs ls src://pkg/app.ts#Service  # anchors nested in that anchor
```

| Option | Default | Effect |
|---|---|---|
| `--depth <n>` | `1` | How far to descend. |
| `--kind <k,...>` | all | Narrow to given structure kinds. |
| `--linked` / `--unlinked` | both | Filter by whether a design document already points there. |

```yaml
parent: src://pkg/app.ts
entries:
  - uri: src://pkg/app.ts#Service
    kind: Class
    line: 6
    signature: class Service
    children: 2
    linked: true
```

`--unlinked` answers the question that motivates the command: *what in this
file is not yet covered by any issue?* It is read from the edge table.

What counts as a linkable anchor is a configured policy over the language
pack's normalised structure kinds — see source-linkage §2.1. If `ls` does not
list it, it is not linkable.

### `locate <uri> --line <n>`

The address of a line: the reverse of `resolve`.

```yaml
anchor:
  uri: src://app.ts#Service.run     # innermost linkable ancestor
  kind: Method
  span: { startLine: 40, endLine: 55 }
ancestors:                           # coarser choices, outermost last
  - { uri: "src://app.ts#Service", kind: Class }
  - { uri: "src://app.ts", kind: File }
```

A line in an import block or a top-level statement has no linkable ancestor:
`anchor` is `null` and the file is the only target, which is honest rather than
inventing a node.

A line number is an **input convenience and is never stored**. There is no
`#L42` anchor form — a line does not say what granularity it means.

## 4. Model and validation

### `model check [--model <path>]`

Parse and validate the document model.

| Option | Effect |
|---|---|
| `--model <path>` | Check a proposed model instead of `<designRoot>/document-model.mmd`. Nothing is written or installed. |

```yaml
model: /abs/design/document-model.mmd
ok: true
errors: 0
warnings: 0
diagnostics: []
```

### `validate [uri] [--model <path>] [--fix]`

With a uri, validate one instance against the model — everything checkable
without reading other files. Without one, walk every class root and check the
whole graph, including what no single file can see.

| Option | Effect |
|---|---|
| `--model <path>` | Validate against a proposed model. Impact analysis for a model change. **Does not write the report file**, since a what-if must not overwrite the recorded state. |
| `--fix` | Apply the unambiguous repairs, then re-read from disk and report the resulting state. |

Whole-repository output adds `instances` and `report`:

```yaml
instances: 3
report: design/VALIDATION.md   # omitted when --model was given
ok: false
errors: 1
warnings: 0
diagnostics: [...]
```

With `--fix`, a `fixed` array lists the paths rewritten.

**What `--fix` repairs**, and only this:
- a protected link block that disagrees with the yaml (`graph/stale-links`)
- a uri that is not in its most compact form (`graph/non-canonical-uri`)

Everything else is reported. A dangling link is a judgement call — the tool
does not guess whether to create the target or drop the reference.

A link block that is **absent** is not a finding. It has simply never been
generated, and failing every file of an existing repository on first run would
make the tool unusable. A block that is present but wrong *is* an error,
because that one is actively misleading.

The report is written to `<designRoot>/VALIDATION.md` as a plain generated
file — not as an `issue` instance, which would create a bootstrapping
circularity during exactly the phases when validation is least trustworthy.

## 5. Mutation

Every mutation follows the same sequence: parse, apply to an in-memory graph,
validate the **whole resulting graph**, and only then write. A changeset that
fails validation leaves the working tree byte-identical. Files are staged as
temporary siblings and renamed together. Git is the undo mechanism; there is no
rollback journal.

### `apply <changeset> [--dry-run]`

Apply a changeset file transactionally. The format is in
implementation-plan §2.3.

```yaml
ops:
  - { op: create, uri: "issue://new.md", attrs: { title: "N", status: open } }
  - { op: set,    uri: "issue://new.md", attrs: { status: closed } }
  - { op: link,   from: "issue://a.md", rel: blocks, to: "issue://b.md" }
  - { op: unlink, from: "issue://a.md", rel: blocks, to: "issue://b.md" }
  - { op: rename, from: "issue://a.md", to: "issue://archive/a.md" }
  - { op: delete, uri: "issue://a.md" }
```

On success:

```yaml
written: [design/issue/a.md]   # paths that received content
removed: []                    # paths that were deleted
ok: true
errors: 0
warnings: 0
diagnostics: []
```

`written` and `removed` are separate because a deleted path is not a written
one — a rename reports the new path in `written` and the old in `removed`.

With `--dry-run`, nothing is written:

```yaml
dryRun: true
changes:
  - path: design/issue/a.md
    action: update          # create | update | delete
    diff: "@@ -1,4 +1,4 @@\n ---\n-status: open\n+status: closed\n"
ok: true
```

The diff is a unified diff built from the common prefix and suffix. It is not
minimal — it reports one changed region — but it is exact: applying it
reproduces the new content.

### Single-op sugar

Each builds a one-op changeset and runs the same path as `apply`, with the same
output shape.

| Command | Equivalent op |
|---|---|
| `create <uri> [key=value...]` | `create` |
| `set <uri> <key=value...>` | `set` |
| `link <from> <relation> <to>` | `link` |
| `unlink <from> <relation> <to>` | `unlink` |

`link` and `unlink` **dispatch on the subject's scheme**. A design instance
writes the relation into its yaml; a `src://` subject writes a comment into the
source file. The shape is subject–relation–object either way, and the model
already constrains which relations are legal in which direction, so there is no
separate verb:

```
design-docs link issue://a.md blocks issue://b.md          # writes yaml
design-docs link src://app.ts#Service.run implements issue://a.md   # writes a comment
design-docs link src://app.ts --line 42 implements issue://a.md     # resolves the line first
```

The source-writing half goes through this same changeset pipeline, so it
inherits validate-then-write, atomic staging and `--dry-run`. Where the comment
is placed, and what cannot be annotated, is settled in source-linkage §4.
Batching is the changeset: N ops in one file, applied in a single pass.

Note that a relation written in source runs **from the code to the document**,
so it is a different relation from its forward counterpart and must be declared
in that direction in the model. `--line <n>` resolves the subject anchor from a
line number instead of a `#name`.
| `delete <uri>` | `delete` |
| `rename <from> <to> [--dry-run]` | `rename` |

Assignment values are parsed as YAML scalars, so `weight=3` is an integer,
`done=true` a boolean, and `title=Some text` a string. Quote to force a string:
`version='1.10'` — unquoted `1.10` parses as the number `1.1`.

`rename` rewrites every inbound uri across the corpus and updates the moved
instance's own `id`. This is what makes path-as-identity survivable: a plain
`git mv` silently breaks every reference to the moved document.

## 6. Derived data, source linkage and search

### `rebuild`

Throw the derived database away and write it again from the files. Full rebuild
only — the files are the source of truth, so this is the cheapest correct
projection and it needs no migrations.

```yaml
database: design/.design-docs.duckdb
tables:
  - { name: issue, rows: 2 }
  - { name: edge, rows: 1 }
  - { name: embedding, rows: 2 }
```

One table per concrete class, plus `edge(subject, relation, object)` and
`embedding(uri, content_hash, v0..vN)`. Abstract classes, enumerations and the
`src`/`resource` families get no table; they appear only as edge endpoints.

Attribute types map to native DuckDB types, so `created > DATE '2026-01-01'`
and `sum(weight)` work without casts. The database and its WAL are git-ignored
by a `.gitignore` written into the design root on first connect.

### `query <sql>`

Run arbitrary SQL against the derived database.

```yaml
rows:
  - { uri: "issue://a.md", title: Aye }
```

A missing database is rebuilt automatically rather than failing: the database
is a cache, and a missing cache is not a user error. A failed statement exits 1
with `query/failed` on stderr, carrying DuckDB's own message.

### `refs <srcUri>`

Which design documents reference a source symbol. The reverse of following an
`implemented-by` link.

```yaml
target: src://app.ts#runApp
references:
  - { from: "issue://one.md", relation: implemented-by }
```

### `prefetch`

Download and cache the tree-sitter grammars named in `languages` in the config,
defaulting to `mermaid`, `typescript`, `r`, `python`.

```yaml
prefetched: [mermaid, typescript, r, python]
```

Grammars download on first use, so an offline or sandboxed run fails unless
this has been run. Make it part of setup.

### `similar <query> [--limit <n>]`

Rank documents by similarity to a query. The argument is either free text or
the uri of an existing instance, in which case that document's body is embedded
and its nearest neighbours returned — so a document ranks itself first.

| Option | Default | Effect |
|---|---|---|
| `--limit <n>` | `10` | Maximum results. |

```yaml
query: text               # or the canonical uri, when given one
queryText: auth           # present only in text mode
results:
  - { uri: "issue://a.md", score: 0.577 }
  - { uri: "issue://b.md", score: 0 }
```

Only the unprotected markdown body is embedded; the generated link block is
stripped first so navigation furniture does not bias the result. Embeddings are
cached by content hash, so a rebuild re-embeds only documents whose body
changed — editing a title does not invalidate the vector.

The shipped embedder is a deterministic, dependency-free bag-of-features
baseline, not a semantic model. It exists so the storage, indexing and ranking
pipeline is exercised end to end without a model download. Scores are
comparable within a single query and meaningless across queries.

### `index [--check]`

Regenerate navigational indexes. An index is an ordinary markdown file whose
frontmatter declares `class: index` and a `view`, and whose body is a protected
generated region of relative links.

```yaml
# filter view
view:
  class: issue
  where: { status: open }
  orderBy: title

# or a raw query view
view:
  query: "SELECT uri, title FROM issue WHERE status = 'closed' ORDER BY title"
```

| Option | Effect |
|---|---|
| `--check` | Do not write. Exit 1 if any index is stale. For CI. |

```yaml
updated: [design/INDEX.md]
unchanged: []
```

With `--check` and a stale index, the shape differs — see §7.

## 7. Diagnostic codes

Codes are stable identifiers; match on these rather than on message text.

| Namespace | Raised by | Meaning |
|---|---|---|
| `cli/` | argument parsing | `bad-assignment`, `missing-option` |
| `config/` | configuration | `reserved-scheme` |
| `uri/` | uri handling | `malformed`, `escapes-root`, `not-a-class` |
| `model/` | model parsing and validation | see below |
| `instance/` | one instance against the model | see below |
| `graph/` | cross-file checks | see below |
| `source/` | source code addressing and reverse links | `dangling-reverse-link`, `invalid-reverse-relation`, `ambiguous-anchor`, `unsupported-language`, `not-annotatable`, `verification-failed`, `not-found` |
| `changeset/` | changeset parsing and application | see below |
| `query/` | derived database | `no-database`, `failed` |
| `ls/` | discovery | `not-found`, `not-a-class`, `not-a-directory` |

**`model/`** — `syntax`, `unknown-type`, `untyped-attribute`,
`malformed-member`, `duplicate-class`, `unknown-class`, `name-collision`,
`empty-enumeration`, `inheritance-cycle`, `abstract-has-root`,
`reserved-has-attributes`, `value-type-has-relations`, `value-type-cycle`,
`composition-arrow`, `unnamed-relation`, `no-title-attribute` *(warning)*,
`not-found`.

**`instance/`** — `unknown-class`, `not-instantiable`, `class-mismatch`,
`id-mismatch`, `missing-required`, `unknown-key`, `type-mismatch`,
`invalid-enum-value`, `invalid-uri`, `wrong-target-class`, `cardinality`,
`not-found`.

**`graph/`** — `orphan-file`, `dangling-link`, `inbound-cardinality`,
`missing-path`, `missing-resource`, `missing-source-file`, `missing-symbol`,
`stale-links`, `non-canonical-uri`.

**`changeset/`** — `unparseable`, `no-ops`, `malformed-op`, `unknown-op`,
`missing-field`, `not-found`, `already-exists`, `not-instantiable`,
`unknown-relation`, `rename-across-classes`.

`model/no-title-attribute` is the only warning currently emitted. Everything
else is an error — including `source/ambiguous-anchor`, because an address that
resolves to several things is harder to handle at every layer than one that
simply fails.

## 8. Known rough edges

Recorded rather than silently fixed, because each is a contract change.

**`index --check` changes shape between pass and fail.** On success it emits
`{updated: [], unchanged: []}`; on failure `{ok: false, stale: [...]}`. A
caller has to handle both. The failure shape is the useful one; the success
shape should probably match it with `ok: true, stale: []`.

**Two error-reporting styles.** Some failures produce a structured report on
stdout with `diagnostics`; others throw and write `code: message` to stderr
with empty stdout. The split is pragmatic — a thrown error aborts before a
report can be assembled — but an agent must handle both. A future revision
could emit the report shape for every failure, with the thrown diagnostic as a
single-element `diagnostics` array.

**No `--version`.** Commander will not report the package version because
`.version()` is never called.

**`similar` uses `query: text` as a sentinel** rather than a separate `mode`
field, so a document literally named `text` would be ambiguous. Harmless today;
a `mode: text | uri` field would be cleaner.

**Global options must precede the command.** Commander's default behaviour, but
an easy mistake — `design-docs validate --json` silently ignores `--json`.

## 9. Not built

Deferred deliberately; see implementation-plan for the reasoning.

- **Composite attributes.** Class-typed attributes serialised as nested YAML
  blocks. The syntax and the DuckDB `STRUCT` projection are settled, so adding
  them is additive.
- **MCP server.** A thin wrapper exposing `validate`, `query`, `refs`,
  `similar` and `apply` as MCP tools, held back until this CLI contract has
  been exercised by real use rather than frozen early.
- **Concurrency.** Two agents running `apply` at once can interleave writes.
  There is no lock. The fix, if it becomes necessary, is a lockfile around the
  write phase, not a redesign.
