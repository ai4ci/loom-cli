import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isScalar, isSeq } from "yaml";
import { absolute } from "./config.ts";
import { contentAtHead, inferRename } from "./drift.ts";
import { isSubclassOf } from "./model/schema.ts";
import { detectLang, extractAnchors, resolveAnchor } from "./source.ts";
import { resolvePath } from "./graph.ts";
import { getLinksBlock, setLinksBlock, stringifyInstance } from "./document.ts";
import { type Graph, type InstanceNode, renderLinks } from "./graph.ts";
import { effectiveRelations } from "./model/schema.ts";
import { classRoot } from "./path-resolution.ts";
import { canonicalise, formatUri, parseUri } from "./uri.ts";

/**
 * Only the unambiguous repairs (plan §Phase 2): regenerate a link block that
 * disagrees with the yaml, and rewrite a uri that is not in its compact form.
 * Anything needing a judgement call is reported instead.
 */
export function applyFixes(graph: Graph): string[] {
  const changed: string[] = [];
  const renames = inferredRenames(graph);

  for (const node of graph.instances.values()) {
    let touched = rewriteRenamedAnchors(graph, node, renames);
    touched = canonicaliseUris(graph, node) || touched;
    touched = regenerateLinks(graph, node) || touched;
    if (!touched) continue;

    writeFileSync(absolute(graph.cfg, node.path), stringifyInstance(node.file));
    changed.push(node.path);
  }

  return changed.sort();
}

/**
 * Anchors whose declaration was renamed since HEAD, old uri to new
 * (source-linkage §6.2). Only unambiguous, high-confidence matches appear here;
 * anything else is reported rather than rewritten.
 */
function inferredRenames(graph: Graph): Map<string, string> {
  const renames = new Map<string, string>();
  const parsedFiles = new Map<string, { code: string; previous: string | null; lang: string } | null>();

  for (const edge of graph.edges) {
    let parsed;
    try {
      parsed = parseUri(edge.to);
    } catch {
      continue;
    }
    if (parsed.anchor === undefined) continue;
    if (!isSubclassOf(graph.schema, parsed.scheme, "src")) continue;

    const repoRelative = resolvePath(parsed, graph.roots);
    let file = parsedFiles.get(repoRelative);
    if (file === undefined) {
      const lang = detectLang(repoRelative);
      const full = absolute(graph.cfg, repoRelative);
      file = lang === null || !existsSync(full)
        ? null
        : { code: readFileSync(full, "utf8"), previous: contentAtHead(graph.cfg, repoRelative), lang };
      parsedFiles.set(repoRelative, file);
    }
    if (file === null || file.previous === null) continue;

    const resolved = resolveAnchor(
      extractAnchors(file.code, file.lang, graph.cfg.anchorPolicy),
      parsed.anchor,
    );
    if (resolved.ok) continue;

    const renamed = inferRename(
      file.previous, file.code, file.lang, graph.cfg.anchorPolicy, parsed.anchor,
    );
    if (renamed === null) continue;

    renames.set(edge.to, formatUri({ ...parsed, anchor: renamed.to }));
  }

  return renames;
}

function rewriteRenamedAnchors(
  graph: Graph,
  node: InstanceNode,
  renames: Map<string, string>,
): boolean {
  const doc = node.file.frontmatter;
  if (doc === null || renames.size === 0) return false;

  let touched = false;
  for (const relation of effectiveRelations(graph.schema, node.className)) {
    const value = doc.get(relation.name, true);
    const items = isSeq(value) ? value.items : [value];
    for (const item of items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const replacement = renames.get(item.value);
      if (replacement !== undefined) {
        item.value = replacement;
        touched = true;
      }
    }
  }

  if (touched) node.data = doc.toJS() as Record<string, unknown>;
  return touched;
}

function compactForm(raw: string, graph: Graph): string | null {
  try {
    const parsed = parseUri(raw);
    // Unknown classes (or `design://`, which isn't a real class) fall back to
    // the repo-relative interpretation, which canonicalise() can then collapse
    // to the right class scheme if a class root happens to match.
    const repoRelative = parsed.scheme === "repo" || !graph.roots.has(parsed.scheme)
      ? (parsed.scheme === "repo" ? parsed.path : `${parsed.scheme}/${parsed.path}`)
      : `${classRoot(graph.roots, parsed.scheme)}/${parsed.path}`;
    return formatUri(canonicalise(repoRelative, graph.roots, parsed.anchor));
  } catch {
    return null;
  }
}

/** Rewrite scalar values in place so comments and key order survive. */
function canonicaliseUris(graph: Graph, node: InstanceNode): boolean {
  const doc = node.file.frontmatter;
  if (doc === null) return false;

  let touched = false;
  for (const relation of effectiveRelations(graph.schema, node.className)) {
    const value = doc.get(relation.name, true);
    const items = isSeq(value) ? value.items : [value];

    for (const item of items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const compact = compactForm(item.value, graph);
      if (compact !== null && compact !== item.value) {
        item.value = compact;
        touched = true;
      }
    }
  }

  if (touched) node.data = doc.toJS() as Record<string, unknown>;
  return touched;
}

function regenerateLinks(graph: Graph, node: InstanceNode): boolean {
  const existing = getLinksBlock(node.file.markdown);
  if (existing === null) return false; // never generated; `index` owns creation

  const expected = renderLinks(graph, node);
  if (existing === expected) return false;

  node.file.markdown = setLinksBlock(node.file.markdown, expected);
  return true;
}
