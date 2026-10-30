import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { absolute, RESERVED_SCHEMES, type Config } from "./config.ts";
import { LoomError, error } from "./diagnostics.ts";
import { type Graph } from "./graph.ts";
import { isInstantiable } from "./model/schema.ts";
import { classRoot } from "./path-resolution.ts";
import { type Anchor, detectLang, extractAnchors } from "./source.ts";
import { formatUri, parseUri, type ParsedUri } from "./uri.ts";

/**
 * Discovery over the uri space (source-linkage §3). A uri path and its
 * `#anchor` are one hierarchy, so listing is directory descent and needs no
 * mode switch.
 */

export interface ListEntry {
  uri: string;
  kind: string;
  line?: number;
  signature?: string;
  title?: string;
  children?: number;
  linked?: boolean;
}

export interface ListOptions {
  depth?: number;
  kinds?: string[];
  linked?: boolean;
  unlinked?: boolean;
}

function targetsOf(graph: Graph): Set<string> {
  return new Set(graph.edges.map((e) => e.to));
}

/** Anchors below `prefix`, at most `depth` levels deeper. */
function descend(anchors: Anchor[], prefix: string, depth: number): Anchor[] {
  return anchors.filter((a) => {
    if (prefix === "") return a.fullName.split(".").length <= depth;
    if (!a.fullName.startsWith(`${prefix}.`)) return false;
    const rest = a.fullName.slice(prefix.length + 1);
    return rest.split(".").length <= depth;
  });
}

function listInstances(cfg: Config, graph: Graph, className: string): ListEntry[] {
  return [...graph.instances.values()]
    .filter((n) => n.className === className)
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map((n) => {
      const entry: ListEntry = { uri: n.uri, kind: className };
      const title = n.data["title"];
      if (typeof title === "string") entry.title = title;
      return entry;
    });
}

function listDirectory(cfg: Config, scheme: string, root: string, relative: string): ListEntry[] {
  const dir = absolute(cfg, relative === "" ? root : `${root}/${relative}`);
  if (!existsSync(dir)) {
    throw new LoomError(error("ls/not-found", `nothing at ${scheme}:${relative}`));
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      uri: `${scheme}:${relative === "" ? "" : `${relative}/`}${e.name}`,
      kind: e.isDirectory() ? "Directory" : "File",
    }));
}

function listAnchors(
  cfg: Config,
  graph: Graph,
  uri: ParsedUri,
  filePath: string,
  options: ListOptions,
): ListEntry[] {
  const language = detectLang(filePath);
  if (language === null) {
    throw new LoomError(error(
      "source/unsupported-language",
      `no structure available for ${filePath}`,
    ));
  }

  const code = readFileSync(absolute(cfg, filePath), "utf8");
  const anchors = extractAnchors(code, language, cfg.anchorPolicy);
  const prefix = uri.anchor ?? "";
  const linkedTargets = targetsOf(graph);

  const childCount = (a: Anchor) =>
    anchors.filter((other) => other.fullName.startsWith(`${a.fullName}.`)
      && other.fullName.slice(a.fullName.length + 1).split(".").length === 1).length;

  return descend(anchors, prefix, options.depth ?? 1)
    .filter((a) => options.kinds === undefined || options.kinds.includes(a.kind))
    .map((a) => {
      const anchorUri = `${uri.scheme}:${uri.path}#${a.fullName}`;
      const entry: ListEntry = {
        uri: anchorUri,
        kind: a.kind,
        line: a.line,
        children: childCount(a),
        linked: linkedTargets.has(anchorUri),
      };
      return entry;
    });
}

export function listUri(cfg: Config, graph: Graph, raw: string, options: ListOptions): {
  parent: string;
  entries: ListEntry[];
} {
  // A bare `scheme:` has no path, which parseUri rejects, so handle it here.
  // The legacy two-slash form is accepted too.
  const bare = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/)?$/.exec(raw.trim());
  const scheme = bare ? bare[1]!.toLowerCase() : parseUri(raw).scheme;

  if (RESERVED_SCHEMES.has(scheme)) {
    throw new LoomError(error("ls/not-a-class", `${scheme}: is not a class or source root`));
  }

  const isSource = !isInstantiable(graph.schema, scheme);
  if (bare) {
    const entries = isSource
      ? listDirectory(cfg, scheme, classRoot(graph.roots, scheme), "")
      : listInstances(cfg, graph, scheme);
    return { parent: raw, entries: applyLinkFilters(entries, options) };
  }

  const uri = parseUri(raw);
  const root = classRoot(graph.roots, uri.scheme);
  const relative = root === "" ? uri.path : `${root}/${uri.path}`;
  const full = absolute(cfg, relative);

  if (!isSource) {
    throw new LoomError(error(
      "ls/not-a-directory",
      `${raw} is an instance; use \`show\` to read it`,
    ));
  }
  if (!existsSync(full)) {
    throw new LoomError(error("ls/not-found", `nothing at ${raw}`));
  }
  if (statSync(full).isDirectory()) {
    return {
      parent: raw,
      entries: applyLinkFilters(listDirectory(cfg, uri.scheme, root, uri.path), options),
    };
  }

  return {
    parent: raw,
    entries: applyLinkFilters(listAnchors(cfg, graph, uri, relative, options), options),
  };
}

