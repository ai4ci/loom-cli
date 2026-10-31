import { existsSync } from "node:fs";
import path from "node:path";
import { LoomError, type Diagnostic, error, warning } from "./diagnostics.ts";
import { isAbstract, isEnumeration, type SchemaIR } from "./model/types.ts";

/** Reserved class names that must never be declared by the model. */
const RESERVED_CLASS_NAMES = new Set(["repo", "design"]);

/**
 * Repo-relative POSIX path for a class. `null` for classes without files of
 * their own (abstract, enumeration) and for external classes.
 */
export type ClassRoot = string | null;

/** Map of class name to its repo-relative root, computed from the schema. */
export type ClassRoots = Map<string, ClassRoot>;

export interface PathResolution {
  roots: ClassRoots;
  /** Prefixes whose target is an absolute URL (`https:`, `file:`, ...). */
  external: Map<string, string>;
  /** Diagnostics produced during resolution; should be merged with model diagnostics. */
  diagnostics: Diagnostic[];
}

const PREFIX_RE = /^%%\s+@prefix\s+([A-Za-z][A-Za-z0-9_-]*):\s+<?([^\s<>]+)>?\s*\.?\s*$/;
const PATH_RE = /^%%\s+@path\s+([A-Za-z][A-Za-z0-9_-]*)\s+(\S+)\s*$/;

/**
 * Extract `%% @prefix <name>: <target> .` annotations (the angle brackets
 * and trailing ` .` are optional). Targets are returned raw; see
 * {@link resolveClassRoots} for their meaning. CURIE expansion is string
 * concatenation, not path join, so the target must end in `/` or `#`.
 * The retired `%% @path` form is a hard error naming its replacement.
 */
export function extractPrefixAnnotations(
  comments: { text: string; line: number }[],
  diagnostics: Diagnostic[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const { text, line } of comments) {
    const old = PATH_RE.exec(text);
    if (old !== null) {
      const raw = old[2]!.replace(/\/+$/, "");
      const target = raw.startsWith("/") ? `repo:${raw.slice(1)}/` : `${raw}/`;
      diagnostics.push(error(
        "model/path-removed",
        `%% @path is no longer supported — use %% @prefix`,
        { line, fix: `%% @prefix ${old[1]!.toLowerCase()}: <${target}> .` },
      ));
      continue;
    }
    const match = PREFIX_RE.exec(text);
    if (match === null) continue;
    const name = match[1]!.toLowerCase();
    const target = match[2]!;
    if (!target.endsWith("/") && !target.endsWith("#")) {
      diagnostics.push(error(
        "model/prefix-delimiter",
        `prefix "${name}" target "${target}" must end in "/" or "#" — ` +
          `curie expansion is concatenation, not path join`,
        { line, fix: `write ${target}/ or ${target}#` },
      ));
      continue;
    }
    if (result.has(name)) {
      diagnostics.push(error(
        "model/duplicate-prefix",
        `duplicate %% @prefix "${name}"`,
        { line },
      ));
      continue;
    }
    result.set(name, target);
  }
  return result;
}

