# Source code linkage

How design documents and source code point at each other: what in a source tree
can be addressed, how an address is written, where a reverse link physically
lives, and how both directions survive refactoring.

Companion to [implementation-plan.md](./implementation-plan.md) (phasing and
rationale) and [cli-interface.md](./cli-interface.md) (command surface). Scope
requirements §IA.9–11 and §CLI.10–11 are the source of truth for *what* is
required; this document settles *how*.

**Status.** §2 (the anchor model) and §4 (the annotation rule) are specified but
only partly built — see §8 for exactly what exists today. Everything measured in
this document was measured against `@xberg-io/tree-sitter-language-pack`
v1.22.1.

## 1. Why this needs its own document

Source code has no YAML header, so it cannot carry structured data, and there is
no 1:1 relationship between a source file and a design entity. A single file
holds many linkable things at several levels of nesting, and which of them are
worth addressing is a judgement call that varies by language. Left undefined,
"link to this function" means something slightly different in every language the
tool touches.

Three questions follow, and they are really one question:

1. Given a path, what can be linked to? (`ls`)
2. Given a line, what is the address of the thing containing it? (`locate`)
3. When the code is refactored, which links broke and what did they become?

All three reduce to: **what, precisely, is a linkable thing in source code?**

## 2. The anchor model

### 2.1 Linkable anchors

The language pack's `process()` already normalises each language's concrete
syntax tree into a fixed, language-agnostic vocabulary of `StructureKind`:
`Function`, `Method`, `Class`, `Struct`, `Interface`, `Enum`, `Trait`, `Impl`,
`Module`, `Namespace`, and `Other`. Imports, constants and type aliases are
excluded upstream. So the "which nodes matter" problem does not need solving per
language; it needs an allowlist over a fixed set.

> A **linkable anchor** is a named structural item whose kind is in the
> configured anchor-kind set, addressed by its dotted path from the file root.

```yaml
# .design-docs.yaml
src:
  anchorKinds: [Function, Method, Class, Struct, Interface, Enum, Trait]
  transparentKinds: [Impl, Module, Namespace]
```

`transparentKinds` are not addressable themselves, but their children still
contribute to the tree. This exists because of Rust: `impl Draw for Sq` is
reported with `name: "Draw"`, which collides with the trait `Draw` and would
make `Sq`'s methods reachable only as `Draw.draw`. Treating `Impl` as
transparent skips the redundant level rather than hiding what is inside it.

Making the policy declarative rather than hard-coded means a project can widen
or narrow it, and `ls` (§3) is the authoritative answer to "what can I link
to": if `ls` does not list it, it is not linkable.

### 2.2 Uniqueness is the invariant

> An anchor must resolve to exactly one linkable node.

That is the whole rule. `src://app.ts#MyClass.run` resolves when there is one
`run`. When there are several it is an error — `source/ambiguous-anchor` — whose
`fix` field lists the qualified candidates.

Ambiguity is an error rather than a warning because a single address resolving
to several things is harder to handle, at every layer, than an address that
simply fails. This also fixes a latent fault in the current implementation,
where a bare name falls back to the first match silently: with
`class Alpha { run() }` and `class Beta { run() }`, `#run` resolves to
`Alpha.run` with no indication that the choice was arbitrary.

### 2.3 Overloads

Overloaded methods are disambiguated by a normalised parameter type list:

```
src://MyClass.java#MyClass.run(String,int)
```

The qualified form is accepted whenever it is needed, and only when it is
needed — see §2.4.

The raw `signature` field reported by the language pack is **not** usable for
this. Java gives `"public void run(String name)"`: modifiers, return type and
parameter *names*, none of which are part of method identity. An anchor built on
it would break when a parameter is renamed. The type list is therefore extracted
from the syntax tree and normalised:

1. Read each parameter's `type` field.
2. Strip whitespace, and the leading `:` that TypeScript includes.
3. Reduce every dotted path to its last segment: `java.util.List` → `List`.
4. Substitute `_` where no type is available.

So `run(String name, int... b)` is addressed as `run(String,int[])`.

**Generic arguments are kept, not erased.** Erasure is tempting and is correct
for Java — the language itself forbids overloads differing only in type
arguments, since they share an erasure — but C# reifies generics, so
`Go(List<string>)` and `Go(List<int>)` legitimately coexist and erasure would
wrongly collide them. Keeping generics is correct in both.

