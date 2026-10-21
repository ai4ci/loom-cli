# Design docs

## Concept

A local wiki based on yaml headers + markdown, which allows linkage to other 
resources such as code. Yaml has a constrained 
structure defined by a mermaid UML model, and is validated on every edit.

## Inforamtion architecture

1. The repository root `$REPO_ROOT` which can be linked to using a 
`repo://relative/path/from/root` uri scheme.
2. A design docs folder `$DESIGN_DOCS_ROOT` (default `$REPO_ROOT/design`) which can be linked to using a 
`design://relative/path/in/design.md` uri scheme from outside the repository or
from non markdown content. In most cases design will be under the $REPO_ROOT
3. A mermaid class diagram file that defines classes and relationships as `$DESIGN_DOCS_ROOT\document-model.mmd`.
4. Each class in the document model defines the relative path from the 
reposity root where they can be found - the `$CLASS_ROOT` (one per class). 
The default would be in a folder under `$DESIGN_DOCS_ROOT` defined by the class, 
e.g a class of `issue` would be found at `$DESIGN_DOCS_ROOT/issue`.
5. Each specific class instance has an `instance-id` as a relative path from the `$CLASS_ROOT`, 
which will locate it. For example the first issue with instance-id: `my-first-issue.md` will be found at
`$DESIGN_DOCS_ROOT\issue\my-first-issue.md`
6. each class instance of a given type can be referenced with the class as a uri scheme
e.g. `my-first-issue.md` can be referred to as `issue://my-first-issue.md` 
7. entities have structured yaml data block with format defined by the document
model. 
8. relationships between entities are held as structured data in the yaml blocks 
with the linkage type and a uri to the entity.
9. source code can be referred to by URI and be part of 
the document-model but cannot have structured yaml data. In the document model
this is a reserved class `src` with uri scheme `src://` which by default 
maps to the `src` directory. `src` can be extended in the document model to 
allow linkage to particular source code tree locations, and require specific
linkage to design documents from parts of the code base. `src` must not 
have structured yaml data defined in the document model.
10. links to source code should be anchored using source code nodes such as 
function definitions or class names, as defined by the target programming 
language concrete syntax tree. e.g. `src://my/package/MyClass.java#myFunction`
11. `src` entities differ from other design entities as there is not a 1:1 
relationship from a `src` class instance and the file it is found in, so requiring 
structured yaml is difficult because of deep linking to specific regions of code.
11. reverse linkage from source code to design documents is through in code comments
that specify the linkage type, as defined by the document model, and uri target.
e.g. `// my-link-type: issue://my-first-issue.md`
These are validated as coming from an individual function by identifying the
comment location in the concrete syntax tree.
12. static resources such as pdfs, images can be linked to using the reserved
class `resource`. These can be linked to but not linked from. They must not 
have structured yaml data defined in the document model.
13. all uri schemes are resolved relative to repo root before detection of 
equivalence (e.g. `design://issue/my-first-issue.md == issue://my-first-issue.md`), 
as with RDF but stored in the data all uris should be expressed using most 
compact scheme.

## CLI requirements

The CLI consist of tools to validate and edit content in the design docs repository.

1. A suite of tools to perform transactional CRUD operations on the structured 
data of each class instance. A transaction is validated against the document-model. The 
transaction is specified in yaml as a change set. After validation the change 
set is applied to the affected files, and the yaml headers are updated. 
2. linkage between instances are maintained as relative links in a protected markdown section under the 
structured yaml which allows for navigation using standard markdown tools.
3. A suite of markdown edit tools that independently allow unprotected content to be edited
independently of a yaml structured data update, and protected markdown links.
4. The tool maintains a database of the structured yaml in the root of the 
design folder which can be queried using SQL (e.g. DuckDB).
5. The tool maintains a database of the relationships in the repository as a 
`instance-id`, `relationship-type`, `instance-id` triple store.
5. The tools maintain navigational indexes in the top level of the design folder
as markdown file using relative wiki links based on a configured view of the metadata 
(e.g. only open issues) stored in yaml metadata of the index.
6. The tool indexes the unprotected markdown content of each class instance and stores a
vector embedding that can be queried using similarity search.
7. The tools detect anomalies and inconsistencies due to direct editing of the 
markdown files and correct them where possible using the structured yaml as the
primary source of truth.
8. The tools detect validation failures across the whole design document folder 
and linked source code surfacing it as a list of documentation issues in the top level of the
design folder. This can detect both errors introduced by direct plain text edits 
and wholesale model changes due to extension of the document-model.
9. In the case of a document-model change the validation can be performed on a 
proposed version of the model to detect document model authoring errors and 
analyse impact.
10. the tool can traverse links to source code and identify the specific line number of
source code from `src://` uris in design documentation using the concrete syntax tree.
11. the tools can identify design documents that reference a specific function
in the source code, using reverse lookup in design documents.

## ADR

* mermaid class diagrams for easy specification and visualisation. methods are 
ignored, attributes and relationships are used to validate the instances.
* DuckDB single file embedded stored in design docs folder and git-ignored.
* DuckDB data model contains classes as tables and attributes but not relationships.
* DuckDB relationships in `instance-id`, `relationship`, `instance-id` triple store, 
with cardinality constraints checked on update (no structural foreign key constraints).
* treesitter-language-pack for wide language support (to include R).