function applyLinkFilters(entries: ListEntry[], options: ListOptions): ListEntry[] {
  if (options.linked) return entries.filter((e) => e.linked === true);
  if (options.unlinked) return entries.filter((e) => e.linked !== true);
  return entries;
}

/**
 * Recursive discovery (unlike `ls`, which lists one level). Walks the
 * filesystem below a source directory, extracting anchors for every code file;
 * steps into a limited number of anchor levels so `Class -> Method` shows a
 * class's methods but a method (nothing below it) stops the walk.
 */
export function findUri(cfg: Config, graph: Graph, raw: string, options: ListOptions): {
  parent: string;
  entries: ListEntry[];
} {
  const bare = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?$/.exec(raw.trim());
  const scheme = bare ? bare[1]!.toLowerCase() : parseUri(raw).scheme;
  const isSource = !isInstantiable(graph.schema, scheme);

  // A class (or its instance space) has no children to recurse into.
  if (bare && !isSource) {
    return { parent: raw, entries: applyLinkFilters(listInstances(cfg, graph, scheme), options) };
  }

  // A bare `scheme:` cannot go through parseUri (it rejects the empty path),
  // so build the parsed shape directly.
  const uri = bare ? ({ scheme, path: "" } as ParsedUri) : parseUri(raw);
  const root = classRoot(graph.roots, uri.scheme);
  const relative = root === "" ? uri.path : uri.path === "" ? root : `${root}/${uri.path}`;
  const full = absolute(cfg, relative);

  if (!isSource) {
    throw new LoomError(error("ls/not-a-directory", `${raw} is an instance; use ` + "`show`" + ` to read it`));
  }
  if (!existsSync(full)) {
    throw new LoomError(error("ls/not-found", `nothing at ${raw}`));
  }

  const maxDepth = options.depth ?? Infinity;

  if (statSync(full).isFile()) {
    return { parent: raw, entries: findUriAnchors(cfg, graph, uri, relative, options) };
  }

  const entries: ListEntry[] = [];
  findDirectory(cfg, graph, uri.scheme, relative, root, 0, maxDepth, options, entries);
  entries.sort((a, b) => a.uri.localeCompare(b.uri));
  return { parent: raw, entries: applyLinkFilters(entries, options) };
}

/** Anchor walk within one file: `depth` counts anchor levels below the uri. */
function findUriAnchors(
  cfg: Config,
  graph: Graph,
  uri: ParsedUri,
  filePath: string,
  options: ListOptions,
): ListEntry[] {
  const anchors = extractAnchors(readFileSync(absolute(cfg, filePath), "utf8"),
    detectLang(filePath) ?? ((): never => { throw new LoomError(error("source/unsupported-language", `no structure available for ${filePath}`)); })(),
    cfg.anchorPolicy);
  const prefix = uri.anchor ?? "";
  const linkedTargets = targetsOf(graph);
  const childrenOf = (fullName: string) => anchors.filter((a) =>
    a.fullName.startsWith(`${fullName}.`));
  const anchorUri = (a: Anchor) => `${uri.scheme}:${uri.path}#${a.fullName}`;

  const maxSteps = options.depth ?? Infinity;
  const result: ListEntry[] = [];
  // Breadth-first: top-level anchors before their children, so the top of the
  // tree is always visible regardless of depth.
  const level = (a: Anchor) =>
    prefix === "" ? a.fullName.split(".").length : a.fullName.slice(prefix.length + 1).split(".").length;
  const deepest = Math.max(0, ...anchors.map((a) => level(a)));
  for (let step = 1; step <= Math.min(maxSteps, deepest); step++) {
    for (const a of anchors) {
      if (level(a) !== step) continue;
      if (prefix !== "" && !a.fullName.startsWith(`${prefix}.`)) continue;
      if (options.kinds !== undefined && !options.kinds.includes(a.kind)) continue;
      result.push({
        uri: `${uri.scheme}:${uri.path}#${a.fullName}`,
        kind: a.kind,
        line: a.line,
        children: childrenOf(a.fullName).length,
        linked: linkedTargets.has(anchorUri(a)),
      });
    }
  }
  return result;
}

