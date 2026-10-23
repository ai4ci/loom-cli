---
name: creating-a-loom-workflow
description: Meta-skill for designing, configuring, and deploying a loom system for a specific repository. Use when setting up loom in a new or existing codebase, authoring a Mermaid document model (`document-model.mmd`), configuring path annotations, setting up human-navigable index views, defining document lifecycle transition rules (e.g. issue states, review workflows), or generating a project-specific workflow skill.
---

# Creating a Loom Workflow

This meta-skill guides an agent through establishing a documentation architecture using `loom`, tailoring the schema, configuring the tooling, generating navigation, and codifying the repository's document lifecycle into a project-specific workflow skill.

## When to Use This Skill

- Setting up `loom` in a repository for the first time.
- Modeling design artefacts (ADRs, RFCs, Issues, Requirements, Test Plans, Services).
- Defining document lifecycle transition rules (e.g. `draft` -> `review` -> `accepted` -> `implemented`).
- Creating a companion project-specific workflow skill (e.g. `manage-architecture-docs`, `issue-lifecycle-workflow`) tailored to the repository's domain model.

---

## Step 1: Discover & Map Requirements

Determine the document classes and lifecycle needs:
1. **Document Types**: What kinds of artefacts exist? (e.g. `adr`, `issue`, `rfc`, `spec`, `testplan`).
2. **Relationships**: How do they connect?
   - Between documents: e.g. `issue` blocks `issue`, `adr` addresses `rfc`.
   - To source code: e.g. `issue` implemented-by `src`, `src` implements `spec`.
3. **Attributes & Value Types**: Required metadata (title, status, date, author, priority).
4. **Lifecycle & Transitions**: What are the valid states and transition rules for each class?
   - e.g. Can an `issue` transition to `closed` if its `blocks` relation points to an open issue?
   - Does an `adr` require an `accepted` status before code implements it?

---

## Step 2: Define the Mermaid Model (`document-model.mmd`)

Place the model at `$DESIGN_DOCS_ROOT/document-model.mmd` (typically `design/document-model.mmd`).

### Rules & Conventions
- **Instantiable Classes**: Concrete classes that become Markdown files.
- **Attributes**: One per line with visibility and type (e.g. `+string title`, `+IssueStatus status`).
  - Supported primitives: `string`, `int`, `float`, `bool`, `date`, `path`, `uri`.
  - Cardinality: default single; `[]` suffix for lists (e.g. `+string[] tags`).
- **Enumerations**: Label with `<<enumeration>>` and list allowable members.
- **Abstract Classes**: Label with `<<abstract>>` (not directly instantiated).
- **Inheritance**: Expressed with `<|--` (e.g. `document <|-- adr`).
- **Source Code Integration**: Use or subclass the reserved `src` class.
  - Subclasses of `src` define custom root directories or schemes (e.g. `src <|-- test`).
- **Relations**: Arrow `-->` with cardinality at both ends and relation label:
  ```mermaid
  classDiagram
      class IssueStatus {
          <<enumeration>>
          open
          in_progress
          resolved
          closed
      }

      class issue {
          +string title
          +IssueStatus status
          +date created
      }

      class adr {
          +string title
          +string status
          +date accepted_date
      }

      issue "0..*" --> "0..*" issue : blocks
      issue "0..*" --> "0..*" adr : relates-to
      issue "1" --> "0..*" src : implemented-by
      src "0..*" --> "0..*" issue : implements
  ```

Validate the model syntax:
```bash
loom model check
```

---

## Step 3: Zero Configuration & Model Placement

Loom operates without configuration files. It discovers `document-model.mmd` in the git repository:
- The parent directory of `document-model.mmd` becomes `$LOOM_DEFAULT_ROOT` (e.g. `docs` or `design`).
- Optional environment overrides:
  - `LOOM_DEFAULT_ROOT`: Specifies the root directory relative to repository root if multiple models exist.
  - `LOOM_DEFAULT_SRC_ROOT`: Defaults to `src`.
  - `LOOM_DEFAULT_RESOURCE_ROOT`: Defaults to `resource`.
  - `LOOM_ANCHOR_KINDS`: Comma-separated structure kinds for code anchors.

