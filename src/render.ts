import { type Diagnostic, error } from "./diagnostics.ts";
import { type Config, absolute } from "./config.ts";
import { type ViewAnnotation } from "./model/types.ts";
import { loadModel } from "./model/load.ts";
import { query, rebuild } from "./duckdb.ts";
import { loadGraph } from "./graph.ts";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClassRoots } from "./path-resolution.ts";

// ---------------------------------------------------------------------------
// %% @view annotation extraction (from model comment lines)
// ---------------------------------------------------------------------------

/**
 * Parse `%% @view` annotations from model comments.
 * Multi-line body: lines after `%% @view <name>` that start with `%%` (with
 * leading spaces) are continuation lines of the SQL.
 */
export function extractViewAnnotations(
  comments: { text: string; line: number }[],
  diagnostics: Diagnostic[],
): ViewAnnotation[] {
  const views: ViewAnnotation[] = [];
  let current: { name: string; sql: string; line: number } | null = null;

  const flush = () => {
    if (current !== null) {
      current.sql = current.sql.trimEnd();
      views.push({ name: current.name, sql: current.sql, line: current.line });
      current = null;
    }
  };

  for (const { text, line } of comments) {
    const start = /^%%\s+@view\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text);
    if (start) {
      flush();
      current = { name: start[1]!, sql: "", line };
      continue;
    }
    if (current !== null) {
      const cont = /^%%\s*(.*)$/.exec(text);
      if (cont) {
        current.sql += cont[1] + "\n";
        continue;
      }
    }
    // A non-continuation comment while building a view => finalise.
    if (current !== null) flush();
  }
  flush();

  // Deduplicate by name.
  const seen = new Set<string>();
  for (const v of views) {
    if (seen.has(v.name)) {
      diagnostics.push(error("model/duplicate-view", `duplicate %% @view "${v.name}"`, { line: v.line }));
    }
    seen.add(v.name);
  }

  return views;
}

// ---------------------------------------------------------------------------
// Inline marker scanning
// ---------------------------------------------------------------------------

export interface ViewMarker {
  /** Raw text from the marker comment (name or inline SQL). */
  view: string;
  /** Parsed query-string parameters. */
  params: Record<string, string>;
  /** Byte offset where the opening `<!-- loom view:` starts. */
  start: number;
  /** Byte offset where the closing `<!-- loom view: end -->` ends (or start if absent). */
  end: number;
}

/**
 * Find every `<!-- loom view: ... -->` marker in markdown text.
 * Returns markers in document order.
 */
export function scanViewMarkers(text: string): ViewMarker[] {
  const re = /<!--\s*loom\s+view:\s*(.+?)\s*-->/g;
  const markers: ViewMarker[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const raw = match[1]!.trim();
    // Skip <!-- loom view: end --> markers, they are terminators not views.
    if (raw === "end") continue;
    const start = match.index;

    // Parse optional query-string parameters.
    let view = raw;
    let params: Record<string, string> = {};
    const qsIdx = raw.indexOf("?");
    if (qsIdx !== -1) {
      view = raw.slice(0, qsIdx).trim();
      const qs = raw.slice(qsIdx + 1);
      for (const pair of qs.split("&")) {
        const eq = pair.indexOf("=");
        if (eq !== -1) {
          params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
      }
    }

    // Find matching <!-- loom view: end --> (the first one after start).
    const endRe = /<!--\s*loom\s+view:\s*end\s*-->/g;
    endRe.lastIndex = match.index + match[0].length;
    const endMatch = endRe.exec(text);
    const end = endMatch ? endMatch.index + endMatch[0].length : start;

    markers.push({ view, params, start, end });
  }

  return markers;
}

// ---------------------------------------------------------------------------
// Parameter substitution
// ---------------------------------------------------------------------------

function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/\\'/g, "''").replace(/'/g, "''")}'`;
}

/**
 * Replace `$param` tokens with escaped SQL values.
 * List params (comma-separated, backslash-escaped commas) expand to
 * `IN ('a', 'b')` or `= 'single'` depending on how they appear.
 */
export function substituteParams(
  sql: string,
  params: Record<string, string>,
): string {
  return sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const raw = params[name];
    if (raw === undefined) return `[undefined: $${name}]`;

    // Split on unescaped commas.
    const parts: string[] = [];
    let buf = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === "\\" && raw[i + 1] === ",") {
        buf += ",";
        i++;
      } else if (ch === ",") {
        parts.push(buf);
        buf = "";
      } else {
        buf += ch;
      }
    }
    parts.push(buf);

    if (parts.length === 1) return escapeSqlLiteral(parts[0]!);
    return `(${parts.map(escapeSqlLiteral).join(", ")})`;
  });
}

// ---------------------------------------------------------------------------
// Rendering — SQL result -> markdown
// ---------------------------------------------------------------------------

