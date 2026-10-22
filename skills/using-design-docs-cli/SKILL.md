---
name: using-design-docs-cli
description: How to install, invoke, and use the design-docs CLI to inspect, validate, mutate, link, and query document graphs. Use whenever working in a project governed by design-docs, when creating or modifying design documents, linking source code to design instances, querying graph state via SQL, maintaining navigational indexes, or troubleshooting graph diagnostics.
---

# Using the Design-Docs CLI

`design-docs` treats Markdown files in a repository as typed instances in a graph governed by a Mermaid class diagram (`document-model.mmd`). This skill covers CLI installation, invocation rules, common operations, and error recovery.

## 1. Installation & Environment

### Project Installation
In projects with `design-docs` in `devDependencies`:
```bash
npm install
npx design-docs --help
```

### Global or Standalone Link
To build and use directly from the tool's source repository:
```bash
cd /path/to/design-docs
npm run build
npm link
# or run directly:
node /path/to/design-docs/dist/src/cli.js --help
```

### Language Parser Prefetch
`design-docs` uses Tree-Sitter grammars for code parsing and anchor resolution (TS, Python, R, Mermaid). On new environments or offline setups, run:
```bash
design-docs prefetch
```

## 2. Invocation Rules & Output Formats

### Global Options Placement
Global options **must precede** the subcommand name:
```bash
design-docs --json resolve issue://a.md     # Correct
design-docs resolve issue://a.md --json     # Error: unrecognized option
```

- `--json`: Output machine-readable JSON instead of human-friendly YAML.
- `--cwd <path>`: Run as if invoked from `<path>` (defaults to `process.cwd()`). Config discovery walks up looking for `.design-docs.yaml`.

### Output Contracts
Every command produces one of three shapes:
1. **Data** (exit 0): structured payload on stdout.
2. **Report** (exit 0 or 1): carries `{ ok: boolean, errors: n, warnings: m, diagnostics: [...] }`.
3. **Error** (exit 1 or 2): message on stderr when aborted before report assembly.

## 3. Core Commands & Workflows

### Validating the Graph
```bash
# Validate entire graph
design-docs validate

# Automatically repair unambiguous issues (stale link blocks, non-canonical URIs, git renames)
design-docs validate --fix

# Dry-run validation against a proposed model
design-docs validate --model proposed-model.mmd

# Check model definition syntax and invariants
design-docs model check
```

### Navigating & Inspecting Instances
```bash
# Resolve URI to disk path or source line number
design-docs resolve issue://fix-login.md
design-docs resolve src://src/auth.ts#login

# Inspect instance YAML frontmatter + markdown body
design-docs show issue://fix-login.md

# Hierarchical directory and symbol exploration (ls)
design-docs ls issue://                       # List all instances of class 'issue'
design-docs ls src://src/                     # List files in source directory
design-docs ls src://src/auth.ts              # List linkable symbols/anchors in file
design-docs ls src://src/auth.ts --kind Method # Filter symbols by kind

# Locate which symbol encloses a specific line in source
design-docs locate src://src/auth.ts --line 42

# Find which design documents link to a given source symbol
design-docs refs src://src/auth.ts#login

# Semantic similarity search across markdown bodies
design-docs similar "authentication token expiration" --limit 5
design-docs similar issue://fix-login.md
```

### Creating & Mutating Documents

All mutations validate the whole graph in memory before writing anything to disk.

#### Single-Operation Sugar
```bash
# Create an instance
design-docs create issue://new-feature.md "title: Support Passkeys" "status: open"

# Update scalar attributes or relations
design-docs set issue://new-feature.md status in_progress

# Link two design documents
design-docs link issue://new-feature.md blocks issue://old-feature.md

# Link source code to a document (writes comment inside function body!)
design-docs link src://src/auth.ts#login implements issue://new-feature.md
# Or link source code targeting an anchor from a line number:
design-docs link src://src/auth.ts --line 42 implements issue://new-feature.md

# Remove link
design-docs unlink issue://new-feature.md blocks issue://old-feature.md
design-docs unlink src://src/auth.ts#login implements issue://new-feature.md

# Rename an instance (updates all inbound URIs across the corpus)
design-docs rename issue://old-name.md issue://new-name.md

# Delete an instance (fails if inbound relations still exist)
design-docs delete issue://old-name.md
```

#### Batch Mutations (Changesets)
For multi-step or multi-file mutations:
```bash
# Preview diff without touching disk
design-docs apply changes.yaml --dry-run

# Commit changeset atomically
design-docs apply changes.yaml
```

*Example `changes.yaml`:*
```yaml
- op: create
  uri: issue://passkeys.md
  data:
    title: Support Passkeys
    status: open
- op: link
  from: issue://passkeys.md
  rel: relates-to
  to: issue://auth.md
```

### Navigational Indexes
Human-navigable indexes are generated into markdown files declaring `class: index`.
```bash
# Rebuild all index link blocks
design-docs index

# Verify indexes in CI (exits 1 if any index is stale)
design-docs index --check
```

### Querying with SQL (DuckDB)
The graph and relations project into DuckDB:
```bash
# Rebuild the projection database (.design-docs.duckdb)
design-docs rebuild

# Query concrete class tables or edge triples
design-docs query "SELECT uri, title, status FROM issue WHERE status = 'open'"
design-docs query "SELECT subject, relation, object FROM edge WHERE relation = 'blocks'"
```

## 4. Troubleshooting Common Diagnostics

| Diagnostic Code | Meaning | Recovery / Fix |
|---|---|---|
| `graph/stale-links` | Protected link block in markdown is out of sync with frontmatter. | Run `design-docs validate --fix`. |
| `graph/non-canonical-uri` | A URI has unnecessary path segments or wrong format. | Run `design-docs validate --fix`. |
| `graph/renamed-symbol` | Source symbol anchor broken, but matches a renamed symbol since `HEAD`. | Run `design-docs validate --fix` to rewrite. |
| `graph/missing-symbol` | Source anchor `#symbol` not found in file. | Use `design-docs ls src://path` or suggestion in diagnostic `fix` to correct name. |
| `graph/missing-source-file` | Target file in `src://` URI does not exist. | Check file path or remove link. |
| `graph/dangling-link` | Referenced design URI does not exist. | Create missing document or remove edge. |
| `graph/inbound-cardinality` | A required relation is missing or exceeds cardinality (e.g. `1`, `0..1`). | Adjust edges with `link` or `unlink`. |
| `source/ambiguous-anchor` | Symbol name appears multiple times in file (e.g. nested scope or overload). | Use fully-qualified anchor path (e.g. `Class.method` or `func(int,string)`). |
| `source/not-annotatable` | Attempted to link source declaration that lacks a block body (e.g. interface signature). | Attach comment to the enclosing class or linking document instead. |
| `source/verification-failed` | Splicing comment into source caused syntax error or attached to wrong AST node. | Check source file syntax; annotate manually if needed. |
