import { writeFileSync } from "node:fs";
import { isScalar, isSeq } from "yaml";
import { absolute } from "./config.ts";
import { getLinksBlock, setLinksBlock, stringifyInstance } from "./document.ts";
import { type Graph, type InstanceNode, renderLinks } from "./graph.ts";
import { effectiveRelations } from "./model/schema.ts";
import { canonicalise, formatUri, parseUri } from "./uri.ts";
import { classRootsFor } from "./config.ts";

/**
 * Only the unambiguous repairs (plan §Phase 2): regenerate a link block that
 * disagrees with the yaml, and rewrite a uri that is not in its compact form.
 * Anything needing a judgement call is reported instead.
 */
export function applyFixes(graph: Graph): string[] {
  const changed: string[] = [];

  for (const node of graph.instances.values()) {
    let touched = canonicaliseUris(graph, node);
    touched = regenerateLinks(graph, node) || touched;
    if (!touched) continue;

    writeFileSync(absolute(graph.cfg, node.path), stringifyInstance(node.file));
    changed.push(node.path);
  }

  return changed.sort();
}

function compactForm(raw: string, graph: Graph): string | null {
  try {
    const parsed = parseUri(raw);
    const repoRelative = parsed.scheme === "repo"
      ? parsed.path
      : parsed.scheme === "design"
        ? `${graph.cfg.designRoot}/${parsed.path}`
        : `${classRootsFor(graph.cfg, parsed.scheme)[0]!}/${parsed.path}`;
    return formatUri(canonicalise(repoRelative, graph.cfg, parsed.anchor));
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