/** Directory walk: every code file contributes its anchor tree, other files nothing. */
function findDirectory(
  cfg: Config,
  graph: Graph,
  scheme: string,
  repoRelative: string,
  base: string,
  level: number,
  maxDepth: number,
  options: ListOptions,
  out: ListEntry[],
): void {
  const dir = absolute(cfg, repoRelative);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = `${repoRelative}/${entry.name}`;
    // Uri paths are relative to the class root, not to the walk start.
    const childUriPath = childRelative.slice(base === "" ? 0 : base.length + 1);

    const keep = options.kinds === undefined
      ? true
      : entry.isDirectory() ? options.kinds.includes("Directory") : options.kinds.includes("File");
    const childEntry: ListEntry = {
      uri: `${scheme}:${childUriPath}`,
      kind: entry.isDirectory() ? "Directory" : "File",
    };

    if (entry.isDirectory()) {
      if (keep) out.push(childEntry);
      if (level + 1 < maxDepth) {
        findDirectory(cfg, graph, scheme, childRelative, base, level + 1, maxDepth, options, out);
      }
      continue;
    }

    if (keep) out.push(childEntry);
    if (detectLang(entry.name) === null) continue;
    // Anchor steps left for a file `level` directories below the walk start:
    // the file itself is one level, so the boundary file gets none.
    const steps = maxDepth === Infinity ? Infinity : maxDepth - (level + 1);
    if (steps < 1) continue;
    const fileUri = `${scheme}:${childUriPath}`;
    const anchors = extractAnchors(
      readFileSync(absolute(cfg, childRelative), "utf8"),
      detectLang(entry.name)!,
      cfg.anchorPolicy,
    );
    const linkedTargets = targetsOf(graph);
    for (const a of anchors) {
      if (a.fullName.split(".").length > steps) continue;
      if (options.kinds !== undefined && !options.kinds.includes(a.kind)) continue;
      const anchorUri = `${fileUri}#${a.fullName}`;
      out.push({
        uri: anchorUri,
        kind: a.kind,
        line: a.line,
        children: anchors.filter((other) => other.fullName.startsWith(`${a.fullName}.`)).length,
        linked: linkedTargets.has(anchorUri),
      });
    }
  }
}

// --- locate ----------------------------------------------------------------

export interface Located {
  path: string;
  line: number;
  anchor: (ListEntry & { span: { startLine: number; endLine: number } }) | null;
  ancestors: { uri: string; kind: string }[];
}

/**
 * The address of a line: the innermost linkable ancestor, plus the chain so a
 * caller wanting something coarser can take it. A line with no linkable
 * ancestor reports the file rather than inventing a node.
 */
export function locateLine(cfg: Config, roots: import("./path-resolution.ts").ClassRoots, raw: string, line: number): Located {
  const uri = parseUri(raw);
  const root = classRoot(roots, uri.scheme);
  const relative = root === "" ? uri.path : `${root}/${uri.path}`;
  const full = absolute(cfg, relative);

  if (!existsSync(full)) {
    throw new LoomError(error("ls/not-found", `nothing at ${raw}`));
  }
  const language = detectLang(relative);
  if (language === null) {
    throw new LoomError(error(
      "source/unsupported-language",
      `no structure available for ${relative}`,
    ));
  }

  const code = readFileSync(full, "utf8");
  const anchors = extractAnchors(code, language, cfg.anchorPolicy);
  const fileUri = formatUri({ scheme: uri.scheme, path: uri.path });

  const containing = anchors
    .filter((a) => (a.span.startLine ?? 0) + 1 <= line && line <= (a.span.endLine ?? 0) + 1)
    .sort((a, b) => (b.span.startByte ?? 0) - (a.span.startByte ?? 0));

  const innermost = containing[0];
  const ancestors = containing.slice(1).map((a) => ({
    uri: `${fileUri}#${a.fullName}`,
    kind: a.kind,
  }));
  ancestors.push({ uri: fileUri, kind: "File" });

  return {
    path: relative,
    line,
    anchor: innermost === undefined ? null : {
      uri: `${fileUri}#${innermost.fullName}`,
      kind: innermost.kind,
      line: innermost.line,
      span: {
        startLine: (innermost.span.startLine ?? 0) + 1,
        endLine: (innermost.span.endLine ?? 0) + 1,
      },
    },
    ancestors,
  };
}
