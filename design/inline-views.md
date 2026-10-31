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
An absent end marker is fine while authoring: the section then reaches the
next view marker (or the end of the file), and `loom render` inserts the
qualified end marker on its first run.

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

- `loom render` — expand every marker under the design root in place.
- `loom render --check` — no-write dry run for CI: exit 0 when everything is
  fresh, exit 1 naming stale repo-relative files.
- `loom render --debug` — also emit to stderr, per view:
  `<file>: view <name>` then the resolved SQL indented two spaces (inline
  markers are named `(inline)`). The database is rebuilt automatically when
  missing.
