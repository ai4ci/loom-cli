import pack from "@xberg-io/tree-sitter-language-pack";
import { type Diagnostic, error } from "../diagnostics.ts";
import {
  type Attribute,
  type AttributeType,
  type Cardinality,
  type ClassDef,
  PRIMITIVES,
  type PrimitiveName,
  RESERVED_FAMILIES,
  type Relation,
  type SchemaIR,
  UNBOUNDED,
} from "./types.ts";

/**
 * The mermaid grammar gives statement-level structure only: an attribute
 * arrives as one `class_method_line` whose text is verbatim, with no internal
 * nodes. So the CST supplies which class, which members, which relations and
 * which annotations, and the member line itself is parsed here.
 */

interface RawMember {
  text: string;
  line: number;
}

interface RawClass {
  name: string;
  annotations: string[];
  members: RawMember[];
  parents: string[];
  line: number;
  declarations: number;
}

type Node = {
  kind(): string;
  startByte(): number;
  endByte(): number;
  startPosition(): { row: number; column: number };
  childCount(): number;
  child(index: number): Node | null;
  isError(): boolean;
  isMissing(): boolean;
  hasError(): boolean;
};

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount(); i++) {
    const child = node.child(i);
    if (child) walk(child, visit);
  }
}

function childrenOfKind(node: Node, kind: string): Node[] {
  const found: Node[] = [];
  for (let i = 0; i < node.childCount(); i++) {
    const child = node.child(i);
    if (child && child.kind() === kind) found.push(child);
  }
  return found;
}

/** Depth-first search for the first descendant of a kind. */
function firstOfKind(node: Node, kind: string): Node | null {
  let found: Node | null = null;
  walk(node, (n) => {
    if (found === null && n !== node && n.kind() === kind) found = n;
  });
  return found;
}