Class paths and directory mappings are declared directly in the model via `%% @path <class> <path>` directives.

Run initial validation to verify graph structure:
```bash
loom validate
```

---

## Step 4: Configure Navigational Index Views

Human readers navigate the corpus via Markdown links. Create index files under `designRoot` with `class: index` and a `view`.

### Filter View Example (`design/INDEX.md`)
```markdown
---
class: index
title: Project Index
view:
  class: issue
  where:
    status: open
  orderBy: created DESC
---

# Open Issues

<!-- loom:links start -->
<!-- loom:links end -->
```

### SQL Query View Example (`design/adrs/INDEX.md`)
```markdown
---
class: index
title: Architecture Decision Records
view:
  query: "SELECT uri, title FROM adr ORDER BY accepted_date DESC"
---

# Architecture Decisions

<!-- loom:links start -->
<!-- loom:links end -->
```

Generate the link blocks:
```bash
loom index
```

---

## Step 5: Codify the Lifecycle & Transition Rules

Identify state machines and invariants that agents or contributors must respect when modifying documents.

For example, for an Issue Tracker:
1. **Creation**:
   - Must specify `title` and initial `status: open`.
   - Filename slug matches title (e.g. `issue://fix-token-refresh.md`).
2. **Transition: `open` -> `in_progress`**:
   - Permitted if no unresolved blocking issues (`blocks`).
   - Agent links relevant source files or branches.
3. **Transition: `in_progress` -> `resolved`**:
   - Must have at least one `implemented-by` or `implements` relation pointing to source code.
   - All tests passing.
4. **Transition: `resolved` -> `closed`**:
   - Final review or verification completed.

---

## Step 6: Generate the Project-Specific Workflow Skill

To ensure future agents operate reliably within this specific repository, create a dedicated skill (e.g. `skills/<project>-design-workflow/SKILL.md` or in the repository's skill directory).

### Template for Generated Workflow Skill:

```markdown
---
name: <project>-design-workflow
description: Procedures, validation rules, and lifecycle transitions for managing design docs in <project>. Use when creating, updating, or reviewing design documents, transitioning issue/ADR states, or linking source code.
---

# <Project> Design Docs Workflow

This repository uses `loom` governed by `design/document-model.mmd`.
Refer to `using-loom-cli` for general CLI operation syntax.

## 1. Document Classes & Locations
- Issues: `issue://<name>.md` -> `design/issues/<name>.md`
- ADRs: `adr://<name>.md` -> `design/adrs/<name>.md`

## 2. Common Operations

### Creating an Issue
\`\`\`bash
loom create issue://my-task.md "title: My Task" "status: open" "created: $(date +%Y-%m-%d)"
\`\`\`

### Linking Code to an Issue
When implementing an issue in code:
\`\`\`bash
loom link src://src/feature.ts#handleTask implements issue://my-task.md
\`\`\`

## 3. Lifecycle Transition Rules

### Moving an Issue to in_progress
- Check if blocked:
  \`\`\`bash
  loom query "SELECT object FROM edge WHERE subject = 'issue://my-task.md' AND relation = 'blocks'"
  \`\`\`

### Resolving an Issue
- Ensure code link exists:
  \`\`\`bash
  loom refs src://path/to/code.ts#symbol
  \`\`\`
- Update status:
  \`\`\`bash
  loom set issue://my-task.md status resolved
  \`\`\`

## 4. Pre-Commit Checklist
Always run before committing changes to design docs:
1. \`loom validate --fix\`
2. \`loom index\`
3. Verify zero errors in \`design/VALIDATION.md\`
```

---

## Step 7: Verification Checklist

1. Model passes `loom model check`.
2. Graph validates clean with `loom validate`.
3. Indexes update cleanly with `loom index`.
4. Git pre-commit or CI check runs `loom validate && loom index --check`.
5. The companion `using-loom-cli` skill is present and referenced.
