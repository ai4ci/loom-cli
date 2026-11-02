# Source linkage

Current as of 0.8.8. Supersedes `legacy/source-linkage.md`.

## 1. Purpose

Documents claim code ("this issue is implemented by that function") and code
carries a visible reverse comment. Both directions are written by loom and
verified by `validate`, so links survive refactors instead of rotting.

A source address is a uri in the `src` family: `src:path/file.ts#symbol`,
where `#symbol` is a **structure anchor**, not a line number. Line numbers are
accepted as input (`link ... --line 42`) and immediately resolved to the
innermost enclosing anchor; they are never stored.

## 2. Anchor model

Anchors come from tree-sitter structure queries
(`@xberg-io/tree-sitter-language-pack`). The adapter in `src/source.ts` walks
the tree once and emits `Anchor {name, fullName, kind, line, span, bodySpan?,
params?}`:

- `fullName` is the dotted path from the file root (`Class.method`), so an
  address is unique without the class prefix when unambiguous.
- `bodySpan` is present only when the declaration has a block; an anchor
  without one cannot carry a reverse-link comment (`source/not-annotatable`).
- `params` (normalised parameter type list) is computed only when two anchors
  share a name — overloads are then addressed as `name(paramTypes)`.

### 2.1 Anchor policy

Which kinds are addressable is a policy:

| Policy | Default | Meaning |
|---|---|---|
| `anchorKinds` | `Function, Method, Class, Struct, Interface, Enum, Trait` | kinds that become anchors |
| `transparentKinds` | `Impl, Module, Namespace` | kinds whose children pass through to the parent level |

Defaults live in `src/source.ts` `DEFAULT_ANCHOR_POLICY`; a `.loom.yaml`
`source:` block can override either list. Uniqueness is an invariant: an
address resolving to several anchors is a hard error `source/ambiguous-anchor`
— an address that means several things is worse than one that fails.

### 2.2 Language coverage

`detectLang` maps file extensions via the language pack. Special cases:

- **R** — tree-sitter names every R function `function`, so anchors are
  derived from a dedicated adapter: assignment forms (`f <-`, `f =`),
  `R6Class("name")`, `new_class("name")`; identifiers on the left of an
  assignment only.
- Overload resolution by parameter type list: normalisation reduces dotted
  type paths to the last segment and strips whitespace; generics are kept
  (they reify in C#, for instance).

A language the pack does not know produces `source/unsupported-language`.

## 3. Discovery

- `loom ls src:` — directories and files under a root.
- `loom ls src:auth.ts` — linkable anchors in the file, with qualified
  names for overloads.
- `loom find src: --depth 2` — recursive walk; see `cli-interface.md` §3.
- `loom locate src:auth.ts --line 42` — the innermost anchor enclosing a
  line; what to link when you only know a line number.

## 4. Reverse links

### 4.1 Reading

A reverse link is a comment line of the shape:

```ts
// implements issue:a.md
```

`REVERSE_LINK_RE` accepts the comment tokens `//`, `#`, `--`, `/* */`, a bare
relation term, and a curie target. Attribution is **whole-declaration
containment**: the link belongs to the innermost declaration whose span
contains the comment line, which is robust to the comment moving within the
body.

Each source file is attributed to its **most-specific src-family class**:
every class inheriting from `src` declares a root, and the file belongs to
the class whose root is the longest prefix of its path. This matters when a
subclass refines a parent's territory — `coretest: <repo:packages/core/test/>`
under `src: <repo:packages/>` — so relations declared on the subclass (or its
parent) validate against the subclass, and the diagnostic names the owning
scheme rather than the broad ancestor.

### 4.2 Writing

`loom link src:auth.ts#login implements issue:a.md` inserts the comment as
the **first statement** inside the declaration's block (a file with no
annotatable declaration gets the link at file level, after the header). The
write is a changeset edit: ordering is stable, re-linking is idempotent, and
the file is re-parsed after writing to verify the anchor is still intact
(`source/verification-failed` when it is not — the write is rolled back).
Deletion (`unlink`) removes the comment cleanly.

Languages without a writable comment token for their context are recorded
`source/not-annotatable`.

## 5. Direction of edges

The edge lives **once**, in the document that semantically owns the
relationship. An `implements`/`implemented-by` pair is stored as one edge
with the subject determining where it is written (frontmatter for documents,
comment for code). The DuckDB `edge` table makes either direction queryable.

## 6. Drift

Code moves; documents must follow. `validate` checks every source address:

1. **Dead anchor** (`graph/missing-symbol`) — the anchor no longer exists.
   The diagnostic suggests the nearest anchor by name similarity (tier 1).
2. **Renamed symbol** (`graph/renamed-symbol`) — the old symbol is gone, but
   an anchor of the same kind with a near-identical body exists
   (`src/drift.ts` `inferRename`, comparing bodies at HEAD with a similarity
   threshold). `validate --fix` rewrites the uri everywhere.
3. **Renamed file** — git rename detection at HEAD resolves the path;
   `renamed-symbol` with the new path as `fix`.

Body fingerprints (a sidecar recording anchor bodies to detect content moves
across files) remain deferred; name similarity plus git rename inference
covers the common cases without state.

## 7. Configuration

`.loom.yaml` is optional. Its only source-linkage keys:

```yaml
designRoot: design        # normally discovered
source:
  anchorKinds: [...]      # default above
  transparentKinds: [...] # default above
```

`LOOM_DEFAULT_ROOT` overrides the discovered design root. There are no other
source-linkage environment variables.