Extraction is viable because the `type` field convention holds broadly. Measured:

| Language | Parameter container | Type field |
|---|---|---|
| Java | `formal_parameters` | `"String"`; `spread_parameter` yields nothing |
| C# | `parameter_list` | `"string"` |
| TypeScript | `formal_parameters` | `": string"` — leading colon stripped |
| Python | `parameters` | `"str"`; untyped parameters yield nothing |
| Go | `parameter_list` | `"string"` |
| Rust | `parameters` | `"String"` |

The container is found by a zero-config heuristic (first descendant whose node
kind matches `/param/`), which worked for all six. Ship the heuristic *with* a
per-language override table: an undeclared heuristic across 372 grammars will
misfire somewhere, and `ls` is the tool that shows what was derived.

Because Java varargs and untyped Python parameters yield no type, the `_`
placeholder is not a rare edge case — `run(_)` will appear in real anchors.

### 2.4 Anchors canonicalise to their shortest unambiguous form

`validate --fix` reduces any anchor to the shortest spelling that still resolves
uniquely, mirroring the rule that URIs canonicalise to their most compact scheme
(cli-interface §2.4, implementation-plan §2.4). Write whatever you know; the
tool normalises. A redundant type qualifier on a non-overloaded method is
stripped; a bare name on an overloaded one is an error listing the qualified
alternatives.

### 2.5 Language coverage is uneven

The pack normalises *kinds* reliably. It does **not** guarantee *coverage*.
Measured gaps:

| Language | Gap |
|---|---|
| C++ | `class Widget { void draw(int); }` reports `name: undefined` and no methods. **Unusable** — no linkage in either direction. |
| Go | `type Point struct` is not reported at all. Functions and methods are. |
| TypeScript | Interface *members* are not reported. `Shape` is addressable, `Shape.area` is not. |
| Rust | Trait method *signatures* are not reported; only default implementations with bodies. |
| R | Every function is reported as `name: "function"` — unusable. Needs an adapter: §2.6. |

These are coverage facts, not policy, and they constrain both directions. Check
a language before planning a workflow that depends on member-level linkage.

### 2.6 Per-language adapters

`process()` is the default source of anchors but it is not universal. Where its
output is unusable, a per-language adapter derives anchors from the syntax tree
instead. An adapter must supply, for every anchor:

| Field | Meaning |
|---|---|
| `name` | The declared name |
| `fullName` | Dotted path from the file root, including enclosing anchors |
| `span` | The whole declaration |
| `bodySpan` | The block, or absent when the declaration has none (§4.4) |

`bodySpan` is not optional in practice: without it every anchor the adapter
produces is un-annotatable, because §4.4 keys on exactly that.

**R is the worked example, and currently the only one.** `process()` reports
every R function as `name: "function"` — the keyword rather than the binding —
and lambdas as `name: "\\"`. Nesting and body spans are correct; only the names
are unusable.

What the R adapter recognises:

| Form | Anchor |
|---|---|
| `f <- function(x) {…}` | `f` |
| `f = function(x) {…}` | `f` |
| `f <- \(x) {…}` | `f` — lambdas still parse as `function_definition` |
| `g <- function()…` nested inside `f` | `f.g` |
| `C <- R6Class("C", public = list(m = function() {…}))` | `C.m` |
| `R <- new_class("R", validator = function(self) {…})` | `R.validator` |

The last two are one rule: **a call argument whose value is a function and whose
name is an identifier is an anchor, qualified by the nearest enclosing
assignment's identifier.** S7's `validator` and `constructor` fall out of the R6
rule for free, and are structurally simpler than R6 — a direct argument of
`new_class()` rather than one nested inside a `list()`.

What it deliberately does not recognise is registration through a function call,
where the name is an argument value rather than a binding:

```r
setMethod("area", "Circle", function(shape) { ... })   # S4
method(print, Range) <- function(x, ...) { ... }       # S7
```

Capturing these means pattern-matching on a convention rather than on syntax,
and inferring a name from a string literal or a nested call. Out of scope.

