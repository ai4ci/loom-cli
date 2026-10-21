import { Document, Scalar, parse, visit } from "yaml";

/**
 * YAML emission rules (plan §2.2).
 *
 * These files are read by other tooling, much of it still on YAML 1.1, where
 * `no` is a boolean, `0755` is octal and `12:30` is sexagesimal. The `yaml`
 * package emits YAML 1.2 and so leaves all three unquoted. Anything a reader of
 * either version would coerce away from a string therefore has to be quoted by
 * us.
 */

/**
 * Plain words that no YAML version reads as anything but a string — provided
 * they are not one of the reserved words below.
 */
const PLAIN_WORD = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/** Words matching PLAIN_WORD that are nonetheless coerced by some version. */
const RESERVED_WORDS = new Set([
  "y", "yes", "n", "no", "on", "off", "true", "false", "null", "nan", "inf",
]);

/** True when `raw`, emitted bare, would read back as something other than a string. */
function coerces(raw: string, version: "1.1" | "1.2"): boolean {
  try {
    return typeof parse(raw, { version }) !== "string";
  } catch {
    // Unparseable on its own means it cannot be emitted bare either.
    return true;
  }
}

/**
 * True when `value` must be quoted to survive a round-trip as a string.
 *
 * The check is a round-trip rather than a list of patterns: anything either
 * parser turns into a non-string needs quoting, which covers octal, hex,
 * sexagesimal, `.inf`/`.nan`, and every spelling of the booleans without
 * enumerating them.
 */
export function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (value.trim() !== value) return true;
  if (PLAIN_WORD.test(value) && !RESERVED_WORDS.has(value.toLowerCase())) return false;
  return coerces(value, "1.1") || coerces(value, "1.2");
}

/**
 * Force quoting on every scalar in `doc` that needs it. Only ever upgrades a
 * scalar to quoted — the library's own structural quoting still applies on top.
 */
export function enforceSafeScalars(doc: Document): Document {
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && needsQuoting(node.value)) {
        node.type = Scalar.QUOTE_SINGLE;
      }
    },
  });
  return doc;
}

/** Serialise a value as YAML with the safety rules applied. */
export function stringifyYaml(value: unknown): string {
  // lineWidth 0 disables folding, so output is a function of the data alone.
  return enforceSafeScalars(new Document(value)).toString({ lineWidth: 0 });
}
