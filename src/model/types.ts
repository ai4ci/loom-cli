/** Attribute type vocabulary (plan §1.7). */
export type PrimitiveName = "string" | "int" | "float" | "bool" | "date" | "path" | "uri";

export const PRIMITIVES: ReadonlySet<string> = new Set<PrimitiveName>([
  "string", "int", "float", "bool", "date", "path", "uri",
]);

/**
 * Tagged union from the outset so class-typed attributes slot in without
 * touching every consumer (plan §1.10).
 */
export type AttributeType =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "enum"; className: string }
  | { kind: "class"; className: string }
  | { kind: "unknown"; name: string };

export interface Attribute {
  name: string;
  type: AttributeType;
  list: boolean;
  required: boolean;
  line: number;
}

/** `min`..`max`, with `max: null` meaning unbounded. */
export interface Cardinality {
  min: number;
  max: number | null;
}

export interface Relation {
  name: string;
  from: string;
  to: string;
  /** How many `from` participate per `to` — the multiplicity beside `from`. */
  fromCardinality: Cardinality;
  /** How many `to` participate per `from` — the multiplicity beside `to`. */
  toCardinality: Cardinality;
  line: number;
}

export interface ClassDef {
  name: string;
  /** Lower-cased annotation names, e.g. "abstract", "enumeration". */
  annotations: string[];
  attributes: Attribute[];
  /** Enumeration members, in declaration order. */
  members: string[];
  parents: string[];
  line: number;
  /** How many times `class X` was written; >1 is a duplicate declaration. */
  declarations: number;
}

export interface SchemaIR {
  classes: Map<string, ClassDef>;
  relations: Relation[];
}

/** Classes that address code or static files and carry no structured YAML. */
export const RESERVED_FAMILIES = ["src", "resource"] as const;

export const UNBOUNDED: Cardinality = { min: 0, max: null };

export function isAbstract(c: ClassDef): boolean {
  return c.annotations.includes("abstract");
}

export function isEnumeration(c: ClassDef): boolean {
  return c.annotations.includes("enumeration");
}