The assignment rule is therefore **restricted to an identifier left-hand side**.
Without that restriction S7's `method(print, Range) <- function(…)` is matched
accidentally — its right-hand side *is* a `function_definition` — and named
`method(print, Range)`, which collides with the overload qualifier of §2.3:
`#method(print, Range)` is indistinguishable from a method `method` qualified by
parameter types `print` and `Range`. An anchor that cannot be spelled
unambiguously is worse than no anchor.

A reverse link written inside an unrecognised function body still works. With no
enclosing anchor it attaches to the file (§4.1) — coarse, but correct.

One R idiom reduces coverage further: `f <- function(x) x + 1` has no block, so
it is not annotatable under §4.4. That is the same exclusion as `int X => 1` in
C#, but one-liners are far more common in R than expression-bodied members are
elsewhere.

## 3. Discovery

### `ls` — what can be linked to

The URI space is one hierarchy in which `#anchor` is simply a deeper level than
the path, so `ls` is directory descent and needs no mode switch:

```
design-docs ls issue://                  # instances of a class
design-docs ls src://                    # directories and files
design-docs ls src://pkg/app.ts          # linkable anchors in the file
design-docs ls src://pkg/app.ts#Service  # anchors nested in that anchor
```

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

`--depth <n>` descends further, `--kind <k,...>` narrows, and
`--linked` / `--unlinked` filter by whether any design document already points
there. That last pair answers the question that motivates the command: *what in
this file is not yet covered by any issue?* — answerable directly from the edge
table.

### `locate` — the address of a line

```
design-docs locate src://app.ts --line 42
```

```yaml
anchor:
  uri: src://app.ts#Service.run     # innermost linkable ancestor
  kind: Method
  span: { startLine: 40, endLine: 55 }
ancestors:
  - { uri: "src://app.ts#Service", kind: Class }
  - { uri: "src://app.ts", kind: File }
```

Granularity is decided by the anchor-kind policy: return the innermost ancestor
whose kind is linkable, and hand back the chain so a caller wanting something
coarser can take it. A line in an import block or a top-level statement has no
linkable ancestor — return `anchor: null` with the file as the only target,
which is honest rather than inventing a node.

A line number is an **input convenience only and is never stored**. There is no
`#L42` anchor form: a line does not say what granularity it means, so a link
whose target depends on where a cursor happened to sit is not worth having.

## 4. Where a reverse link lives

> A reverse link lives inside the body of the element it refers to, after any
> leading comments, before the first statement. It refers to the enclosing
> element and nothing else.

```java
public void run(String name) {
    // implements: issue://auth-flow.md
    ...
}
```

One rule, applied everywhere, in both directions.

### 4.1 Reading

A comment attaches to the innermost **declaration** that lexically contains it;
otherwise to the file. Pure containment — no lookahead, no line counting.

Containment is tested against the whole declaration rather than against its
block, because no node spans "body including leading comments" in every
language. In Python a comment on a function's first line is a *sibling* of the
`block` node, not a child of it, so a block-based test would hand a link written
in exactly the canonical position to the enclosing class instead. Measured:

```
function_definition [13-57]
  :           [28-29]
  comment     [38-44]   ← the link, outside the block
  block       [53-57]
```

The block still decides where a link is *written* (§4.2) and whether a
declaration can be annotated at all (§4.4) — it is just not what decides
ownership.

Decorators, annotations, Javadoc and docstrings sit outside the declaration or
before its name, so none of them can interfere. A comment in a class body but
outside any method therefore attaches to the class, which is the rule working
correctly rather than an edge case.

### 4.2 Writing

Resolve the anchor, take its body, walk the body's named children skipping
comments, and insert immediately before the first non-comment child at that
child's indentation. If the body contains no statements, insert after the
opening delimiter.

Defining it by *first non-comment child* rather than by byte offset is
deliberate: a body span starts at the opening brace in C-like languages but at
the first statement in Python, so inserting "at body start" would land before
the `{`. Walking the children handles both uniformly.

Inserting ahead of a Python docstring is safe. Verified by execution: a comment
preceding the string literal leaves `__doc__` intact, because comments never
become statements.

### 4.3 File-level links

An anchor-less `src://app.ts` treats the file as the enclosing block and the
same algorithm applies — after the shebang and licence header, before the first
declaration. This is not a special case; it is the one rule with the file as the
enclosing element.