/** Collapse `.`, `..`, repeated slashes; throws if the path escapes its root. */
export function normalisePath(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new LoomError(
          error("path/escapes-root", `path ${JSON.stringify(raw)} escapes its root`),
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** True iff `p` equals `root` or sits under it. */
function under(p: string, root: string): boolean {
  return root !== "" && (p === root || p.startsWith(`${root}/`));
}

/**
 * Compute the repo-relative root of every class (design/prefix-unification.md):
 *
 *   1. An explicit `%% @prefix` wins. `repo:x/` is repo-rooted; an absolute
 *      URL (`https:`, `file:`) is external; anything else is relative to
 *      `base` — the directory holding the model (`@base`).
 *   2. Otherwise a class appends its name to its parent's root. Parents
 *      without a root (abstract, enumeration) are skipped; parents that
 *      disagree are `path/ambiguous-inheritance`.
 *   3. A class with no rooted parent is `<base>/<name>`.
 *
 * `src` and `resource` get no special case. Abstract and enumeration classes
 * get `null`. Identical roots collide (`path/collision`); missing
 * directories warn (`path/missing-directory`).
 */
export function resolveClassRoots(
  schema: SchemaIR,
  prefixes: Map<string, string>,
  repoRoot: string,
  base: string,
  existsCheck: (repoRelative: string) => boolean = (p) =>
    existsSync(path.join(repoRoot, p)),
): PathResolution {
  const diagnostics: Diagnostic[] = [];
  const roots: ClassRoots = new Map();
  const external = new Map<string, string>();
  const local = new Map<string, string>();
  const baseDir = base === "." ? "" : base;

  for (const [name, target] of prefixes) {
    if (target.startsWith("repo:")) local.set(name, target.slice("repo:".length));
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) external.set(name, target);
    else local.set(name, joinPath(baseDir, target));
  }

  const rootOf = (name: string, seen: Set<string>): ClassRoot => {
    if (roots.has(name)) return roots.get(name)!;
    const key = findClass(schema, name);
    const def = key === undefined ? undefined : schema.classes.get(key);
    let root: ClassRoot;
    if (external.has(name)) {
      root = null;
    } else if (local.has(name)) {
      root = normaliseRoot(name, local.get(name)!, diagnostics);
    } else if (def === undefined || isAbstract(def) || isEnumeration(def) || seen.has(name)) {
      root = null;
    } else {
      seen.add(name);
      const inherited = new Set<string>();
      for (const parent of def.parents) {
        const r = rootOf(parent.toLowerCase(), seen);
        if (r !== null) inherited.add(joinPath(r, def.name));
      }
      if (inherited.size > 1) {
        diagnostics.push(error(
          "path/ambiguous-inheritance",
          `class "${def.name}" inherits several roots: ${[...inherited].join(", ")}`,
          { fix: `add %% @prefix ${def.name.toLowerCase()}: <repo:.../> . to pick one` },
        ));
      }
      root = inherited.size > 0 ? [...inherited][0]! : joinPath(baseDir, def.name);
      root = normaliseRoot(name, root, diagnostics);
    }
    roots.set(name, root);
    return root;
  };

  for (const name of schema.classes.keys()) rootOf(name.toLowerCase(), new Set());
  // Public keys use the declared spelling; lookups are case-insensitive.
  for (const name of schema.classes.keys()) {
    const lower = name.toLowerCase();
    if (lower !== name) { roots.set(name, roots.get(lower)!); roots.delete(lower); }
  }
  // Prefixes for names the diagram never declares still address files.
  for (const [name, target] of local) {
    if (!roots.has(name) && findClass(schema, name) === undefined) {
      roots.set(name, normaliseRoot(name, target, diagnostics));
    }
  }

  const byPath = new Map<string, string[]>();
  for (const [name, root] of roots) {
    if (root === null) continue;
    byPath.set(root, [...(byPath.get(root) ?? []), name]);
  }
  for (const [root, names] of byPath) {
    if (names.length > 1) {
      diagnostics.push(error(
        "path/collision",
        `classes ${names.join(", ")} resolve to the same path "${root}"`,
        { fix: `give one of them its own %% @prefix` },
      ));
    }
    if (!existsCheck(root)) {
      diagnostics.push(warning(
        "path/missing-directory",
        `class directory "${root}" does not exist on disk`,
      ));
    }
  }
  return { roots, external, diagnostics };
}

function findClass(schema: SchemaIR, name: string): string | undefined {
  if (schema.classes.has(name)) return name;
  for (const key of schema.classes.keys()) if (key.toLowerCase() === name) return key;
  return undefined;
}

function normaliseRoot(name: string, raw: string, diagnostics: Diagnostic[]): string {
  try {
    return normalisePath(raw);
  } catch {
    diagnostics.push(error(
      "path/escapes-repo",
      `class "${name}" resolves to a path that escapes the repository: "${raw}"`,
    ));
    return raw;
  }
}

function joinPath(base: string, rest: string): string {
  if (base === "") return rest;
  return rest === "" ? base : `${base}/${rest}`;
}

/**
 * The repo-relative path for a single class. `null` for non-instantiable.
 * Throws if the class is unknown to the schema — that's a programming error,
 * not a user-facing condition.
 */
export function classRoot(roots: ClassRoots, name: string): string {
  // URI schemes are lowercased on parse, so look up case-insensitively to
  // match classes declared in any case (`R`, `Test`, etc).
  const key = roots.has(name) ? name : findKey(roots, name);
  const root = key === undefined ? roots.get(name) : roots.get(key);
  if (root === undefined) {
    throw new LoomError(error("path/unknown-class", `unknown class "${name}"`));
  }
  return root ?? "";
}

function findKey(roots: ClassRoots, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of roots.keys()) {
    if (key.toLowerCase() === wanted) return key;
  }
  return undefined;
}

/** The scheme (`src`, `issue`, etc.) that best represents a repo-relative path. */
export function schemeFor(roots: ClassRoots, repoRelativePath: string): string {
  let best: { scheme: string; root: string } | null = null;
  for (const [name, root] of roots) {
    if (root === null) continue;
    if (!under(repoRelativePath, root)) continue;
    if (best === null || root.length > best.root.length) best = { scheme: name, root };
  }
  return best?.scheme ?? "repo";
}

export function isReservedClassName(name: string): boolean {
  return RESERVED_CLASS_NAMES.has(name);
}
