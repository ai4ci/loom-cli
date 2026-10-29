# Open Issues

## Inline views: URI values rendered as plain text

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

## Inline views: `render --check` CI mode

**File:** `src/render.ts` — function `renderCommand()`

The `--check` flag is wired in `src/cli.ts` but the no-write path is not
implemented. Currently `render --check` renders and writes, then returns
`ok: true`. Expected behaviour: when `--check` is set, the function should
render in memory and compare against the file on disk — if any marker would
change, emit those paths as diagnostics and exit 1.

## Inline views: `render --debug` output

**File:** `src/render.ts`

The `--debug` flag is wired in `src/cli.ts` but no debug output is emitted.
Expected behaviour: when `--debug` is set, each rendered view's resolved SQL
should be written to stderr (prefixed with the file path and view name), so
users can inspect exactly what was executed.
