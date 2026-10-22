import type { Config } from "./config.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import {
  effectiveAttributes,
  effectiveRelations,
  isInstantiable,
  isSubclassOf,
} from "./model/schema.ts";
import type { Attribute, Cardinality, SchemaIR } from "./model/types.ts";
import { parseUri } from "./uri.ts";

/** Keys every instance carries for self-description (plan §2.2). */
export const RESERVED_KEYS = ["class", "id"] as const;

export interface InstanceInput {
  /** Canonical uri of the instance. */
  uri: string;
  /** Class implied by the file's location, which wins over the declared one. */
  className: string;
  /** Frontmatter as plain data. */
  data: Record<string, unknown>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function describe(type: Attribute["type"]): string {
  switch (type.kind) {
    case "primitive": return type.name;
    case "enum": return `${type.className} (enumeration)`;
    case "class": return type.className;
    case "unknown": return type.name;
  }
}

function withinCardinality(count: number, cardinality: Cardinality): boolean {
  if (count < cardinality.min) return false;
  return cardinality.max === null || count <= cardinality.max;
}

/** Relation values accept a single uri or a list of them. */
function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function checkScalar(
  schema: SchemaIR,
  attribute: Attribute,
  value: unknown,
  uri: string,
): Diagnostic[] {
  const mismatch = (): Diagnostic[] => [error(
    "instance/type-mismatch",
    `"${attribute.name}" should be ${describe(attribute.type)}, got ${JSON.stringify(value)}`,
    { uri },
  )];

  switch (attribute.type.kind) {
    case "primitive":
      switch (attribute.type.name) {
        case "string":
        case "path":
          return typeof value === "string" ? [] : mismatch();
        case "uri":
          if (typeof value !== "string") return mismatch();
          try {
            parseUri(value);
            return [];
          } catch {
            return [error("instance/invalid-uri", `"${attribute.name}" is not a design uri: ${JSON.stringify(value)}`, { uri })];
          }
        case "int":
          return typeof value === "number" && Number.isInteger(value) ? [] : mismatch();
        case "float":
          return typeof value === "number" ? [] : mismatch();
        case "bool":
          return typeof value === "boolean" ? [] : mismatch();
        case "date":
          return isValidDate(value) ? [] : mismatch();
      }
      return [];

    case "enum": {
      const members = schema.classes.get(attribute.type.className)?.members ?? [];
      if (typeof value !== "string") return mismatch();
      return members.includes(value)
        ? []
        : [error(
            "instance/invalid-enum-value",
            `"${attribute.name}" must be one of ${members.join(", ")}, got ${JSON.stringify(value)}`,
            { uri },
          )];
    }

    case "class": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return mismatch();
      return checkAttributes(
        schema,
        effectiveAttributes(schema, attribute.type.className),
        value as Record<string, unknown>,
        uri,
        `${attribute.name}.`,
      );
    }

    case "unknown":
      return [];
  }
}

function checkAttributes(
  schema: SchemaIR,
  attributes: Attribute[],
  data: Record<string, unknown>,
  uri: string,
  prefix = "",
): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const attribute of attributes) {
    const value = data[attribute.name];
    if (value === undefined || value === null) {
      if (attribute.required) {
        found.push(error(
          "instance/missing-required",
          `required attribute "${prefix}${attribute.name}" is missing`,
          { uri, line: attribute.line },
        ));
      }
      continue;
    }

    if (attribute.list) {
      if (!Array.isArray(value)) {
        found.push(error(
          "instance/type-mismatch",
          `"${prefix}${attribute.name}" should be a list of ${describe(attribute.type)}`,
          { uri },
        ));
        continue;
      }
      for (const element of value) found.push(...checkScalar(schema, attribute, element, uri));
      continue;
    }

    found.push(...checkScalar(schema, attribute, value, uri));
  }

  return found;
}

/**
 * Validate a single instance against the schema. Everything checkable without
 * reading other files happens here; cross-file checks are Phase 2.
 */
export function validateInstance(
  schema: SchemaIR,
  _cfg: Config,
  input: InstanceInput,
): Diagnostic[] {
  const { uri, className, data } = input;
  const found: Diagnostic[] = [];

  if (!schema.classes.has(className)) {
    return [error("instance/unknown-class", `no class "${className}" in the document model`, { uri })];
  }
  if (!isInstantiable(schema, className)) {
    return [error(
      "instance/not-instantiable",
      `"${className}" is abstract, an enumeration or code, so it has no instance files`,
      { uri },
    )];
  }

  const declaredClass = data["class"];
  if (declaredClass !== undefined && declaredClass !== className) {
    found.push(error(
      "instance/class-mismatch",
      `declared class "${String(declaredClass)}" disagrees with the location, which says "${className}"`,
      { uri, fix: `set class: ${className}` },
    ));
  }

  const expectedId = parseUri(uri).path;
  const declaredId = data["id"];
  if (declaredId !== undefined && declaredId !== expectedId) {
    found.push(error(
      "instance/id-mismatch",
      `declared id "${String(declaredId)}" disagrees with the location, which says "${expectedId}"`,
      { uri, fix: `set id: ${expectedId}` },
    ));
  }

  const attributes = effectiveAttributes(schema, className);
  const relations = effectiveRelations(schema, className);
  found.push(...checkAttributes(schema, attributes, data, uri));

  const known = new Set<string>([
    ...RESERVED_KEYS,
    ...attributes.map((a) => a.name),
    ...relations.map((r) => r.name),
  ]);
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      found.push(error("instance/unknown-key", `"${key}" is not in the model for "${className}"`, { uri }));
    }
  }

  for (const relation of relations) {
    const value = data[relation.name];
    if (value === undefined || value === null) {
      if (!withinCardinality(0, relation.toCardinality)) {
        found.push(error(
          "instance/cardinality",
          `"${relation.name}" needs at least ${relation.toCardinality.min} target(s)`,
          { uri, line: relation.line },
        ));
      }
      continue;
    }

    const targets = asList(value);
    if (!withinCardinality(targets.length, relation.toCardinality)) {
      const { min, max } = relation.toCardinality;
      found.push(error(
        "instance/cardinality",
        `"${relation.name}" has ${targets.length} target(s), model allows ${min}..${max ?? "*"}`,
        { uri, line: relation.line },
      ));
    }

    for (const target of targets) {
      if (typeof target !== "string") {
        found.push(error("instance/invalid-uri", `"${relation.name}" target is not a uri`, { uri }));
        continue;
      }
      let targetClass: string;
      try {
        targetClass = parseUri(target).scheme;
      } catch {
        found.push(error(
          "instance/invalid-uri",
          `"${relation.name}" target ${JSON.stringify(target)} is not a design uri`,
          { uri },
        ));
        continue;
      }
      if (!isSubclassOf(schema, targetClass, relation.to)) {
        found.push(error(
          "instance/wrong-target-class",
          `"${relation.name}" must point at ${relation.to}, got ${targetClass}`,
          { uri },
        ));
      }
    }
  }

  return found;
}