### 4.4 What cannot be annotated

No body means nowhere to put the comment, so the rule is self-enforcing.
Measured:

| Declaration | Body |
|---|---|
| `void real() { }` | present |
| `void decl();` (interface) | **none** |
| `abstract void abs();` | **none** |
| `fn sig(&self);` (trait) | not reported at all |

Interface and abstract declarations, trait signatures and expression-bodied
members (`int X => 1`, `fun f() = 1`) get `source/not-annotatable`, with two honest
alternatives: annotate the enclosing type, which does have a body, or use a
forward link from the design document. Nothing becomes unreachable; it uses the
other direction.

Empty bodies (`fn draw(&self) {}`) *are* annotated, which expands them across
lines. Still comments and whitespace only, but a visible formatting change that
some projects' formatters will want to undo.

### 4.5 No guard-rail for misplaced hand-written links

Under this rule a comment written above a method — the conventional spot —
attaches to the enclosing class, not the method. The tool writes these comments,
so hand-authoring is the exception, and a warning on every comment that sits
above a declaration would mostly fire on correct class-level links and confuse an
agent into "fixing" them. Documentation is the mitigation; there is no
diagnostic.

### 4.6 Writing is a changeset op

Annotation goes through the existing mutation pipeline rather than a parallel
one, inheriting validate-then-write, atomic staging, `--dry-run` and the unified
diff:

```yaml
ops:
  - { op: link,   from: "src://app.ts#Service.run",  rel: implements, to: "issue://auth.md" }
  - { op: link,   from: "src://app.ts#Service.stop", rel: implements, to: "issue://auth.md" }
  - { op: unlink, from: "src://old.ts#Legacy.run",   rel: implements, to: "issue://auth.md" }
```

`link` and `unlink` **dispatch on the subject's scheme**: a design instance
writes YAML, a `src://` uri writes a comment. The shape is already
subject–relation–object and the model already constrains which relations are
legal in which direction, so no new verb is needed. N ops in one changeset is
the batch interface.

**Edit ordering.** One parse per file; resolve every insertion point against the
original buffer; sort descending by offset with a deterministic tie-break
(relation, then target uri); splice in that order; write once. Descending order
means earlier edits cannot move the offsets of pending ones. N links into one
file cost one parse and one write.

**Idempotence.** Skip the insert when a comment with the same relation and target
already attaches to that anchor. Without this, re-applying a changeset
accumulates duplicates, and `link` on the design side is already idempotent.

**Post-write verification.** After splicing, re-parse the file and assert two
things: no new `ERROR` nodes relative to the pre-edit parse, and the new comment
attaches to the intended anchor. If either fails, abort the whole changeset and
write nothing. One extra parse per modified file, and it turns "probably fine"
into verified — worth having precisely because source code gets compiled.

## 5. Direction, and which to use

A reverse-link relation is a **different relation** from its forward
counterpart, declared in the opposite direction in the model:

```mermaid
issue "1" --> "0..*" src : implemented-by     %% forward: lives in issue yaml
src "0..*" --> "0..*" issue : implements      %% reverse: lives in a comment
```

Edges are stored once, on the source side, with no inverse names
(implementation-plan §1.6) — so these are two independent edges, not two views
of one. Choosing reverse over forward changes what is in the graph, not merely
where it is written. A project wanting both directions queryable must model
both, and validation treats them independently.

The choice matters because the two differ in robustness:

| Representation | Survives rename | Survives move | Visible from design side |
|---|---|---|---|
| `src://path#Symbol` | no | no | yes |
| Fingerprinted anchor (§6.3) | yes | yes | yes |
| `// implements: issue://x.md` | **yes** | **yes** | only after a scan |

A comment moves with the code it sits in, so it survives both rename and
reordering, and inside an overloaded method it is unambiguous by construction —
no signature qualifier needed.

**Forward links are ergonomic; reverse links are robust.** For code that churns,
and for overload sets in languages like Java, prefer the comment. For stable,
uniquely-named entry points the forward anchor reads better from the design
side and needs no scan.

## 6. Refactoring drift

### 6.1 Candidate suggestion

