# Open Issues

##  0.8.0

## Inline views: URI values rendered as plain text  (0.8.0)

**File:** `src/render.ts` — function `renderView()`

When a `%% @view` SQL query returns a column containing URIs (e.g.
`issue://my-task.md`), the cell value is stringified as plain text.
It should be rendered as a relative markdown link — `[title](relative/path.md)` —
consistent with how `loom index` renders links in protected link blocks.

The building blocks exist:
- `relativeLink()` in `src/graph.ts` — converts a URI to a repo-relative path
- `parseUri()` in `src/uri.ts` — detects URI-lookalike strings and extracts scheme/path
- `titleOf()` in `src/graph.ts` — resolves a URI to its document title

The `renderView()` function's output in `src/render.ts` needs a post-processing
step (or per-cell check) that runs values through `parseUri()` and, when a match
is found, replaces the plain text with a markdown link.

**Related:** the output rules in `skills/using-loom-cli/SKILL.md` (under "Output rules"
table) would need a note that URIs are rendered as links.

## Inline views: `render --check` CI mode (0.8.0)

**File:** `src/render.ts` — function `renderCommand()`

The `--check` flag is wired in `src/cli.ts` but the no-write path is not
implemented. Currently `render --check` renders and writes, then returns
`ok: true`. Expected behaviour: when `--check` is set, the function should
render in memory and compare against the file on disk — if any marker would
change, emit those paths as diagnostics and exit 1.

## Inline views: `render --debug` output (0.8.0)

**File:** `src/render.ts`

The `--debug` flag is wired in `src/cli.ts` but no debug output is emitted.
Expected behaviour: when `--debug` is set, each rendered view's resolved SQL
should be written to stderr (prefixed with the file path and view name), so
users can inspect exactly what was executed.

## Doc dir pollution branches and loom working directory (0.8.0)

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

the current scheme where an issue is referenced as `issue://my-issue.md` and the
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
    // resolves issue://my-issue.md 
}
```

to:

```
function my_function() {
    // #resolves <issue:my-issue.md>
}
```

which would be directly interpretable as an RDF relationship, the nature of 
which is correctly scoped to the `src:#resolves` relationship which is defined 
in the UML. In theory the UML defines RDF domain and ranges for this relationship.

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
  is a different property from `src --> test-case : resolves`. A bare `#resolves`
  in a source file resolves against the enclosing file's loom class. Resolution
  walks the UML ancestry from that class upward, first declaration wins;
  a subclass may override a parent's relation, mirroring UML. No declaration
  anywhere in the ancestry is a hard error.
* **The triple store stays non-conformant for relations.** The `relation` column
  keeps the bare label. The namespaced form is a pure function of the subject's
  class plus the label, both already in the store, so it can be computed at
  export time with no migration. Storing the expanded form would force every
  user query to spell out the namespace to match.

## RDF export (future)

Deferred until there is a reason to emit turtle. Collects the decisions that
only matter at export time.

**Relation term namespace.** Scoping relation terms by subject class means
`issue:#resolves` expands into the *instance* namespace (`design/issues/#resolves`),
putting vocabulary and data in one namespace. It resolves and nothing breaks
internally, but a turtle consumer normally tells vocabulary from data by
namespace. Options, decidable at export time because the stored data is
unaffected:

* a dedicated relation prefix — `rel:issue` giving `rel:issue#resolves`
* the model file as the term namespace — `design/document-model.mmd#issue.resolves`

**Multiple ranges intersect in RDFS.** If one class declares the same relation
label to two different target classes, emitting `rdfs:range` twice means "a
member of both", which is a contradiction rather than the intended union. The
exporter must emit a union class or omit the range.

