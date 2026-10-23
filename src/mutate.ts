import { Document } from "yaml";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Op } from "./changeset.ts";
import { absolute, type Config } from "./config.ts";
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
import { effectiveRelations, isInstantiable, isSubclassOf } from "./model/schema.ts";
import type { SchemaIR } from "./model/types.ts";
import { applyEdits, type AnnotationRequest, planAnnotations, verify } from "./annotate.ts";
import { classRoot, type ClassRoots } from "./path-resolution.ts";
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

function pathFor(roots: ClassRoots, className: string, id: string): string {
  const root = classRoot(roots, className);
  return root === "" ? id : `${root}/${id}`;
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
          path: pathFor(graph.roots, parsed.scheme, parsed.path),
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
        node.path = pathFor(graph.roots, node.className, target.path);
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

/** A link whose subject is source code is written as a comment, not as yaml. */
function isSourceLink(op: Op, schema: SchemaIR): boolean {
  if (op.op !== "link" && op.op !== "unlink") return false;
  try {
    return isSubclassOf(schema, parseUri(op.from).scheme, "src");
  } catch {
    return false;
  }
}

export function planChangeset(cfg: Config, schema: SchemaIR, roots: ClassRoots, ops: Op[]): MutationPlan {
  const { graph, diagnostics } = loadGraph(cfg, schema, roots);

  const before = new Map<string, string>();
  for (const node of graph.instances.values()) before.set(node.path, node.source);

  const sourceOps = ops.filter((op) => isSourceLink(op, schema));
  const applied = applyOps(graph, ops.filter((op) => !isSourceLink(op, schema)));
  rebuildEdges(graph);
  regenerateLinks(graph);

  const annotation = planSourceLinks(cfg, graph, sourceOps);

  const found = [...diagnostics, ...applied, ...annotation.diagnostics, ...validateGraph(graph)];
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

  writes.push(...annotation.writes);
  writes.sort((a, b) => a.path.localeCompare(b.path));
  return { writes, diagnostics: found, graph };
}

/**
 * Resolve source-side links into file writes: one parse per file, every
 * insertion point taken against the original buffer, edits applied descending
 * by offset, then the result re-parsed to confirm it still parses and that the
 * link attached where it was meant to (source-linkage §4.6).
 */
function planSourceLinks(
  cfg: Config,
  graph: Graph,
  ops: Op[],
): { writes: PendingWrite[]; diagnostics: Diagnostic[] } {
  if (ops.length === 0) return { writes: [], diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const requests: AnnotationRequest[] = [];

  for (const op of ops) {
    if (op.op !== "link" && op.op !== "unlink") continue;
    const subject = parseUri(op.from).scheme;

    if (!effectiveRelations(graph.schema, subject).some((r) => r.name === op.rel)) {
      diagnostics.push(error(
        "changeset/unknown-relation",
        `"${op.rel}" is not a relation of ${subject}; a link written in source runs from the code to the document`,
      ));
      continue;
    }
    if (!graph.instances.has(op.to)) {
      diagnostics.push(error(
        "changeset/not-found",
        `${op.op} refers to ${op.to}, which does not exist`,
      ));
      continue;
    }

    requests.push({
      from: op.from,
      relation: op.rel,
      to: op.to,
      ...(op.op === "unlink" ? { remove: true } : {}),
      ...(op.line === undefined ? {} : { line: op.line }),
    });
  }

  const planned = planAnnotations(cfg, graph.roots, requests, cfg.anchorPolicy, (p) =>
    readFileSync(absolute(cfg, p), "utf8"));
  diagnostics.push(...planned.diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) return { writes: [], diagnostics };

  const writes: PendingWrite[] = [];
  const byFile = new Map<string, typeof planned.edits>();
  for (const edit of planned.edits) {
    const list = byFile.get(edit.path) ?? [];
    list.push(edit);
    byFile.set(edit.path, list);
  }

  for (const [target, edits] of byFile) {
    const source = readFileSync(absolute(cfg, target), "utf8");
    const written = applyEdits(source, edits);
    if (written === source) continue;

    const expected = edits
      .filter((e) => e.removeBytes === undefined)
      .map((e) => ({ relation: e.relation, target: e.target, anchor: e.anchor }));
    const problems = verify(source, written, edits[0]!.language, cfg.anchorPolicy, expected);
    if (problems.length > 0) {
      diagnostics.push(...problems);
      return { writes: [], diagnostics };
    }

    writes.push({ path: target, content: written, before: source });
  }

  return { writes, diagnostics };
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
    const temp = `${target}.loom-tmp`;
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
