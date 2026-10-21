import { Document } from "yaml";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Op } from "./changeset.ts";
import { absolute, classRootsFor, type Config } from "./config.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { getLinksBlock, setLinksBlock, stringifyInstance } from "./document.ts";
import {
  type Graph,
  type InstanceNode,
  loadGraph,
  rebuildEdges,
  renderLinks,
  validateGraph,
} from "./graph.ts";
import { effectiveRelations, isInstantiable } from "./model/schema.ts";
import type { SchemaIR } from "./model/types.ts";
import { formatUri, parseUri } from "./uri.ts";

export interface PendingWrite {
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
  /** Content on disk before the change, or null when the file is new. */
  before: string | null;
}

export interface MutationPlan {
  writes: PendingWrite[];
  diagnostics: Diagnostic[];
  graph: Graph;
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pathFor(cfg: Config, className: string, id: string): string {
  return `${classRootsFor(cfg, className)[0]!}/${id}`;
}

/**
 * Apply ops to the in-memory graph. Validation of the result happens in
 * `planChangeset`; nothing here touches the disk (plan §1.2).
 */
function applyOps(graph: Graph, ops: Op[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  const { cfg, schema } = graph;

  const need = (uri: string, op: string): InstanceNode | null => {
    const node = graph.instances.get(uri);
    if (!node) {
      found.push(error("changeset/not-found", `${op} refers to ${uri}, which does not exist`));
      return null;
    }
    return node;
  };

  for (const op of ops) {
    switch (op.op) {
      case "create": {
        const parsed = parseUri(op.uri);
        if (graph.instances.has(op.uri)) {
          found.push(error("changeset/already-exists", `${op.uri} already exists`));
          break;
        }
        if (!isInstantiable(schema, parsed.scheme)) {
          found.push(error("changeset/not-instantiable", `${parsed.scheme} has no instance files`));
          break;
        }
        const data = { class: parsed.scheme, id: parsed.path, ...op.attrs };
        graph.instances.set(op.uri, {
          uri: op.uri,
          className: parsed.scheme,
          id: parsed.path,
          path: pathFor(cfg, parsed.scheme, parsed.path),
          data,
          file: { frontmatter: new Document(data), markdown: "", eol: "\n" },
          source: "",
        });
        break;
      }

      case "set": {
        const node = need(op.uri, "set");
        if (!node || node.file.frontmatter === null) break;
        for (const [key, value] of Object.entries(op.attrs)) {
          node.file.frontmatter.set(key, value);
        }
        node.data = node.file.frontmatter.toJS() as Record<string, unknown>;
        break;
      }

      case "link":
      case "unlink": {
        const node = need(op.from, op.op);
        if (!node || node.file.frontmatter === null) break;
        if (!effectiveRelations(schema, node.className).some((r) => r.name === op.rel)) {
          found.push(error(
            "changeset/unknown-relation",
            `"${op.rel}" is not a relation of ${node.className}`,
          ));
          break;
        }
        const current = asList(node.data[op.rel]).filter((x) => typeof x === "string");
        const next = op.op === "link"
          ? (current.includes(op.to) ? current : [...current, op.to])
          : current.filter((x) => x !== op.to);

        if (next.length === 0) node.file.frontmatter.delete(op.rel);
        else node.file.frontmatter.set(op.rel, next);
        node.data = node.file.frontmatter.toJS() as Record<string, unknown>;
        break;
      }

      case "rename": {
        const node = need(op.from, "rename");
        if (!node) break;
        const target = parseUri(op.to);
        if (graph.instances.has(op.to)) {
          found.push(error("changeset/already-exists", `${op.to} already exists`));
          break;
        }
        if (target.scheme !== node.className) {
          found.push(error(
            "changeset/rename-across-classes",
            `cannot rename a ${node.className} to a ${target.scheme}; create and delete instead`,
          ));
          break;
        }

        graph.instances.delete(node.uri);
        const previousUri = node.uri;
        node.uri = op.to;
        node.id = target.path;
        node.path = pathFor(cfg, node.className, target.path);
        if (node.file.frontmatter?.has("id")) node.file.frontmatter.set("id", target.path);
        node.data = node.file.frontmatter?.toJS() as Record<string, unknown> ?? node.data;
        graph.instances.set(node.uri, node);

        // Every inbound reference has to follow the move.
        for (const other of graph.instances.values()) {
          if (other.file.frontmatter === null) continue;
          for (const relation of effectiveRelations(schema, other.className)) {
            const values = asList(other.data[relation.name]);
            if (!values.includes(previousUri)) continue;
            other.file.frontmatter.set(
              relation.name,
              values.map((v) => (v === previousUri ? op.to : v)),
            );
            other.data = other.file.frontmatter.toJS() as Record<string, unknown>;
          }
        }
        break;
      }

      case "delete": {
        const node = need(op.uri, "delete");
        if (node) graph.instances.delete(node.uri);
        break;
      }
    }
  }

  return found;
}

/**
 * Regenerate protected link blocks. A block that exists is kept current; a
 * newly created instance gets one when it has links. Files that never had a
 * block are left alone — `index` owns creating them.
 */
function regenerateLinks(graph: Graph): void {
  for (const node of graph.instances.values()) {
    const existing = getLinksBlock(node.file.markdown);
    const rendered = renderLinks(graph, node);
    if (existing === null && (node.source !== "" || rendered === "")) continue;
    if (existing === rendered) continue;
    node.file.markdown = setLinksBlock(node.file.markdown, rendered);
  }
}

export function planChangeset(cfg: Config, schema: SchemaIR, ops: Op[]): MutationPlan {
  const { graph, diagnostics } = loadGraph(cfg, schema);

  const before = new Map<string, string>();
  for (const node of graph.instances.values()) before.set(node.path, node.source);

  const applied = applyOps(graph, ops);
  rebuildEdges(graph);
  regenerateLinks(graph);

  const found = [...diagnostics, ...applied, ...validateGraph(graph)];
  if (found.some((d) => d.severity === "error")) return { writes: [], diagnostics: found, graph };

  const after = new Map<string, string>();
  for (const node of graph.instances.values()) after.set(node.path, stringifyInstance(node.file));

  const writes: PendingWrite[] = [];
  for (const [target, content] of after) {
    const previous = before.get(target) ?? null;
    if (previous !== content) writes.push({ path: target, content, before: previous });
  }
  for (const [target, previous] of before) {
    if (!after.has(target)) writes.push({ path: target, content: null, before: previous });
  }

  writes.sort((a, b) => a.path.localeCompare(b.path));
  return { writes, diagnostics: found, graph };
}

/**
 * Write every file via a temporary sibling, then rename them all. Validation
 * has already passed, so this is the only window in which a failure could
 * leave the tree partly updated.
 */
export function commit(cfg: Config, writes: PendingWrite[]): string[] {
  const staged: { temp: string; target: string }[] = [];

  for (const write of writes) {
    if (write.content === null) continue;
    const target = absolute(cfg, write.path);
    mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.design-docs-tmp`;
    writeFileSync(temp, write.content);
    staged.push({ temp, target });
  }

  for (const { temp, target } of staged) renameSync(temp, target);
  for (const write of writes) {
    if (write.content === null) rmSync(absolute(cfg, write.path), { force: true });
  }

  return writes.map((w) => w.path);
}

/** Current on-disk content, for diffing a plan that has not been committed. */
export function currentContent(cfg: Config, repoRelative: string): string | null {
  try {
    return readFileSync(absolute(cfg, repoRelative), "utf8");
  } catch {
    return null;
  }
}
