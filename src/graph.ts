import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { absolute, type Config } from "./config.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { getLinksBlock, type InstanceFile, parseInstance } from "./document.ts";
import {
  type AnchorPolicy,
  detectLang,
  extractAnchors,
  extractReverseLinks,
  resolveAnchor,
} from "./source.ts";
import { validateInstance } from "./instance.ts";
import {
  effectiveAttributes,
  effectiveRelations,
  inReservedFamily,
  isInstantiable,
  isSubclassOf,
} from "./model/schema.ts";
import type { Cardinality, SchemaIR } from "./model/types.ts";
import { classRoot, type ClassRoots } from "./path-resolution.ts";
import { contentAtHead, inferRename } from "./drift.ts";
import { similarity } from "./similarity.ts";
import { canonicalise, formatUri, parseUri, resolveUri } from "./uri.ts";

export interface InstanceNode {
  /** Canonical uri, e.g. `issue://a.md`. */
  uri: string;
  className: string;
  /** Instance id: the path relative to the class root. */
  id: string;
  /** Repo-relative path of the file. */
  path: string;
  data: Record<string, unknown>;
  file: InstanceFile;
  /** File content as read, so a mutation can tell what actually changed. */
  source: string;
}

export interface Edge {
  from: string;
  relation: string;
  to: string;
}

export interface Graph {
  cfg: Config;
  schema: SchemaIR;
  roots: ClassRoots;
  instances: Map<string, InstanceNode>;
  edges: Edge[];
}

/**
 * Load every instance file and the edges between them. Class roots come from
 * the schema (resolved by `path-resolution.ts`), not the config.
 */
export function loadGraph(
  cfg: Config,
  schema: SchemaIR,
  roots: ClassRoots,
): { graph: Graph; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const instances = new Map<string, InstanceNode>();

  for (const [className] of schema.classes) {
    if (!isInstantiable(schema, className)) continue;
    const root = classRoot(roots, className);
    if (root === "") continue;

    for (const absolutePath of markdownFilesUnder(cfg, root)) {
      const repoRelative = toRepoRelative(cfg, absolutePath);
      const file = parseInstance(readFileSync(absolutePath, "utf8"));
      const data = file.frontmatter?.toJS() as Record<string, unknown> | undefined;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        diagnostics.push(error(
          "graph/orphan-file",
          `${repoRelative} sits under the ${className} root but has no frontmatter`,
          { fix: "add a yaml header, or move the file outside the class root" },
        ));
        continue;
      }

      const id = repoRelative.slice(root.length + 1);
      const uri = formatUri({ scheme: className, path: id });
      instances.set(uri, {
        uri,
        className,
        id,
        path: repoRelative,
        data,
        file,
        source: readFileSync(absolutePath, "utf8"),
      });
    }
  }

  const graph: Graph = { cfg, schema, roots, instances, edges: [] };
  rebuildEdges(graph);
  return { graph, diagnostics };
}

/** Recompute the triples from the yaml. Call after any in-memory mutation. */
export function rebuildEdges(graph: Graph): void {
  const edges: Edge[] = [];
  for (const node of graph.instances.values()) {
    for (const relation of effectiveRelations(graph.schema, node.className)) {
      for (const raw of asList(node.data[relation.name])) {
        if (typeof raw !== "string") continue;
        try {
          const parsed = parseUri(raw);
          // Store the canonical spelling so the triple store is consistent
          // however the author wrote it.
          edges.push({
            from: node.uri,
            relation: relation.name,
            to: formatUri(canonicalise(resolveUri(parsed, graph.roots).path, graph.roots, parsed.anchor)),
          });
        } catch {
          // reported by validateInstance
        }
      }
    }
  }
  graph.edges = edges;
}

/** Resolve a URI to a repo-relative path using the loaded roots. */
export function resolvePath(parsed: { scheme: string; path: string }, roots: ClassRoots): string {
  return resolveUri(parsed, roots).path;
}

/** Repo-relative path for a class, or empty string when the class is non-instantiable. */
export function rootFor(graph: Graph, className: string): string {
  return classRoot(graph.roots, className);
}

function titleOf(graph: Graph, uri: string): string {
  const node = graph.instances.get(uri);
  const title = node?.data["title"];
  if (typeof title === "string" && title !== "") return title;
  return parseUri(uri).path;
}

function relativeLink(graph: Graph, fromPath: string, targetUri: string): string {
  const node = graph.instances.get(targetUri);
  const parsed = parseUri(targetUri);
  const targetPath = node?.path ?? resolveUri(parsed, graph.roots).path;
  return path.posix.relative(path.posix.dirname(fromPath), targetPath);
}

