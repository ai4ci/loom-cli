/** A model exercising every construct the Phase 1 parser must handle. */
export const MODEL = `classDiagram
    class designDoc {
        <<abstract>>
        +string title
        +date created
    }

    class issue {
        +IssueStatus status
        +string assignee?
        +List~string~ tags
        +int priority?
        +getSummary()
    }

    class IssueStatus {
        <<enumeration>>
        open
        closed
    }

    designDoc <|-- issue
    issue "0..*" --> "0..*" issue : blocks
    issue "1" --> "0..*" src : implemented-by
`;
