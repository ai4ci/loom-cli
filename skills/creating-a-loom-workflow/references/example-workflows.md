# Example Loom Workflows

Two concrete, validated reference workflows showing how to design a Mermaid document model, configure paths and indexes, and write the companion agent skill that puts it into practice.

1. **[Agile Feature Flow](#1-agile-feature-flow)**: Traceable software development linking user stories, ADRs, source code anchors, and test anchors.
2. **[Getting Things Done (GTD)](#2-getting-things-done-gtd)**: Personal productivity system with inbox capture, projects, next actions with contexts, and review routines.

---

# 1. Agile Feature Flow

A lightweight software development workflow for feature tracking and architecture decision records with end-to-end traceability to code and tests.

- **Design root**: `design/` (default)
- **Code root**: `/src`
- **Test root**: `/test`

## Mermaid Model (`design/document-model.mmd`)

```mermaid
classDiagram
    %% @path story design/stories
    %% @path bug design/bugs
    %% @path adr design/decisions
    %% @path src /src
    %% @path test /test
    class WorkStatus {
        <<enumeration>>
        backlog
        in_progress
        review
        done
    }

    class AdrStatus {
        <<enumeration>>
        proposed
        accepted
        superseded
    }

    class work {
        <<abstract>>
        +string title
        +WorkStatus status
        +date created
    }

    class story {
        +string so_that
        +int points?
    }

    class bug {
        +string steps
    }

    class adr {
        +string title
        +AdrStatus status
        +date decided
    }

    class test

    work <|-- story
    work <|-- bug
    src <|-- test

    story "0..*" --> "0..*" adr : constrained-by
    bug "0..*" --> "0..1" story : regression-in
    story "0..*" --> "0..*" src : implemented-by
    story "0..*" --> "0..*" test : verified-by
    adr "0..*" --> "0..*" adr : supersedes
```

### Key Model Decisions
- `work` is an abstract parent defining shared fields (`title`, `status`, `created`). Subclasses inherit them automatically.
- `src` is Loom's built-in terminal anchor family for source code. Subclassing `src <|-- test` creates a specialized terminal anchor scheme `test://` pointing at `/test`.
- Code and tests are referenced down to symbol level via anchors: `src://auth.ts#login`, `test://auth.test.ts#testLogin`.
- `story` points to `adr` via `constrained-by`, giving architectural context to feature implementation.

## Companion Skill (`skills/feature-workflow/SKILL.md`)

```markdown
---
name: feature-workflow
description: Procedures and rules for picking up, developing, and completing features in this repository using Loom.
---

# Feature Workflow

Use this skill when picking up stories, recording architecture decisions, writing code, and completing tasks.

## 1. Pick Up Work

Find the next backlog or in-progress story:

```bash
loom query "SELECT uri, title, points FROM story WHERE status = 'backlog' ORDER BY points ASC"
```

To take on a story, update its status:

```bash
loom mutate story://my-feature.md set status in_progress
```

## 2. Record Architecture Decisions

When a story requires significant design or pattern changes, record an ADR:

```bash
loom create adr://use-redis-cache.md title="Use Redis Cache" status=accepted decided=$(date +%Y-%m-%d)
loom body set adr://use-redis-cache.md "## Context\n\nHigh load on DB.\n\n## Decision\n\nCache user sessions in Redis."
loom mutate story://my-feature.md add constrained-by adr://use-redis-cache.md
```

## 3. Implement and Link Code & Tests

When implementing, link the story to the relevant source symbols and test cases:

```bash
loom mutate story://my-feature.md add implemented-by src://cache/redis.ts#SessionCache
loom mutate story://my-feature.md add verified-by test://cache/redis.test.ts#testSessionExpiry
```

Loom automatically checks that `#SessionCache` and `#testSessionExpiry` exist in the AST of those files.

## 4. Check Traceability & Validate

Before finishing work, verify that the graph is coherent:

```bash
# Stories in progress missing tests:
loom query "SELECT s.uri, s.title FROM story s WHERE s.status = 'in_progress' AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.subject = s.uri AND e.relation = 'verified-by')"

# Full repo validation:
loom validate
```

## 5. Complete the Story

Update status to done and regenerate the index board:

```bash
loom mutate story://my-feature.md set status done
loom index
```
```

---

# 2. Getting Things Done (GTD)

A complete personal productivity system based on David Allen's Getting Things Done (GTD) methodology, tracking inbox capture, active projects, next actions organized by physical context, and review cycles.

- **Design root**: `gtd/` (configured via `.loom.yaml` with `designRoot: gtd`)
- **Attachments root**: `gtd/files/`

## Configuration (`.loom.yaml`)

```yaml
designRoot: gtd
```

## Mermaid Model (`gtd/document-model.mmd`)

```mermaid
classDiagram
    %% @path resource gtd/files
    class ActionStatus {
        <<enumeration>>
        next
        waiting
        scheduled
        someday
        done
    }

    class ProjectStatus {
        <<enumeration>>
        active
        on_hold
        complete
        dropped
    }

    class Context {
        <<enumeration>>
        home
        office
        computer
        phone
        errands
        anywhere
    }

    class inbox {
        +string title
        +date captured
    }

    class area {
        +string title
        +string purpose
    }

    class project {
        +string title
        +string outcome
        +ProjectStatus status
        +date review_due?
    }

    class action {
        +string title
        +ActionStatus status
        +Context context
        +date due?
        +string waiting_on?
        +int minutes?
    }

    class note {
        +string title
        +date captured
    }

    class review {
        +string title
        +date performed
    }

    project "0..*" --> "0..1" area : supports
    action "0..*" --> "0..1" project : advances
    action "0..*" --> "0..*" action : blocks
    note "0..*" --> "0..*" project : relates-to
    note "0..*" --> "0..*" resource : attachment
    review "0..*" --> "0..*" project : reviewed
```

### Key Model Decisions
- `inbox` is an unclarified capture bucket with minimal metadata (`title`, `captured`).
- `action` is classified by `ActionStatus` (`next`, `waiting`, `scheduled`, `someday`, `done`) and physical `Context` (`home`, `office`, `computer`, `phone`, `errands`, `anywhere`).
- `project` has an explicit desired `outcome` and belongs to an `area` of responsibility.
- `action "0..*" --> "0..1" project : advances` allows standalone actions (actions that do not belong to a multi-step project).
- DuckDB queries easily find stalled projects (active projects with no pending `next` action).

## Dynamic Views (`gtd/NEXT.md`, `gtd/PROJECTS.md`)

```markdown
---
class: index
view:
  query: "SELECT uri, title FROM action WHERE status = 'next' ORDER BY context, title"
---

# Next Actions
```

## Companion Skill (`skills/gtd-workflow/SKILL.md`)

```markdown
---
name: gtd-workflow
description: Procedures for managing tasks, inbox processing, weekly reviews, and project tracking with Loom.
---

# GTD Workflow

Use this skill when capturing thoughts, clarifying inbox items, choosing what to do next, or performing a weekly review.

## 1. Quick Capture to Inbox

Capture any idea, task, or commitment immediately without friction:

```bash
loom create inbox://boiler-service.md title="Boiler service notice received" captured=$(date +%Y-%m-%d)
loom body set inbox://boiler-service.md "Letter from British Gas arrived today with annual service reminder."
```

## 2. Clarify & Process the Inbox

Process inbox items into actionable next actions or multi-step projects. Use changesets to create the action and remove the inbox item atomically:

```yaml
# clarify-boiler.yaml
ops:
  - op: create
    uri: action://call-boiler-service.md
    attrs:
      title: "Call British Gas to book annual service"
      status: next
      context: phone
      minutes: 10
  - op: delete
    uri: inbox://boiler-service.md
```

```bash
loom apply clarify-boiler.yaml
```

If it represents a multi-step outcome, create a `project` and link the initial next action to it:

```bash
loom create project://fix-boiler.md title="Service and certify boiler" outcome="Boiler serviced and signed off" status=active supports=area://home.md
loom mutate action://call-boiler-service.md set advances project://fix-boiler.md
```

## 3. Working by Context

When ready to take action, query tasks matching your current location or energy:

```bash
# Actions I can do on my phone in 15 minutes or less:
loom query "SELECT uri, title, minutes FROM action WHERE status = 'next' AND context = 'phone' AND minutes <= 15"

# What am I waiting on others for?
loom query "SELECT waiting_on, title FROM action WHERE status = 'waiting' ORDER BY waiting_on"
```

Mark an action done:

```bash
loom mutate action://call-boiler-service.md set status done
```

## 4. Weekly Review Routine

Run queries to find stalled projects and overdue items:

```bash
# 1. Stalled projects: active projects with no 'next' action advancing them
loom query "SELECT p.uri, p.title FROM project p WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM edge e JOIN action a ON a.uri = e.subject WHERE e.relation = 'advances' AND e.object = p.uri AND a.status = 'next')"

# 2. Overdue actions:
loom query "SELECT uri, title, due FROM action WHERE status = 'next' AND due < CURRENT_DATE"

# 3. Record the completed review:
loom create review://review-$(date +%Y-W%W).md title="Weekly Review $(date +%Y-W%W)" performed=$(date +%Y-%m-%d)
loom index
```
```
