import { parse } from "yaml";
import { type Diagnostic, error } from "./diagnostics.ts";

export type Op =
  | { op: "create"; uri: string; attrs: Record<string, unknown> }
  | { op: "set"; uri: string; attrs: Record<string, unknown> }
  | { op: "link"; from: string; rel: string; to: string }
  | { op: "unlink"; from: string; rel: string; to: string }
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; uri: string };

const REQUIRED: Record<string, string[]> = {
  create: ["uri", "attrs"],
  set: ["uri", "attrs"],
  link: ["from", "rel", "to"],
  unlink: ["from", "rel", "to"],
  rename: ["from", "to"],
  delete: ["uri"],
};

export function parseChangeset(text: string): { ops: Op[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (cause) {
    return {
      ops: [],
      diagnostics: [error("changeset/unparseable", `cannot read changeset: ${(cause as Error).message}`)],
    };
  }

  const raw = (parsed as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(raw)) {
    return { ops: [], diagnostics: [error("changeset/no-ops", "changeset has no `ops` list")] };
  }

  const ops: Op[] = [];
  raw.forEach((entry, index) => {
    const at = `ops[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      diagnostics.push(error("changeset/malformed-op", `${at} is not a mapping`));
      return;
    }

    const record = entry as Record<string, unknown>;
    const name = record["op"];
    if (typeof name !== "string" || REQUIRED[name] === undefined) {
      diagnostics.push(error("changeset/unknown-op", `${at} has unknown op ${JSON.stringify(name)}`));
      return;
    }

    const missing = REQUIRED[name].filter((field) => record[field] === undefined);
    if (missing.length > 0) {
      diagnostics.push(error("changeset/missing-field", `${at} (${name}) is missing ${missing.join(", ")}`));
      return;
    }

    if ((name === "create" || name === "set")) {
      const attrs = record["attrs"];
      if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
        diagnostics.push(error("changeset/malformed-op", `${at} attrs must be a mapping`));
        return;
      }
    }

    ops.push(record as unknown as Op);
  });

  return { ops, diagnostics };
}