const byRelationThenTarget = (a: Edge, b: Edge): number =>
  a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to);

/**
 * The protected link block: outbound links, then inbound ones labelled with
 * the forward relation name (plan §2.2). Deterministically ordered so
 * regeneration never churns the diff.
 */
export function renderLinks(graph: Graph, node: InstanceNode): string {
  const line = (edge: Edge, otherUri: string): string =>
    `- ${edge.relation}: [${titleOf(graph, otherUri)}](${relativeLink(graph, node.path, otherUri)})`;

  const outbound = graph.edges
    .filter((e) => e.from === node.uri)
    .sort(byRelationThenTarget)
    .map((e) => line(e, e.to));

  const inbound = graph.edges
    .filter((e) => e.to === node.uri)
    .sort((a, b) => a.relation.localeCompare(b.relation) || a.from.localeCompare(b.from))
    .map((e) => line(e, e.from));

  if (inbound.length === 0) return outbound.join("\n");
  const backlinks = ["### Backlinks", ...inbound];
  return outbound.length === 0
    ? backlinks.join("\n")
    : [...outbound, "", ...backlinks].join("\n");
}

/**
 * Drift tier 1 (source-linkage §6.1): a dead anchor is much more useful with a
 * candidate attached than without one.
 */
function suggestNearest(
  code: string,
  language: string,
  wanted: string,
  policy: AnchorPolicy,
): { fix?: string } {
  const target = (wanted.split(".").pop() ?? wanted).toLowerCase();
  const ranked = extractAnchors(code, language, policy)
    .map((a) => ({ name: a.fullName, score: similarity(target, a.name.toLowerCase()) }))
    .filter((c) => c.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (ranked.length === 0) return {};
  return { fix: `did you mean ${ranked.map((c) => c.name).join(" | ")}?` };
}

export function validateGraph(graph: Graph): Diagnostic[] {
  const { cfg, schema } = graph;
  const found: Diagnostic[] = [];

  for (const node of graph.instances.values()) {
    found.push(...validateInstance(schema, {
      uri: node.uri,
      className: node.className,
      data: node.data,
    }));

    // `path` attributes must point at files that exist.
    for (const attribute of effectiveAttributes(schema, node.className)) {
      if (attribute.type.kind !== "primitive" || attribute.type.name !== "path") continue;
      for (const value of asList(node.data[attribute.name])) {
        if (typeof value !== "string") continue;
        if (!existsSync(absolute(cfg, value))) {
          found.push(error(
            "graph/missing-path",
            `"${attribute.name}" points at ${value}, which does not exist`,
            { uri: node.uri },
          ));
        }
      }
    }

    // Spellings that are not the most compact form are fixable in place.
    for (const relation of effectiveRelations(schema, node.className)) {
      for (const raw of asList(node.data[relation.name])) {
        if (typeof raw !== "string") continue;
        let canonical: string;
        try {
          const parsed = parseUri(raw);
          canonical = formatUri(canonicalise(resolveUri(parsed, graph.roots).path, graph.roots, parsed.anchor));
        } catch {
          continue;
        }
        if (canonical !== raw) {
          found.push(error(
            "graph/non-canonical-uri",
            `"${relation.name}" uses ${raw}, whose compact form is ${canonical}`,
            { uri: node.uri, fix: `rewrite as ${canonical}` },
          ));
        }
      }
    }

    // A block that is present but wrong is actively misleading. A block that
    // is absent simply has not been generated yet, which `index` handles.
    const existing = getLinksBlock(node.file.markdown);
    if (existing !== null) {
      const expected = renderLinks(graph, node);
      if (existing !== expected) {
        found.push(error(
          "graph/stale-links",
          "the protected link block disagrees with the yaml",
          { uri: node.uri, fix: "run `loom validate --fix`" },
        ));
      }
    }
  }

  for (const edge of graph.edges) {
    if (graph.instances.has(edge.to)) continue;
    const targetClass = parseUri(edge.to).scheme;

    if (isSubclassOf(schema, targetClass, "resource")) {
      if (!existsSync(absolute(cfg, resolveUri(parseUri(edge.to), graph.roots).path))) {
        found.push(error("graph/missing-resource", `${edge.to} does not exist`, { uri: edge.from }));
      }
      continue;
    }
    // src targets resolve through the syntax tree (Phase 5).
    if (isSubclassOf(schema, targetClass, "src")) {
      const parsed = parseUri(edge.to);
      const res = resolveUri(parsed, graph.roots).path;
      const abs = absolute(cfg, res);
      if (!existsSync(abs)) {
        found.push(error("graph/missing-source-file", `${edge.to} does not exist`, { uri: edge.from }));
      } else if (parsed.anchor) {
        const lang = detectLang(res);
        if (lang) {
          const code = readFileSync(abs, "utf8");
          const resolved = resolveAnchor(extractAnchors(code, lang, cfg.anchorPolicy), parsed.anchor);
          if (!resolved.ok && resolved.reason === "ambiguous") {
            found.push(error(
              "source/ambiguous-anchor",
              `"${parsed.anchor}" matches several declarations in ${res}`,
              { uri: edge.from, fix: `qualify it: ${resolved.candidates.join(" | ")}` },
            ));
          } else if (!resolved.ok) {
            // Tier 2 first: a rename inferred from HEAD is a repair, not a guess.
            const previous = contentAtHead(cfg, res);
            const renamed = previous === null
              ? null
              : inferRename(previous, code, lang, cfg.anchorPolicy, parsed.anchor);

            if (renamed !== null) {
              const to = formatUri({ scheme: parsed.scheme, path: parsed.path, anchor: renamed.to });
              found.push(error(
                "graph/renamed-symbol",
                `"${parsed.anchor}" appears to have been renamed to "${renamed.to}" in ${res}`,
                { uri: edge.from, fix: `rewrite as ${to}` },
              ));
            } else {
              found.push(error(
                "graph/missing-symbol",
                `symbol "${parsed.anchor}" not found in ${res}`,
                { uri: edge.from, ...suggestNearest(code, lang, parsed.anchor, cfg.anchorPolicy) },
              ));
            }
          }
        }
      }
      continue;
    }

    found.push(error(
      "graph/dangling-link",
      `"${edge.relation}" points at ${edge.to}, which has no instance file`,
      { uri: edge.from },
    ));
  }

  // Inbound cardinality: how many sources may point at one target.
  for (const relation of schema.relations) {
    for (const node of graph.instances.values()) {
      if (!isSubclassOf(schema, node.className, relation.to)) continue;
      const inbound = graph.edges.filter(
        (e) => e.relation === relation.name && e.to === node.uri,
      ).length;
      if (!withinCardinality(inbound, relation.fromCardinality)) {
        const { min, max } = relation.fromCardinality;
        found.push(error(
          "graph/inbound-cardinality",
          `${inbound} instance(s) point at ${node.uri} via "${relation.name}", model allows ${min}..${max ?? "*"}`,
          { uri: node.uri, line: relation.line },
        ));
      }
    }
  }

  // Scan source files for reverse-link comments (plan §Phase 5)
  for (const [name] of schema.classes) {
    if (!isSubclassOf(schema, name, "src")) continue;
    const root = classRoot(graph.roots, name);
    if (root === "") continue;
    const absRoot = absolute(cfg, root);
    if (!existsSync(absRoot)) continue;
    scanSourceTree(cfg, absRoot, (rel, lang, code) => {
      for (const rl of extractReverseLinks(code, lang, cfg.anchorPolicy)) {
        if (!graph.instances.has(rl.target)) {
          found.push(error(
            "source/dangling-reverse-link",
            `comment points to non-existent ${rl.target}`,
            { uri: `${name}://${rel}`, line: rl.line },
          ));
        }
        if (!schema.relations.some((r) => r.name === rl.relation && isSubclassOf(schema, name, r.from))) {
          found.push(error(
            "source/invalid-reverse-relation",
            `relation "${rl.relation}" is not permitted from ${name}`,
            { uri: `${name}://${rel}`, line: rl.line },
          ));
        }
      }
    });
  }

  return found;
}

function scanSourceTree(
  cfg: Config,
  dir: string,
  visit: (repoRelative: string, lang: string, code: string) => void,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanSourceTree(cfg, full, visit);
    else if (entry.isFile()) {
      const lang = detectLang(full);
      if (!lang) continue;
      const code = readFileSync(full, "utf8");
      const rel = path.relative(cfg.repoRoot, full).split(path.sep).join("/");
      visit(rel, lang, code);
    }
  }
}

function markdownFilesUnder(cfg: Config, root: string): string[] {
  const start = absolute(cfg, root);
  if (!existsSync(start) || !statSync(start).isDirectory()) return [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
    }
  };
  walk(start);
  return found.sort();
}

function toRepoRelative(cfg: Config, absolutePath: string): string {
  return path.relative(cfg.repoRoot, absolutePath).split(path.sep).join("/");
}

/** Relation values accept a single uri or a list of them. */
function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function withinCardinality(count: number, cardinality: Cardinality): boolean {
  if (count < cardinality.min) return false;
  return cardinality.max === null || count <= cardinality.max;
}
