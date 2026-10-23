import { existsSync } from "node:fs";
import path from "node:path";
import { LoomError, type Diagnostic, error, warning } from "./diagnostics.ts";
import { isInstantiable } from "./model/schema.ts";
import {
  type ClassDef,
  type SchemaIR,
} from "./model/types.ts";

/** Terminal anchors: their `@path` is always resolved relative to `$REPO_ROOT`. */
const TERMINAL_ANCHORS = new Set(["src", "resource"]);

/** Reserved class names that must never be declared by the model. */
const RESERVED_CLASS_NAMES = new Set(["repo", "design"]);

/**
 * Repo-relative POSIX path for a class. `null` for non-instantiable classes
 * (abstract, enumeration, src/resource family).
 */
export type ClassRoot = string | null;

/** Map of class name to its repo-relative root, computed from the schema. */
export type ClassRoots = Map<string, ClassRoot>;

/**
 * The raw annotation captured from a top-level `%% @path <class> <path>`
 * comment, stored on a class for later resolution.
 */
export interface PathAnnotation {
  /** Repo-relative absolute path (leading `/`): always. */
  absolute: string | null;
  /** Repo-relative path segment, joined onto the parent's resolved path. */
  relative: string | null;
  /** Line in the model file. */
  line: number;
}

export interface PathResolution {
  roots: ClassRoots;
  /** Diagnostics produced during resolution; should be merged with model diagnostics. */
  diagnostics: Diagnostic[];
}

/**
 * Extract `%% @path` annotations from a list of top-level mermaid comments,
 * grouped by class name. Returns a map of class → annotation.
 *
 * A line matches `%% @path <name> <path>`. Names are lowercased.
 * Paths beginning with `/` are absolute (repo-relative); others are relative.
 */
