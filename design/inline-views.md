# Inline views

Current as of 0.8.8 (implemented in 0.8.0–0.8.4).

## 1. What they are

An inline view is a live query result rendered into a markdown file. The
query lives in the marker; the rendered result is written between the marker
and its `end` terminator. Re-running `loom render` refreshes the sections;
`loom render --check` fails a CI build when any are stale.

Views are **not** protected link blocks: `loom:links` blocks (backlinks,
indexes) are owned by `loom index`; view sections are owned by `loom render`.
Both can live in the same file.

## 2. Named views — the model

```
%% @view openIssues
%% SELECT uri, title FROM issue WHERE status = $status ORDER BY title
```

`%% @view <name>` starts a definition; `%%` continuation lines carry the SQL.
Duplicate names are `model/duplicate-view`. Parameters are `$name` tokens,
substituted with escaped SQL values at render time.

## 3. Inline views — in the document

```markdown
<!-- loom view: openIssues?status=open -->

<!-- loom view: openIssues end -->

<!-- loom view: SELECT subject, object FROM edge WHERE relation = 'blocks' -->

<!-- loom view: end -->
```

A marker is either a view name with optional query-string parameters
(`name?param=value&other=v2`) or a literal `SELECT`/`WITH` query. Comma
separation in a parameter (`status=open,closed`) expands to `IN ('open',
'closed')`; a single value to `= 'open'`. The section between the marker and its end marker is replaced on render. The
end marker is qualified — `<!-- loom view: <name> end -->` — so several views
can share a page without their terminators being confused with each other
(that is also what `loom render` writes; a bare `<!-- loom view: end -->` is
still accepted when scanning, for files written by hand or by older looms).
An absent end marker is fine while authoring: its section is empty, and
`loom render` inserts the rendered content and the qualified end marker right
after the opener — prose below the marker is never touched.

## 4. Output rules

| Rows/Columns | Rendering |
|---|---|
| 0 rows or 0 columns | `_(no results)_` |
| 1 column | bullet list |
| 2–4 columns | markdown table |
| 5+ columns | compact list, `**col:** value` per field |
| unknown view name | `_Unknown view "name"._` (inline italics) |
| query error | `_Query failed: <message>_` |

**Uri cells become links.** A cell whose value parses as a design uri and
resolves to a file renders as `[title](relative-path)`; edge tables (subject,
object) link with the uri as label. External-prefix uris link to the expanded
URL. A uri that does not resolve stays plain text — a visible fact, not a
silently broken link.

## 5. Commands

- `loom render` — expand markers in the repository and write only changed Markdown files.
  Git checks the candidate paths in one batch from a temporary file, using
  NUL separators to preserve filenames containing whitespace.
- `loom render --check` — no-write dry run for CI: exit 0 when everything is
  fresh, exit 1 naming stale repo-relative files.
- `loom render --debug` — also emit to stderr, per view:
  `<file>: view <name>` then the resolved SQL indented two spaces (inline
  markers are named `(inline)`). Render refreshes the projection from changed
  and deleted documents. It builds the projection when missing and rebuilds
  when its version or model signature changes.

## 6. Includes — transcluding a document

```markdown
<!-- loom include: slide:intro.md h3 -->
...transcluded prose...
<!-- loom include: slide:intro.md h3 end -->
```

`<uri> [h1..h6] [notitle]`. The uri names an instance; an unknown option word
is `render/bad-include` and a uri with no instance file is
`render/missing-include` — nothing is written either way.

**Headings.** With no level the prose is transcluded verbatim. With `h<n>`:
`notitle` shifts every heading so the shallowest sits at `n`, and without it
the document's `title` is emitted as an `h<n>` and its own headings shift to
`n+1`. Relative depth and gaps survive the shift. A document with no title
degrades to the `notitle` form. Past six hashes CommonMark stops seeing a
heading and renders the line as text; that is the behaviour, not an error —
the author chose the level and a stray paragraph is a visible symptom.
Setext headings (`===` underlines) are not supported. Headings inside fenced
code in the transcluded prose are left alone.

**Links.** The projection stores prose in curie form, so transcluded links are
rewritten relative to the *including* file. The same conversion that puts uri
cells in views on the page.

Each render shares one DuckDB connection for includes and fetches each source
body once. Heading adjustments and link rebasing use the options and path at
each include site.

## 7. One level, from the projection

Includes and views expand from the database, never from another file's
rendered output: `body` holds source prose with every marker section
collapsed back to its bare opener (`collapseSections`, `src/markers.ts`). A
transcluded marker therefore arrives as text, and the scanner skips markers
nested inside another marker's section, so it stays text.

The consequence is deliberate: rendering A expands its include of B but not
B's include of C; rendering B expands C. One level per file per run, and
`render` is idempotent — a cycle cannot grow a file. A `depth` option is the
obvious stage 2.
