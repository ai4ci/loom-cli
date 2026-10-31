# Architecture

Current as of 0.8.8. Supersedes `legacy/implementation-plan.md`,
`legacy/scope.md` and `legacy/complex-path-examples.md`.

## 1. Guiding decisions

### 1.1 Files are the source of truth

Every markdown file is a typed instance governed by the model. Anything derived
is a projection that can be rebuilt:

| Artefact | Committed? | Rebuilt by |
|---|---|---|
| Markdown files with YAML frontmatter | yes | — |
| Protected `loom:links` blocks | yes | `loom index` |
| Inline views (`<!-- loom view: -->`) | yes (expanded) | `loom render` |
| DuckDB projection | no | `loom rebuild` (auto on demand) |
| Embeddings | no | `loom rebuild` / `similar` |
| Validation report | yes (useful output) | `loom validate` |

### 1.2 Validate then write, not database transactions

Mutations plan a changeset, validate the entire graph in memory, and only then
write files. There is no database to transact against — the write phase is a
sequence of file writes. Two agents writing concurrently can interleave; see
`cli-interface.md` §9.

### 1.3 Runtime and dependencies

Node ≥ 22 (native TypeScript stripping), TypeScript ESM, Commander for the CLI,
the `yaml` package for frontmatter, DuckDB (WASM-free node bindings) for the
projection, `@xberg-io/tree-sitter-language-pack` for source anchors.
Installs with bun or npm; run directly from `src/cli.ts` for development.

### 1.4 Agent-first

Every command has a machine-readable form (`--json`), stable diagnostic codes,
and `fix` hints. Errors say what to do next, not just what went wrong. Ambiguity
is a hard error (`source/ambiguous-anchor`, `path/collision`, `uri/bare-path`),
never a silent guess.

## 2. Model

The model is a Mermaid class diagram, `document-model.mmd`, found by searching
the repository. Its directory is the **design root**. Classes declared in it
define document types; attributes define frontmatter; relations define links;
cardinalities are UML-style (`"0..*"`, `"1"`); the keyword aliases `one` and
`many` are accepted.

### 2.1 Class annotations

Mermaid comments in the model file carry loom annotations:

```
%% @prefix <name>: <target> .   where a class's files live, or an external namespace
%% @view <name>                 named SQL view for inline rendering
%% SELECT ...                   (continuation lines of a @view)
```

The angle brackets and trailing ` .` (turtle form) are optional. The retired
`%% @path` annotation is a hard error, `model/path-removed`, whose fix names
the equivalent `%% @prefix` line.

### 2.2 Path resolution

A class root is where a class's files live; the class name is the uri scheme
(`issue:a.md` lives under the `issue` root). `@base` is implicit: the
directory holding `document-model.mmd`. `repo:` is a reserved,
always-available scheme meaning the repository root. Resolution
(`src/path-resolution.ts` `resolveClassRoots`; worked cases in
`design/prototype.md`):

1. **Explicit `%% @prefix <class>: <target> .`** wins.
   - `repo:x/` — repo-rooted.
   - An absolute URL (`https:`, `file:`, …) — external (2.4); ignores `@base`.
   - Anything else — relative to `@base`; `../` allowed, but a path escaping
     the repository is `path/escapes-repo`.
2. **No prefix, with a UML parent:** the parent's root plus the class name
   (`src <|-- main` with `src: <repo:src/>` gives `src/main`). Parents with no
   root (abstract, enumeration) are skipped. Parents that disagree are
   `path/ambiguous-inheritance` — give the class an explicit prefix.
3. **No prefix, no rooted parent:** `@base` plus the class name.

There is no special case for `src` or `resource`: with the model in
`design/`, an unprefixed `src` resolves to `design/src`, so a real source
tree needs `%% @prefix src: <repo:src/> .`. Only a model at the repo root gets
`src/` for free.

Collision between two classes resolving to the same path is a hard error
`path/collision`; a missing directory is a warning `path/missing-directory`.
There is exactly one root per class.

The repository root is the git root; `LOOM_REPO_ROOT` overrides it (e.g. one
self-contained loom per monorepo package, so `repo:` means the package).

`loom rebuild` also writes `<model dir>/.loom/namespaces.ttl`: an export-only
turtle file with `@base` and one `@prefix` per rooted class (always in `repo:`
form, so it stays portable) plus the external prefixes. It is regenerated, not
read, and is checked in (only `.loom/db/` is ignored).

### 2.3 Terminal anchors

`src` and `resource` are non-instantiable classes that anchor the two
exterior families: `src:` addresses code files and symbols,
`resource:` addresses anything referenced but not modelled as a document.
Subclasses (`test`, `spec`, …) inherit the family role and nest under the
family root like any other subclass (`src/test`) unless given their own
prefix. Membership is determined by the schema (`inReservedFamily`), and
relations may target the family or a subclass.