/** Shape of a debug dump entry. */
export interface DebugView {
  name: string;
  params: Record<string, string>;
  sql: string;
}

/**
 * Render a single view: run SQL, produce markdown (table or list).
 * Returns `{ markdown, debug }` where debug includes the resolved SQL.
 */
export async function renderView(
  cfg: Config,
  view: string,
  params: Record<string, string>,
  namedViews: Map<string, ViewAnnotation>,
): Promise<{ markdown: string; debug: DebugView }> {
  // Check for inline SQL (starts with SELECT).
  const isInline = /^SELECT\b/i.test(view);
  let sql: string;
  let name: string;

  if (isInline) {
    sql = view;
    name = "(inline)";
  } else {
    const def = namedViews.get(view);
    if (!def) {
      return {
        markdown: `_Unknown view "${view}"._`,
        debug: { name: view, params, sql: `-- unknown view: ${view}` },
      };
    }
    sql = substituteParams(def.sql, params);
    name = view;
  }

  const debug: DebugView = { name, params, sql };

  let rows: Record<string, unknown>[];
  try {
    const result = await query(cfg, sql);
    rows = result.rows as Record<string, unknown>[];
  } catch (e) {
    return { markdown: `_Query failed: ${(e as Error).message}_`, debug };
  }

  if (rows.length === 0) return { markdown: "_(no results)_", debug };

  const columns = Object.keys(rows[0]!);

  if (columns.length === 0) return { markdown: "_(no results)_", debug };

  if (columns.length === 1) {
    const col = columns[0]!;
    const items = rows.map((r) => String(r[col] ?? "")).filter(Boolean);
    return { markdown: items.map((i) => `- ${i}`).join("\n"), debug };
  }

  if (columns.length <= 4) {
    // Full markdown table.
    const header = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) => `| ${columns.map((c) => String(r[c] ?? "")).join(" | ")} |`).join("\n");
    return { markdown: `${header}\n${sep}\n${body}`, debug };
  }

  // 5+ columns: compact list with bold keys.
  const items = rows.map(
    (r) => columns.map((c) => `**${c}:** ${String(r[c] ?? "")}`).join("  "),
  );
  return { markdown: items.map((i) => `- ${i}`).join("\n"), debug };
}

// ---------------------------------------------------------------------------
// Full-file render
// ---------------------------------------------------------------------------

function mdFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const full = path.join(dir, e);
      let s: ReturnType<typeof statSync>;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) walk(full);
      else if (e.endsWith(".md")) files.push(full);
    }
  }
  walk(root);
  return files;
}

function hasStat(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

function updateSection(text: string, marker: ViewMarker, renderedMd: string): string {
  const head = text.slice(0, marker.start);
  const markerEnd = text.indexOf("-->", marker.start);
  const closeLen = "-->".length;
  const afterMarker = markerEnd !== -1 ? markerEnd + closeLen : marker.start;
  const tail = text.slice(marker.end);
  const opening = text.slice(marker.start, afterMarker);
  const section = renderedMd
    ? `${opening}\n\n${renderedMd}\n`
    : `${opening}\n`;
  return `${head}${section}<!-- loom view: end -->${tail}`;
}

export interface RenderResult {
  file: string;
  view: string;
}

/**
 * Scan every markdown file under the repo root, find
 * `<!-- loom view: ... -->` markers, render them, and update files in place.
 */
export async function renderAll(
  ctx: { cfg: Config; roots: ClassRoots },
): Promise<{ rendered: RenderResult[] }> {
  const { cfg, roots } = ctx;
  const model = loadModel(cfg);
  const { schema } = model;

  // Rebuild DB if it doesn't exist yet.
  if (!hasStat(absolute(cfg, `${cfg.designRoot}/.loom.duckdb`))) {
    const { graph } = loadGraph(cfg, schema, roots);
    await rebuild(graph);
  }

  const namedViews = new Map(model.views.map((v) => [v.name, v]));
  const files = mdFiles(cfg.repoRoot);
  const rendered: RenderResult[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const markers = scanViewMarkers(text);
    if (markers.length === 0) continue;

    let updated = text;
    for (const marker of markers) {
      const { markdown } = await renderView(cfg, marker.view, marker.params, namedViews);
      updated = updateSection(updated, marker, markdown);
      rendered.push({ file, view: marker.view });
    }
    writeFileSync(file, updated, "utf8");
  }

  return { rendered };
}

export interface RenderCommandOptions {
  check?: boolean;
  debug?: boolean;
}

export async function renderCommand(
  ctx: { cfg: Config; roots: ClassRoots },
  options: RenderCommandOptions = {},
): Promise<{ ok: boolean; results: RenderResult[] }> {
  const { rendered } = await renderAll(ctx);
  return { ok: true, results: rendered };
}
