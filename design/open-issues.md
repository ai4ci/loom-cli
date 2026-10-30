# Open Issues

##  0.8.0

## Inline views: URI values rendered as plain text  (0.8.0)

**Implemented in 0.8.4.** `renderView` takes a `LinkContext` (the loaded graph
plus the repo-relative path of the file being rendered). Any cell value that
parses as a design uri and resolves to an existing file is rendered as
`[<title>](<relative path>)` - document title when the uri names an indexed
instance, the uri text otherwise. Unresolvable uris and non-uri values stay
plain text, so a dead uri is visible rather than a silently broken link.
`titleOf`/`relativeLink` in `src/graph.ts` are now shared with `loom index`,
whose own `relativeLink` had silently stopped matching when uris became
curies - also fixed in 0.8.4.

## Inline views: `render --check` CI mode (0.8.0)

**Implemented in 0.8.3.** `checkStale()` renders in memory and compares with
`updateSection() === text`; stale file paths are returned and `render --check`
exits 1 with them. Nothing is written. Fresh files exit 0 silently.

## Inline views: `render --debug` output (0.8.0)

**Implemented in 0.8.3.** `renderAll` and `checkStale` take a `DebugSink`;
each view emits `<file>: view <name>\n  <sql>` (SQL indented, newlines
preserved). `buildProgram` now takes an optional `writeErr` callback so the
CLI routes it to stderr, and tests capture it directly.

## Doc dir pollution branches and loom working directory (0.8.0) 

**Implemented in 0.8.1.** `loomDir`, `gitBranch`, `databasePath` and
`ensureLoomDir` in `src/duckdb.ts`; tests in `test/duckdb-path.test.ts`.
Two details settled during implementation: a detached HEAD becomes
`detached/<sha12>` rather than a directory called `HEAD`, since every detached
checkout would otherwise share one projection; and the branch is cached per
repo root so the common path does not spawn `git` repeatedly.

In the current implementation a per branch `.loom.duckdb` is recreated in the 
design docs directory. If there are many branches this will pollute the design 
docs. Secondly loom needs somewhere to put cache files that persist with branches

propose a `.loom` directory in `$LOOM_DEFAULT_ROOT` that has the following structure

```
$LOOM_DEFAULT_ROOT/.loom/.gitignore
$LOOM_DEFAULT_ROOT/.loom/namespaces.ttl
$LOOM_DEFAULT_ROOT/.loom/other-branch-specific-file.yaml
$LOOM_DEFAULT_ROOT/.loom/db/main/loom.duckdb
$LOOM_DEFAULT_ROOT/.loom/db/feat/my-feature/loom.duckdb
$LOOM_DEFAULT_ROOT/.loom/db/bug/my-bugfix/loom.duckdb
```

`.loom/.gitignore` is a single line excluding the `db` subdirectory. The db
subdirectory allows a natural path syntax for git branches.

This still gives the developer the option of excluding the `.loom` subdirectory
from commits.

## URI scheme not RDF compliant (0.8.0)

**Implemented in 0.8.2 (the uris).** The curie form `issue:my-issue.md` is now
the only written form: `parseUri` accepts `scheme:path` with `#fragment`, and
the superseded `scheme://path` still parses but is flagged `legacy` and
`formatUri` never emits it, so anything that round-trips a uri migrates it.
The two-slash form was dropped because under RFC 3986 it means
`authority = first segment` (`issue://design/notes.md` addresses host `design`),
which was never what loom meant. The curie has no authority, so the whole path
is the path. Remaining from this issue: `%% @prefix` external prefixes, and the
`.ttl` export (see RDF export, below).

the current scheme where an issue is referenced as `issue:my-issue.md` and the
path is declared in a comment in the mermaid like this:

```
%% @path issue design/issues
```

This is pragmatic but misses out on a whole set of standards support from RDF turtle.
In turtle the same scheme would be represented as:

```
%% @base <file://path/to/repo/root> .
%% @prefix issue: <design/issues> .
```

and the iri for the issue would be `issue:my-issue.md`. The `@base` could be 
defined as repo root implicitly without breaking anything, and all relative
links should just work if the project is moved on disk.

If we continue the turtle analogy and we implicitly set `@base` in the context 
of source code to the prefix of the enclosing loom UML class:

```
function my_function() {
    // resolves issue:my-issue.md 
}
```

to:

```
function my_function() {
    // resolves <issue:my-issue.md>
}
```

