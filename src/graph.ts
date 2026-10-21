import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { absolute, classRootsFor, configFrom, type Config } from "./config.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { getLinksBlock, type InstanceFile, parseInstance } from "./document.ts";
import { validateInstance } from "./instance.ts";
import {
  effectiveAttributes,
  effectiveRelations,
  inReservedFamily,
  isInstantiable,
  isSubclassOf,
} from "./model/schema.ts";
import type { Cardinality, SchemaIR } from "./model/types.ts";
import { canonicalise, formatUri, parseUri } from "./uri.ts";

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
}

export interface Edge {
  from: string;
  relation: string;
  to: string;
}

export interface Graph {
  cfg: Config;
  schema: SchemaIR;
  instances: Map<string, InstanceNode>;
  edges: Edge[];
}

/**
 * Every class that can own files needs a root for canonicalisation, including
 * ones the config does not mention (plan §1.5).
 */
export function effectiveConfig(cfg: Config, schema: SchemaIR): Config {
  const classRoots = { ...cfg.classRoots };
  for (const name of schema.classes.keys()) {
    if (classRoots[name] !== undefined) continue;
    if (!isInstantiable(schema, name) && !inReservedFamily(schema, name)) continue;
    classRoots[name] = classRootsFor(cfg, name);
  }
  return configFrom(cfg.repoRoot, {
    designRoot: cfg.designRoot,
    classRoots,
    languages: cfg.languages,
  }, cfg.configPath);
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

export function loadGraph(
  rawCfg: Config,
  schema: SchemaIR,
): { graph: Graph; diagnostics: Diagnostic[] } {
  const cfg = effectiveConfig(rawCfg, schema);
  const diagnostics: Diagnostic[] = [];
  const instances = new Map<string, InstanceNode>();

  for (const [className] of schema.classes) {
    if (!isInstantiable(schema, className)) continue;

    for (const root of classRootsFor(cfg, className)) {
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
        instances.set(uri, { uri, className, id, path: repoRelative, data, file });
      }
    }
  }

  const edges: Edge[] = [];
  for (const node of instances.values()) {
    for (const relation of effectiveRelations(schema, node.className)) {
      for (const raw of asList(node.data[relation.name])) {
        if (typeof raw !== "string") continue;
        let target: string;
        try {
          const parsed = parseUri(raw);
          // Store the canonical spelling so the triple store is consistent
          // however the author wrote it.
          target = formatUri(canonicalise(resolvePath(parsed, cfg), cfg, parsed.anchor));
        } catch {
          continue; // reported by validateInstance
        }
        edges.push({ from: node.uri, relation: relation.name, to: target });
      }
    }
  }

  return { graph: { cfg, schema, instances, edges }, diagnostics };
}

function resolvePath(parsed: { scheme: string; path: string }, cfg: Config): string {
  if (parsed.scheme === "repo") return parsed.path;
  if (parsed.scheme === "design") return `${cfg.designRoot}/${parsed.path}`;
  return `${classRootsFor(cfg, parsed.scheme)[0]!}/${parsed.path}`;
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
  const targetPath = node?.path ?? resolvePath(parsed, graph.cfg);
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

export function validateGraph(graph: Graph): Diagnostic[] {
  const { cfg, schema } = graph;
  const found: Diagnostic[] = [];

  for (const node of graph.instances.values()) {
    found.push(...validateInstance(schema, cfg, {
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
          canonical = formatUri(canonicalise(resolvePath(parsed, cfg), cfg, parsed.anchor));
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
          { uri: node.uri, fix: "run `design-docs validate --fix`" },
        ));
      }
    }
  }

  for (const edge of graph.edges) {
    if (graph.instances.has(edge.to)) continue;
    const targetClass = parseUri(edge.to).scheme;

    if (isSubclassOf(schema, targetClass, "resource")) {
      if (!existsSync(absolute(cfg, resolvePath(parseUri(edge.to), cfg)))) {
        found.push(error("graph/missing-resource", `${edge.to} does not exist`, { uri: edge.from }));
      }
      continue;
    }
    // src targets resolve through the syntax tree; that is Phase 5.
    if (isSubclassOf(schema, targetClass, "src")) continue;

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

  return found;
}