When an anchor fails to resolve, enumerate the linkable anchors in that file,
rank them by name similarity and kind match, and put the best in the
diagnostic's `fix` field. Turns a dead link into a one-step repair, and reuses
the enumeration `ls` needs anyway.

### 6.2 Rename inference from git

On a failed anchor, parse the file at `HEAD` as well as on disk. If a symbol
with the old name existed before, and one with the same kind and a near-identical
body exists now under a different name, that is a rename with high confidence:
report it as auto-fixable and let `--fix` rewrite the anchor.

This is the tier that actually catches refactors. Cost is one `git show HEAD:<path>`
and a second parse per broken anchor — paid only when something is already
wrong. The tool already assumes a git repository.

### 6.3 Body fingerprints — deferred

Storing a hash of each linked symbol's normalised body at link time would make a
rename near-certain to detect: name gone, fingerprint matched. The catch is that
a fingerprint only helps if captured *before* the refactor, so it must survive
`rebuild`, so it must be committed — which rubs against §1.1, where files are the
source of truth and everything else is derived.

The resolution, if this is ever built: one committed sidecar at
`<designRoot>/.src-anchors.yaml` mapping edge to fingerprint, rather than
scattering tool-maintained data through instance YAML. There is precedent — the
protected link block is also committed derived data — but it is real complexity
for a marginal gain over §6.2. Defer until §6.2 demonstrably misses things.

### 6.4 CI boundary

`validate` in a pre-commit hook or CI job catches drift at the boundary. This is
configuration, not code.

## 7. Configuration and diagnostics

```yaml
src:
  roots: [src, R]
  languages: [r, typescript, python]
  anchorKinds: [Function, Method, Class, Struct, Interface, Enum, Trait]
  transparentKinds: [Impl, Module, Namespace]
  commentToken:                      # writing only; reading uses a permissive regex
    java: "//"
    python: "#"
    r: "#"
    sql: "--"
  annotateExclude: ["**/generated/**", "**/vendor/**"]
```

`annotateExclude` matters more than it looks: annotating generated or vendored
source produces links that vanish on the next regeneration.

New diagnostic codes introduced by this document:

| Code | Meaning |
|---|---|
| `source/ambiguous-anchor` | Resolves to more than one node. `fix` lists qualified candidates. |
| `source/not-annotatable` | Target has no body, so a reverse link cannot be placed in it. |
| `source/unsupported-language` | No usable structure for this language — see §2.5. |
| `source/verification-failed` | Post-write re-parse found new errors or wrong attachment; changeset aborted. |

## 8. Built versus specified

| Capability | State |
|---|---|
| Forward anchor resolution, dotted path | **Built** |
| Reverse link scanning | **Built** |
| Anchor-kind policy, transparent kinds | **Built**, configurable under `source:` |
| Uniqueness as a hard error | **Built** |
| Overload qualification | **Built** |
| R adapter: bodySpan, nesting, R6/S7 | **Built** |
| Drift tier §6.1 (candidate suggestion) | **Built** |
| Broken anchor detection (`graph/missing-symbol`) | **Built**, detection only |
| `refs` reverse lookup | **Built** |
| `ls`, `locate` | **Built** |
| Annotation writing (`link` on a `src://` subject) | Specified |
| Drift tier §6.2 (git rename inference) | Specified |
| Body fingerprints §6.3 | Deferred |

The R adapter now carries `braced_expression` through as `bodySpan`, names
nested functions by their enclosing scope, recognises R6 and S7
argument-defined functions, and matches only an identifier left-hand side so
`method(…) <- function(…)` no longer yields a colliding name.

The attribution rule in §4.1 replaced a ±2-line lookahead, under which a comment
above a method attached to that method; it now attaches to the enclosing class.
`test/source.test.ts` asserted the old behaviour and was removed, its coverage
subsumed by `test/anchors.test.ts` and `test/anchors-r.test.ts`.

## 9. Open items

- **Indentation unit for empty bodies.** Inserting into `fn f() {}` needs an
  indentation width with no sibling to copy from. Detect the file's prevailing
  indent, or take it from config.
- **Per-language parameter override table.** The `/param/` heuristic worked on
  six languages; the shape of the override entry is undefined until one fails.
- **`Other` structure kinds.** Currently excluded wholesale. Some languages may
  put genuinely linkable constructs there; no evidence either way yet.