### 2.4 External prefixes

```
%% @prefix gh: <https://github.com/org/repo/issues/> .
%% @prefix data: <file:///srv/shared-data/> .
```

A prefix whose target is an absolute URL is external.
The target **must** end in `/` or `#` (`model/prefix-delimiter`) — expansion is
string concatenation, so the delimiter is what makes `gh:6` unambiguous.
A prefix wins over a same-named class. Resolving `gh:6` yields the expanded
URL and an `external` flag; external uris are exempt from filesystem existence
checks, render as links to the URL, and round-trip: text pasted through
`body set`/`apply` containing a matching URL is canonicalised back to the
curie.

### 2.5 Type vocabulary

Attributes: `string`, `int`, `float`, `bool`, `date`, `path`, `uri`, an
enumeration class name, or a class name (a nested value). A trailing `?` makes
the attribute optional; `List~T~` / `T[]` makes it a list. By convention class
names are lowercase, enums and value types PascalCase — but membership is
semantic (annotations), not naming.

- **Enumerations** (`<<enumeration>>`) declare members in order; they project
  as native DuckDB ENUM types.
- **Value types** may not have relations and may not compose each other in
  cycles (`value-type-has-relations`, `value-type-cycle`).
- **Abstract classes** are not instantiable and cannot have roots.
- **Nested values** (class-typed attributes) project as `STRUCT`s — subfield
  access without casts; a misspelled subfield fails with a DuckDB Binder
  Error rather than silently returning null.

### 2.6 Relations and inheritance

A relation's yaml key is the relation name; the edge is stored once, on the
source side (`rel: [targets]`), and projected into the `edge` triple table.
Inheritance is covariant on both endpoints: a subclass may be used wherever
its parent is expected, and inherits attributes and relations. Relations are
scoped by the **subject's** class: `issue --> src : implements` and
`src --> test : implements` are distinct relations resolved by walking UML
ancestry from the subject's class upward — first declaration wins, a subclass
may override, and an undeclared relation is a hard error.

## 3. Instance files

```markdown
---
class: issue
id: a.md            # optional; inferred from the filename when absent
title: Open A
status: open
blocks:
  - issue:b.md
---

prose…
<!-- loom:links start -->
- blocks: [Open B](issue/b.md)
### Backlinks
- implements: [Auth](src/auth.md)
<!-- loom:links end -->
```

- `class` selects the definition; `id` must match the filename when given
  (`instance/id-mismatch`).
- Relations are per-relation keys, lists of uris.
- The `loom:links` block is a **protected region**: regenerated by `loom
  index` (and `validate --fix`) as outbound links plus a `### Backlinks`
  section, each entry `- relation: [Title](relative-path)`; never hand-edited
  (a hand edit is reported `graph/stale-links`).
- The uri of an instance is `<class>:<path-under-root>`; anchors extend it as
  `#symbol`.

## 4. Changesets

A changeset is a YAML file of ops: `create`, `set`, `link`, `unlink`,
`rename`, `delete`, `body`. Application is plan → validate graph in memory →
write; `--dry-run` returns unified diffs. Single-op sugar commands map 1:1
onto ops (see `cli-interface.md` §5). Renames rewrite every inbound uri across
the corpus, including reverse-link comments in code.

## 5. Uri canonicalisation

`resolveUri` maps a uri to a repo-relative path using the class roots. Because
each class has exactly one root, canonicalisation is deterministic: the
**longest matching root** wins for paths addressed as `repo:`. `formatUri`
always emits the curie form, so anything that round-trips a uri migrates off
the legacy slashed forms. A uri whose path escapes its class root is
`path/escapes-root`.

## 6. Projection

The DuckDB database lives at `designRoot/.loom/db/<branch>/loom.duckdb` — one
per git branch (sanitised; detached HEAD becomes `detached/<sha12>`). Schema:
one table per instantiable class (columns `uri`, `id`, `path`, plus
attributes — enums as native ENUM types, nested values as `STRUCT`s, lists as
arrays), and `edge(subject, relation, object)` as a triple store. Embeddings
(256-dim bag-of-features) are stored alongside for `similar`.

## 7. Source linkage

See `design/source-linkage.md`.

## 8. Environment

Two environment variables are read: `LOOM_DEFAULT_ROOT` overrides the
discovered design root, and `LOOM_REPO_ROOT` overrides the git root.
Everything else is either discovered or declared in the model.

## 9. Deferred

MCP server, RDF export of relations, watermarks, pre-commit hook, concurrency — see
`cli-interface.md` §9 and `design/open-issues.md`.
