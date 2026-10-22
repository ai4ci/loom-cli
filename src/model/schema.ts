import type { Config } from "../config.ts";
import { type Diagnostic, error, warning } from "../diagnostics.ts";
import {
  type Attribute,
  type ClassDef,
  isAbstract,
  isEnumeration,
  RESERVED_FAMILIES,
  type Relation,
  type SchemaIR,
} from "./types.ts";

/** Ancestors of a class, nearest first, stopping at a cycle. */
export function ancestors(schema: SchemaIR, name: string): string[] {
  const seen = new Set<string>([name]);
  const out: string[] = [];
  const queue = [...(schema.classes.get(name)?.parents ?? [])];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(schema.classes.get(next)?.parents ?? []));
  }
  return out;
}

export function isSubclassOf(schema: SchemaIR, name: string, candidate: string): boolean {
  return name === candidate || ancestors(schema, name).includes(candidate);
}

/** Own attributes plus inherited ones, parents first. */
export function effectiveAttributes(schema: SchemaIR, name: string): Attribute[] {
  const byName = new Map<string, Attribute>();
  for (const ancestor of [...ancestors(schema, name)].reverse()) {
    for (const a of schema.classes.get(ancestor)?.attributes ?? []) byName.set(a.name, a);
  }
  for (const a of schema.classes.get(name)?.attributes ?? []) byName.set(a.name, a);
  return [...byName.values()];
}

/** Relations whose source is this class or one of its ancestors. */
export function effectiveRelations(schema: SchemaIR, name: string): Relation[] {
  return schema.relations.filter((r) => isSubclassOf(schema, name, r.from));
}

export function inReservedFamily(schema: SchemaIR, name: string): boolean {
  return RESERVED_FAMILIES.some((family) => isSubclassOf(schema, name, family));
}

/** A class with files of its own: concrete, not an enum, not code or a resource. */
export function isInstantiable(schema: SchemaIR, name: string): boolean {
  const def = schema.classes.get(name);
  if (!def) return false;
  return !isAbstract(def) && !isEnumeration(def) && !inReservedFamily(schema, name);
}

/** Classes named as the type of some attribute — value types (plan §1.10). */
function valueTypeNames(schema: SchemaIR): Set<string> {
  const names = new Set<string>();
  for (const def of schema.classes.values()) {
    for (const a of def.attributes) {
      if (a.type.kind === "class") names.add(a.type.className);
    }
  }
  return names;
}

function hasInheritanceCycle(schema: SchemaIR, name: string): boolean {
  const seen = new Set<string>();
  const stack = [name];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === name && seen.size > 0) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(schema.classes.get(next)?.parents ?? []));
  }
  return false;
}

function valueTypeCycle(schema: SchemaIR, start: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  let first = true;
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === start && !first) return true;
    first = false;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const a of schema.classes.get(next)?.attributes ?? []) {
      if (a.type.kind === "class") stack.push(a.type.className);
    }
  }
  return false;
}

export function validateModel(schema: SchemaIR, cfg: Config): Diagnostic[] {
  const found: Diagnostic[] = [];
  const valueTypes = valueTypeNames(schema);
  const relationTargets = new Set(schema.relations.map((r) => r.to));

  for (const def of schema.classes.values()) {
    const at = (rest: Partial<Diagnostic> = {}) => ({ line: def.line, ...rest });

    if (def.declarations > 1) {
      found.push(error("model/duplicate-class", `class "${def.name}" is declared ${def.declarations} times`, at()));
    }

    for (const attribute of def.attributes) {
      if (attribute.type.kind === "unknown") {
        found.push(error(
          "model/unknown-type",
          `attribute "${def.name}.${attribute.name}" has unknown type "${attribute.type.name}"`,
          { line: attribute.line },
        ));
      }
    }

    if (isEnumeration(def) && def.members.length === 0) {
      found.push(error("model/empty-enumeration", `enumeration "${def.name}" has no members`, at()));
    }

    if (hasInheritanceCycle(schema, def.name)) {
      found.push(error("model/inheritance-cycle", `class "${def.name}" is its own ancestor`, at()));
    }

    const nonInstantiable = isAbstract(def) || isEnumeration(def);
    if (nonInstantiable && cfg.classRoots[def.name] !== undefined) {
      found.push(error(
        "model/abstract-has-root",
        `"${def.name}" is not instantiable and must not have a class root`,
        at({ fix: `remove classRoots.${def.name} from the config` }),
      ));
    }

    if (inReservedFamily(schema, def.name) && def.attributes.length > 0) {
      found.push(error(
        "model/reserved-has-attributes",
        `"${def.name}" is in the ${RESERVED_FAMILIES.join("/")} family and must not declare structured attributes`,
        at(),
      ));
    }

    if (valueTypes.has(def.name)) {
      const edges = schema.relations.filter((r) => r.from === def.name || r.to === def.name);
      if (edges.length > 0) {
        found.push(error(
          "model/value-type-has-relations",
          `value type "${def.name}" must declare attributes only; an embedded value has no uri to hang an edge on`,
          at({ fix: "move the relation onto the owning document class" }),
        ));
      }
      if (valueTypeCycle(schema, def.name)) {
        found.push(error("model/value-type-cycle", `value type "${def.name}" contains itself`, at()));
      }
    }

    // Link text comes from `title` (plan §2.2).
    if (
      relationTargets.has(def.name)
      && isInstantiable(schema, def.name)
      && !effectiveAttributes(schema, def.name).some((a) => a.name === "title")
    ) {
      found.push(warning(
        "model/no-title-attribute",
        `"${def.name}" can be a relation target but has no "title" attribute to label links with`,
        at(),
      ));
    }

    // An attribute or relation name may not be reused, inherited names included.
    const attributeNames = effectiveAttributes(schema, def.name).map((a) => a.name);
    const relationNames = effectiveRelations(schema, def.name).map((r) => r.name);
    for (const name of new Set([...attributeNames, ...relationNames])) {
      const inherited = [...ancestors(schema, def.name), def.name]
        .flatMap((c) => schema.classes.get(c)?.attributes ?? [])
        .filter((a) => a.name === name);
      const clashesWithRelation = attributeNames.includes(name) && relationNames.includes(name);
      if (clashesWithRelation || inherited.length > 1) {
        found.push(error(
          "model/name-collision",
          `"${name}" is declared more than once for "${def.name}"`,
          at(),
        ));
      }
    }
  }

  for (const relation of schema.relations) {
    for (const endpoint of [relation.from, relation.to]) {
      if (!schema.classes.has(endpoint)) {
        found.push(error(
          "model/unknown-class",
          `relation "${relation.name}" names unknown class "${endpoint}"`,
          { line: relation.line },
        ));
      }
    }
  }

  return found;
}