which would be directly interpretable as an RDF relationship, the nature of 
which is correctly scoped to the `resolves` relationship declared on `src` in 
the UML. In theory the UML defines RDF domain and ranges for this relationship.

The relation is written as a bare term, not as a fragment. Which IRI it expands
to is a function of the `@base` in force when the comment is interpreted, and
that choice can be made later (see RDF export, below). Writing `#resolves`
would bake a fragment-on-the-instance-namespace expansion into every source
file and foreclose the alternatives for no gain, since the enclosing class
already supplies the scope that the `#` was there to suggest.

With this scheme it would make a lot of sense to extract the prefix declarations
into a `.ttl` (text/turtle) file in a loom directory (see above) that travels 
with the git branch, and potentially could be used as namespace to path mapping.

The additional benefit that this would bring is allow us to link to resources
outside of the loom project, such as github issues. so a prefix defined in mermaid
as `%% @prefix issue: <https://github.com/my-org/my-project/issues>` would allow
use to reference the sixth github issue in this project as `issue:6`. In this
case the `issue` would need to be modelled under `resource` as an entity
that can be linked to but not from. entities under `src` root can be linked to 
and from but can't have attributes, and that is the fundamental difference 
between the 3 things. (N.B. if we really wanted to we could theoretically extend the turtle
in source code analagy to allow attributes as turtle RDF comments in code but there is no use case
for this at the moment.)

This would impact both [./source-linkage.md] and [./complex-path-examples.md] and
[./implementation-plan.md] would be stale.

Migration is cheap at the moment as no adoption of in source links yet. Will be
very expensive in the future.

Rendering loom style URIs in this scheme is simply a question of resolving the 
relative path from one URI (the file path) to another using RDF standard 
patterns. Markdown links to URI transforms is a defined standard, that we have 
nearly implemented anyway.

Future possibilities this enables:
* Export loom graph as turtle
* Export loom schema as RDFS
* SPARQL query support 

### Resolved during design discussion

* **Trailing delimiter required.** CURIE expansion is string concatenation, not
  path join, so `%% @prefix issue: <design/issues>` would expand
  `issue:my-issue.md` to `design/issuesmy-issue.md`. Prefix declarations must
  end in `/` or `#`, enforced as a hard error on the declaration.
* **Inheritance stays.** The model is the source of truth and UML inheritance is
  part of the model, so `@prefix` keeps the inheritance-driven defaults that
  `@path` has today.
* **The `.ttl` is export-only**, regenerated rather than edited, but checked in
  so it travels with the branch — otherwise a branch switch leaves the namespace
  mapping inconsistent with the model.
* **Relation terms are scoped by the subject's class.** `issue --> src : resolves`
  is a different property from `src --> test-case : resolves`. A bare `resolves`
  in a source file resolves against the enclosing file's loom class. Resolution
  walks the UML ancestry from that class upward, first declaration wins;
  a subclass may override a parent's relation, mirroring UML. No declaration
  anywhere in the ancestry is a hard error.
* **Relations are written as bare terms, never as fragments.** Source comments
  carry `// implements <...>`, not `// #implements <...>`. The subject's class
  already scopes the term, so the `#` adds nothing and would commit every source
  file to one particular expansion. Leaving the term bare keeps the expansion a
  decision for the interpreter, settable via `@base` at export time.
* **The triple store stays non-conformant for relations.** The `relation` column
  keeps the bare label. The namespaced form is a pure function of the subject's
  class plus the label, both already in the store, so it can be computed at
  export time with no migration. Storing the expanded form would force every
  user query to spell out the namespace to match.

## RDF export (future)

Deferred until there is a reason to emit turtle. Collects the decisions that
only matter at export time.

**Relation term namespace.** Relations are stored and written as bare terms
scoped by the subject's class, so the expansion is entirely an export-time
choice. Candidates:

* a dedicated relation prefix — `rel:issue` giving `rel:issue#resolves`
* the model file as the term namespace — `design/document-model.mmd#issue.resolves`
* the instance namespace itself — `design/issues/#resolves`

The last is the most direct reading of "scoped by the subject's class", but it
puts vocabulary and data in one namespace, and a turtle consumer normally tells
the two apart by namespace. Since nothing in the corpus or the triple store
records the expansion, any of these can be chosen when the exporter is written.

**Multiple ranges intersect in RDFS.** If one class declares the same relation
label to two different target classes, emitting `rdfs:range` twice means "a
member of both", which is a contradiction rather than the intended union. The
exporter must emit a union class or omit the range.