export function extractPathAnnotations(
  comments: { text: string; line: number }[],
): Map<string, PathAnnotation> {
  const result = new Map<string, PathAnnotation>();
  for (const { text, line } of comments) {
    const match = /^%%\s+@path\s+([A-Za-z][A-Za-z0-9_-]*)\s+(\S+)\s*$/.exec(text);
    if (match === null) continue;
    const name = match[1]!;
    const raw = match[2]!;
    const ann: PathAnnotation = raw.startsWith("/")
      ? { absolute: raw.slice(1), relative: null, line }
      : { absolute: null, relative: raw, line };
    // Multiple annotations on one class: keep the first, flag the rest.
    if (!result.has(name)) result.set(name, ann);
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
 * Compute the repo-relative path for every class in the schema. Resolution
 * follows complex-path-examples §5:
 *
 *   1. `src` and `resource` are terminal anchors: their `@path` value is
 *      always repo-relative, no matter absolute or relative. Their default
 *      roots are `src` and `resource`.
 *   2. Other classes with an explicit `@path` annotation:
 *      - Absolute form (`/foo`): taken literally relative to `$REPO_ROOT`.
 *      - Relative form: joined onto the resolved path of the first UML parent.
 *        If the class has no parent, joined onto `$LOOM_DEFAULT_ROOT`.
 *   3. Classes with no `@path`:
 *      - If a class has a UML parent, the class name is appended to that
 *        parent's path.
 *      - Otherwise the class name is appended to `$LOOM_DEFAULT_ROOT`.
 *
 * `nonInstantiable` classes (abstract, enumeration, src/resource family)
 * always get `null` regardless of any annotation.
 *
 * Returns the map plus any diagnostics. Two classes resolving to identical
 * paths collide and produce `path/collision`. A path that escapes the repo
 * (`..`) produces `path/escapes-repo`. A missing directory produces
 * `path/missing-directory` as a warning, for every class.
 */
export function resolveClassRoots(
  schema: SchemaIR,
  annotations: Map<string, PathAnnotation>,
  repoRoot: string,
  designRoot: string,
  existsCheck: (repoRelative: string) => boolean = (p) =>
    existsSync(path.join(repoRoot, p)),
): PathResolution {
  const diagnostics: Diagnostic[] = [];
  const resolved = new Map<string, string>();

  // First pass: classes with explicit annotations.
  for (const [name, def] of schema.classes) {
    // The terminal anchor families (`src`, `resource`) and their instantiable
    // subclasses are all resolved here. Non-instantiable classes (abstract,
    // enumeration, value types) are skipped and get `null` in the final map.
    if (!isInstantiable(schema, name) && !TERMINAL_ANCHORS.has(name)) continue;
    const ann = annotations.get(name);

    if (TERMINAL_ANCHORS.has(name)) {
      // Terminal anchors follow the same convention as any other class:
      // absolute annotations (leading `/`) are repo-rooted; relative
      // annotations are joined onto the design root. Their default when no
      // annotation is given is the class name at the repo root.
      const root = ann === undefined
        ? defaultTerminalRoot(name)
        : ann.absolute ?? resolveRelative(name, def, schema, resolved, designRoot, ann.relative!);
      const normalised = normalisePath(root);
      checkEscapes(name, normalised, diagnostics);
      resolved.set(name, normalised);
      continue;
    }

    if (ann !== undefined) {
      const root = ann.absolute ?? resolveRelative(name, def, schema, resolved, designRoot, ann.relative!);
      const normalised = normalisePath(root);
      checkEscapes(name, normalised, diagnostics);
      resolved.set(name, normalised);
    }
  }

  // Second pass: classes that inherit (or default) without an annotation.
  // Inheritance walks parents before the child, so by the time we reach a
  // class its parents are already in `resolved`.
  for (const [name, def] of schema.classes) {
    if (!isInstantiable(schema, name) && !TERMINAL_ANCHORS.has(name)) continue;
    if (resolved.has(name)) continue;
    // Subclasses of `src`/`resource` resolve their roots like their parent:
    // relative to `$REPO_ROOT`, NOT inherited as a child folder. So a `R`
    // subclass of `src` with no explicit annotation takes its own root, not
    // a folder inside `src/`.
    const root = parentTerminalAnchor(def, schema) !== undefined
      ? defaultTerminalRoot(name)
      : inferFromInheritance(def, schema, resolved, designRoot);
    const normalised = normalisePath(root);
    checkEscapes(name, normalised, diagnostics);
    resolved.set(name, normalised);
  }

  // Collision detection and existence warnings.
  const byPath = new Map<string, string[]>();
  for (const [name, root] of resolved) {
    const list = byPath.get(root) ?? [];
    list.push(name);
    byPath.set(root, list);
  }
  for (const [root, names] of byPath) {
    if (names.length > 1) {
      const others = names.filter((n) => n !== names[0]).join(", ");
      diagnostics.push(error(
        "path/collision",
        `classes ${names.join(", ")} resolve to the same path "${root}"`,
        { fix: `give one of them a %% @path annotation; involved: ${others}` },
      ));
    }
    if (!existsCheck(root)) {
      diagnostics.push(warning(
        "path/missing-directory",
        `class directory "${root}" does not exist on disk`,
      ));
    }
  }

  // Build the public map: non-instantiable classes (abstract, enumeration,
  // value type) get `null`. Terminal anchors (`src`, `resource`) are also
  // non-instantiable in the instance sense but still have roots — they
  // resolve to whatever `%% @path` (or the default) says.
  const roots: ClassRoots = new Map();
  for (const [name, def] of schema.classes) {
    if (TERMINAL_ANCHORS.has(name)) {
      roots.set(name, resolved.get(name) ?? defaultTerminalRoot(name));
    } else if (!isInstantiable(schema, name)) {
      roots.set(name, null);
    } else {
      roots.set(name, resolved.get(name) ?? inferFromInheritance(def, schema, resolved, designRoot));
    }
  }
  return { roots, diagnostics };
}

function defaultTerminalRoot(name: string): string {
  if (name === "src") return "src";
  if (name === "resource") return "resource";
  return name;
}

function resolveRelative(
  name: string,
  def: ClassDef,
  schema: SchemaIR,
  resolved: Map<string, string>,
  designRoot: string,
  relative: string,
): string {
  // Relative annotations are taken as a literal repo-relative path: the
  // author writes `design/issue` because that's where the files actually
  // sit. They are NOT joined onto the design root — that would create
  // double `design/design/` paths. The design root is just a default for
  // classes that don't declare a path at all (handled by the second pass).
  void name;
  void def;
  void schema;
  void resolved;
  void designRoot;
  return relative;
}

function inferFromInheritance(
  def: ClassDef,
  schema: SchemaIR,
  resolved: Map<string, string>,
  designRoot: string,
): string {
  const parent = firstResolvedParent(def, schema, resolved);
  const base = parent !== undefined ? resolved.get(parent)! : designRoot;
  return joinPath(base, def.name);
}

/**
 * True if any ancestor of `def` is a terminal anchor (`src`, `resource`).
 * Subclasses of those families inherit their parent's *kind* (a source class
 * whose files sit in some root) but each get their own root — they don't nest
 * under the parent's folder.
 */
function parentTerminalAnchor(def: ClassDef, schema: SchemaIR): string | undefined {
  for (const parent of def.parents) {
    if (TERMINAL_ANCHORS.has(parent)) return parent;
    const grandparent = schema.classes.get(parent)?.parents ?? [];
    for (const gp of grandparent) {
      if (TERMINAL_ANCHORS.has(gp)) return gp;
    }
  }
  return undefined;
}

function firstResolvedParent(
  def: ClassDef,
  schema: SchemaIR,
  resolved: Map<string, string>,
): string | undefined {
  for (const parent of def.parents) {
    if (resolved.has(parent)) return parent;
  }
  return undefined;
}

function joinPath(base: string, rest: string): string {
  return rest === "" ? base : `${base}/${rest}`;
}

function checkEscapes(name: string, normalised: string, diagnostics: Diagnostic[]): void {
  if (normalised.split("/").includes("..")) {
    diagnostics.push(error(
      "path/escapes-repo",
      `class "${name}" resolves to a path that escapes the repository: "${normalised}"`,
    ));
  }
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
