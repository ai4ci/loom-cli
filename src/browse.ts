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
    throw new LoomError(error("ls/not-found", `nothing at ${scheme}://${relative}`));
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      uri: `${scheme}://${relative === "" ? "" : `${relative}/`}${e.name}`,
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
      const anchorUri = `${uri.scheme}://${uri.path}#${a.fullName}`;
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
  // A bare `scheme://` has no path, which parseUri rejects, so handle it here.
  const bare = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/$/.exec(raw.trim());
  const scheme = bare ? bare[1]!.toLowerCase() : parseUri(raw).scheme;

  if (RESERVED_SCHEMES.has(scheme)) {
    throw new LoomError(error("ls/not-a-class", `${scheme}:// is not a class or source root`));
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