export function parseCardinality(raw: string | undefined): Cardinality {
  if (raw === undefined) return { ...UNBOUNDED };
  const text = raw.replace(/^["']|["']$/g, "").trim();
  if (text === "" || text === "*" || text === "n") return { ...UNBOUNDED };

  const range = /^(\d+)\.\.(\d+|\*|n)$/.exec(text);
  if (range) {
    const upper = range[2]!;
    return { min: Number(range[1]), max: upper === "*" || upper === "n" ? null : Number(upper) };
  }
  if (/^\d+$/.test(text)) return { min: Number(text), max: Number(text) };
  return { ...UNBOUNDED };
}

/**
 * Split a member line into an attribute, an enumeration member, or nothing.
 * Classification needs the owning class's annotations, so it happens after the
 * whole model is walked.
 */
function classifyMember(raw: RawMember, isEnum: boolean): Attribute | string | Diagnostic | null {
  let text = raw.text.trim();
  if (text === "") return null;

  if ("+-#~".includes(text[0]!)) text = text.slice(1).trim();
  // Mermaid marks abstract/static members with a trailing * or $.
  text = text.replace(/[*$]$/, "").trim();

  // Methods are ignored per the ADR; the trailing parens are the only signal.
  if (/\(.*\)\s*$/.test(text)) return null;

  const parts = text.split(/\s+/).filter((p) => p !== "");

  if (isEnum) return parts.join(" ");

  if (parts.length === 1) {
    return error("model/untyped-attribute", `attribute "${parts[0]}" has no type`, {
      line: raw.line,
    });
  }
  if (parts.length !== 2) {
    return error("model/malformed-member", `cannot read member ${JSON.stringify(raw.text)}`, {
      line: raw.line,
    });
  }

  const [typeText, nameText] = parts as [string, string];
  const required = !nameText.endsWith("?");
  const name = required ? nameText : nameText.slice(0, -1);

  // Mermaid's generic syntax; `X[]` is rejected by the grammar but handled
  // here so a malformed model still produces a useful diagnostic.
  const generic = /^(?:List|Array|Set)~(.+)~$/.exec(typeText);
  const bracket = /^(.+)\[\]$/.exec(typeText);
  const list = generic !== null || bracket !== null;
  const elementType = generic?.[1] ?? bracket?.[1] ?? typeText;

  return {
    name,
    type: { kind: "unknown", name: elementType },
    list,
    required,
    line: raw.line,
  };
}

function resolveType(name: string, classes: Map<string, ClassDef>): AttributeType {
  if (PRIMITIVES.has(name)) return { kind: "primitive", name: name as PrimitiveName };
  const target = classes.get(name);
  if (!target) return { kind: "unknown", name };
  return target.annotations.includes("enumeration")
    ? { kind: "enum", className: name }
    : { kind: "class", className: name };
}

function glyphOf(text: string): string {
  return text.replace(/\s+/g, "");
}

export function parseModel(text: string): {
  schema: SchemaIR;
  diagnostics: Diagnostic[];
  /** Top-level `%%`-prefixed comment lines, in source order. */
  comments: { text: string; line: number }[];
} {
  const diagnostics: Diagnostic[] = [];
  const tree = pack.getParser("mermaid").parse(text) as unknown as { rootNode(): Node };
  const root = tree.rootNode();
  const slice = (n: Node) => text.slice(n.startByte(), n.endByte());
  const lineOf = (n: Node) => n.startPosition().row + 1;

  // The mermaid grammar collapses the whole file into a single `diagram_class`
  // node, so comments are not separately reported as children. Scan the
  // source line by line to collect `%% @path` annotations.
  const comments: { text: string; line: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) comments.push({ text: trimmed, line: i + 1 });
  }

  walk(root, (n) => {
    if (n.isError() || n.isMissing()) {
      diagnostics.push(
        error("model/syntax", `cannot parse ${JSON.stringify(slice(n).trim() || "<missing>")}`, {
          line: lineOf(n),
        }),
      );
    }
  });

  const raws = new Map<string, RawClass>();
  const ensure = (name: string, line: number): RawClass => {
    let found = raws.get(name);
    if (!found) {
      found = { name, annotations: [], members: [], parents: [], line, declarations: 0 };
      raws.set(name, found);
    }
    return found;
  };

  // Reserved families exist whether or not the model declares them (plan §1.9).
  for (const name of RESERVED_FAMILIES) ensure(name, 0);

  const className = (n: Node): string | null => {
    const body = firstOfKind(n, "class_name_body");
    return body ? slice(body).trim() : null;
  };

  interface RawRelation {
    left: string;
    right: string;
    leftCard?: string;
    rightCard?: string;
    glyph: string;
    label?: string;
    line: number;
  }
  const rawRelations: RawRelation[] = [];

  walk(root, (node) => {
    const kind = node.kind();

    if (kind === "class_stmt_class") {
      const name = className(node);
      if (name === null) return;
      const raw = ensure(name, lineOf(node));
      raw.declarations += 1;
      if (raw.line === 0) raw.line = lineOf(node);
      for (const a of childrenOfKind(node, "class_annotation_line")) {
        raw.annotations.push(slice(a).replace(/[<>]/g, "").trim().toLowerCase());
      }
      for (const m of childrenOfKind(node, "class_method_line")) {
        raw.members.push({ text: slice(m), line: lineOf(m) });
      }
      return;
    }

    if (kind === "class_stmt_method") {
      const name = className(node);
      const member = firstOfKind(node, "class_method_line");
      if (name === null || member === null) return;
      ensure(name, lineOf(node)).members.push({ text: slice(member), line: lineOf(member) });
      return;
    }

    if (kind === "class_stmt_annotation") {
      const name = className(node);
      const annotation = firstOfKind(node, "annotation");
      if (name === null || annotation === null) return;
      ensure(name, lineOf(node)).annotations.push(slice(annotation).trim().toLowerCase());
      return;
    }

    if (kind === "class_stmt_relation") {
      const names = childrenOfKind(node, "class_name");
      const cards = childrenOfKind(node, "cardinality");
      const relation = firstOfKind(node, "class_relation");
      const label = firstOfKind(node, "class_label");
      if (names.length !== 2 || relation === null) return;

      // A cardinality belongs to whichever class it sits next to.
      const leftCard = cards.find((c) => c.startByte() < relation.startByte());
      const rightCard = cards.find((c) => c.startByte() > relation.startByte());

      rawRelations.push({
        left: slice(names[0]!).trim(),
        right: slice(names[1]!).trim(),
        ...(leftCard ? { leftCard: slice(leftCard) } : {}),
        ...(rightCard ? { rightCard: slice(rightCard) } : {}),
        glyph: glyphOf(slice(relation)),
        ...(label ? { label: slice(label).trim() } : {}),
        line: lineOf(node),
      });
    }
  });

  // Classes must be declared explicitly: an endpoint that names nothing is an
  // error rather than an implicitly created class, which is how
  // `model/unknown-class` stays meaningful.
  const inheritance: { child: string; parent: string; line: number }[] = [];
  const relations: Relation[] = [];
  for (const raw of rawRelations) {
    const { glyph } = raw;

    if (/[*o]/.test(glyph)) {
      diagnostics.push(
        error(
          "model/composition-arrow",
          `composition and aggregation arrows are not used; type the nested value as an attribute instead of "${glyph}"`,
          { line: raw.line, fix: "declare it as an attribute whose type is the value class" },
        ),
      );
      continue;
    }

    if (glyph.includes("|")) {
      // `A <|-- B` means B extends A; `A --|> B` means A extends B.
      const [child, parent] = glyph.startsWith("<|") ? [raw.right, raw.left] : [raw.left, raw.right];
      inheritance.push({ child, parent, line: raw.line });
      continue;
    }

    if (raw.label === undefined || raw.label === "") {
      diagnostics.push(
        error("model/unnamed-relation", `relation between ${raw.left} and ${raw.right} has no name`, {
          line: raw.line,
          fix: "add a label, e.g. `: blocks`",
        }),
      );
      continue;
    }

    const pointsLeft = glyph.startsWith("<");
    const from = pointsLeft ? raw.right : raw.left;
    const to = pointsLeft ? raw.left : raw.right;
    const fromCard = pointsLeft ? raw.rightCard : raw.leftCard;
    const toCard = pointsLeft ? raw.leftCard : raw.rightCard;

    relations.push({
      name: raw.label,
      from,
      to,
      fromCardinality: parseCardinality(fromCard),
      toCardinality: parseCardinality(toCard),
      line: raw.line,
    });
  }

  // Classes exist before members are classified, since an enumeration's
  // annotation decides how its member lines read.
  const classes = new Map<string, ClassDef>();
  for (const raw of raws.values()) {
    classes.set(raw.name, {
      name: raw.name,
      annotations: raw.annotations,
      attributes: [],
      members: [],
      parents: raw.parents,
      line: raw.line,
      declarations: raw.declarations,
    });
  }

  for (const link of inheritance) {
    for (const endpoint of [link.child, link.parent]) {
      if (!classes.has(endpoint)) {
        diagnostics.push(error(
          "model/unknown-class",
          `inheritance names unknown class "${endpoint}"`,
          { line: link.line },
        ));
      }
    }
    classes.get(link.child)?.parents.push(link.parent);
  }

  for (const raw of raws.values()) {
    const def = classes.get(raw.name)!;
    const isEnum = def.annotations.includes("enumeration");
    for (const member of raw.members) {
      const classified = classifyMember(member, isEnum);
      if (classified === null) continue;
      if (typeof classified === "string") {
        def.members.push(classified);
      } else if ("severity" in classified) {
        diagnostics.push(classified);
      } else {
        def.attributes.push(classified);
      }
    }
  }

  for (const def of classes.values()) {
    for (const attribute of def.attributes) {
      if (attribute.type.kind === "unknown") {
        attribute.type = resolveType(attribute.type.name, classes);
      }
    }
  }

  return { schema: { classes, relations }, diagnostics, comments };
}
