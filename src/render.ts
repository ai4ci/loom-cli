import { LoomError, type Diagnostic, error } from "./diagnostics.ts";
import { IGNORED_DIRS, type Config, absolute } from "./config.ts";
import { type ViewAnnotation } from "./model/types.ts";
import { loadModel } from "./model/load.ts";
import { databasePath, query, rebuild, refresh } from "./duckdb.ts";
import { type Graph, loadGraph, relativeLink, titleOf, toRepoRelative } from "./graph.ts";
import { parseUri, resolveUri } from "./uri.ts";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    /** Byte offset where the end marker ends (just after the opener if absent). */
  end: number;
}

/**
 * Byte ranges covered by fenced code blocks and inline code spans. A marker
 * inside one is documentation of the syntax, not a view site: expanding it
 * would destroy prose in any file that documents loom itself.
 */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  // Fences: three or more backticks/tildes at line start, closed by a fence of
  // at least the same length. Everything from the opening fence to the closing
  // one (or EOF for an unclosed fence) is off limits.
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: RegExpExecArray | null;
  while ((open = fence.exec(text)) !== null) {
    const char = open[1]![0]!;
    const len = open[1]!.length;
    const close = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${len},}[ \\t]*$`, "m");
    close.lastIndex = open.index + open[0].length;
    const end = close.exec(text);
    const stop = end === null ? text.length : end.index + end[0].length;
    ranges.push([open.index, stop]);
    fence.lastIndex = stop;
  }
  // Inline spans: a run of N backticks closed by exactly N. Overlap with the
  // fence ranges is harmless.
  const span = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
  let spanMatch: RegExpExecArray | null;
  while ((spanMatch = span.exec(text)) !== null) {
    ranges.push([spanMatch.index, spanMatch.index + spanMatch[0].length]);
  }
  return ranges;
}

function inRanges(ranges: [number, number][], at: number): boolean {
  return ranges.some(([from, to]) => at >= from && at < to);
}

/**
 * Find every `<!-- loom view: ... -->` marker in markdown text.
 * Returns markers in document order. Markers inside code fences or inline
 * code spans are skipped: they document the syntax rather than use it.
 */
export function scanViewMarkers(text: string): ViewMarker[] {
  const re = /<!--\s*loom\s+view:\s*(.+?)\s*-->/g;
  const markers: ViewMarker[] = [];
  const code = codeRanges(text);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (inRanges(code, match.index)) continue;
    const raw = match[1]!.trim();
    // Terminators: bare `end`, or `<name> end` for the view that owns them.
    if (raw === "end" || raw.endsWith(" end")) continue;
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

    // Find the terminator: `<name> end` if present after this opener, else
    // the first bare `end`. An unterminated view is not an error while
    // authoring — its section is empty (render inserts the content and the
    // qualified end right after the opener), so prose below is never eaten.
    const own = new RegExp(`<!--\\s*loom\\s+view:\\s*${escapeRegExp(view)}\\s+end\\s*-->`);
    let end = match.index + match[0].length;
    const rest = /<!--\s*loom\s+view:\s*(.+?)\s*-->/g;
    rest.lastIndex = end;
    let candidate: RegExpExecArray | null;
    while ((candidate = rest.exec(text)) !== null) {
      if (inRanges(code, candidate.index)) continue;
      const raw2 = candidate[1]!.trim();
      if (own.test(candidate[0]) || raw2 === "end") {
        end = candidate.index + candidate[0].length;
        break;
      }
    }

    markers.push({ view, params, start, end });
  }

  return markers;
}

// ---------------------------------------------------------------------------
// Parameter substitution
// ---------------------------------------------------------------------------

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** When given, uri-shaped cells are rendered as relative markdown links. */
export interface LinkContext {
  graph: Graph;
  /** Repo-relative path of the file being rendered (link base). */
  fromPath: string;
}

/** One cell value: uri cells become `[title](relative/path)` links. */
function renderCell(cell: unknown, link: LinkContext | undefined): string {
  const text = String(cell ?? "");
  if (link === undefined || text === "") return text;
  let parsed;
  try {
    parsed = parseUri(text);
  } catch {
    return text;
  }
  // External prefixes expand to absolute urls, which are the link target.
  const resolved = resolveUri(parsed, link.graph.roots, link.graph.prefixes);
  if (resolved.external === true) return `[${text}](${resolved.path})`;
  // Not a design uri we know how to address (e.g. a literal, or the edge
  // table's bare labels): leave the cell alone.
  if (!hasStat(absolute(link.graph.cfg, resolved.path))) return text;
  const label = titleOf(link.graph, text);
  const target = relativeLink(link.graph, link.fromPath, text);
  return `[${label}](${target})`;
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
  link?: LinkContext,
  file?: string,
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
      throw new LoomError(
        error(
          "render/unknown-view",
          `unknown view "${view}"${file === undefined ? "" : " (in " + file + ")"}`,
          { fix: `define it with "%% @view ${view}" in document-model.mmd, or fix the marker` },
        ),
      );
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
    const items = rows.map((r) => renderCell(r[col], link)).filter(Boolean);
    return { markdown: items.map((i) => `- ${i}`).join("\n"), debug };
  }

  if (columns.length <= 4) {
    // Full markdown table.
    const header = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) => `| ${columns.map((c) => renderCell(r[c], link)).join(" | ")} |`).join("\n");
    return { markdown: `${header}\n${sep}\n${body}`, debug };
  }

  // 5+ columns: compact list with bold keys.
  const items = rows.map(
    (r) => columns.map((c) => `**${c}:** ${renderCell(r[c], link)}`).join("  "),
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
      // Vendored and generated trees are not loom's to overwrite.
      if (e.startsWith(".") || IGNORED_DIRS.has(e)) continue;
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

/**
 * Markdown files render may write to: everything under the repo root except
 * ignored trees and paths git ignores. Generated output (a `build/` dir,
 * say) is not loom's to overwrite, and .gitignore is the only ignore ruleset
 * a repository already has. Outside a git repository only IGNORED_DIRS apply.
 */
function renderableMdFiles(cfg: Config): string[] {
  const files = mdFiles(cfg.repoRoot);
  if (files.length === 0) return files;
  let ignored: Set<string>;
  try {
    const child = spawnSync("git", ["-C", cfg.repoRoot, "check-ignore", "--stdin"], {
      input: files.map((f) => toRepoRelative(cfg, f)).join("\n"),
      encoding: "utf8",
    });
    // Exit 0 means some paths matched, 1 means none did, 128 means no repo.
    if (child.status !== 0 && child.status !== 1) return files;
    ignored = new Set(child.stdout.split("\n").filter((line) => line !== ""));
  } catch {
    return files;
  }
  return files.filter((f) => !ignored.has(toRepoRelative(cfg, f)));
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
  return `${head}${section}<!-- loom view: ${marker.view} end -->${tail}`;
}

/** True when a render would change the section in this file. */
function sectionDiffers(text: string, marker: ViewMarker, renderedMd: string): boolean {
  return updateSection(text, marker, renderedMd) !== text;
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
  debug?: DebugSink,
): Promise<{ rendered: RenderResult[]; debug: string[] }> {
  const { cfg, roots } = ctx;
  const model = loadModel(cfg);
  const { schema } = model;

  // Rebuild DB if it doesn't exist yet; otherwise rescan the markdown so the
  // projection reflects hand edits (render reads the projection, so --check
  // would otherwise pass on stale data).
  if (!hasStat(absolute(cfg, databasePath(cfg)))) {
    const { graph } = loadGraph(cfg, schema, roots);
    await rebuild(graph);
  } else {
    const { graph } = loadGraph(cfg, schema, roots);
    await refresh(graph);
  }

  const namedViews = new Map(model.views.map((v) => [v.name, v]));
  const files = renderableMdFiles(cfg);
  const rendered: RenderResult[] = [];
  const debugLines: string[] = [];
  const note = (line: string) => {
    debugLines.push(line);
    debug?.(line);
  };

  // Loaded once so uri cells can link with real titles.
  const { graph } = loadGraph(cfg, schema, roots);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const markers = scanViewMarkers(text);
    if (markers.length === 0) continue;

    const link = { graph, fromPath: toRepoRelative(cfg, file) };
    let updated = text;
    // Render right-to-left: earlier markers' offsets stay valid.
    for (const marker of [...markers].reverse()) {
      const { markdown, debug } = await renderView(cfg, marker.view, marker.params, namedViews, link, toRepoRelative(cfg, file));
      note(`${file}: view ${debug.name}\n  ${debug.sql.replaceAll("\n", "\n  ")}`);
      updated = updateSection(updated, marker, markdown);
      rendered.push({ file, view: marker.view });
    }
    rendered.reverse();
    writeFileSync(file, updated, "utf8");
  }

  return { rendered, debug: debugLines };
}

export interface RenderCommandOptions {
  check?: boolean;
  debug?: boolean;
}

export interface RenderCommandResult {
  ok: boolean;
  results: RenderResult[];
  /** Views whose output differs from what is on disk (only set with --check). */
  stale: string[];
}

/** Where --debug output goes; injectable so tests can capture it. */
export type DebugSink = (line: string) => void;

export async function renderCommand(
  ctx: { cfg: Config; roots: ClassRoots },
  options: RenderCommandOptions = {},
  write?: { debug: DebugSink },
): Promise<RenderCommandResult> {
  if (options.check) {
    const stale = await checkStale(ctx, options.debug ? write?.debug : undefined);
    return { ok: stale.length === 0, results: [], stale };
  }

  const { rendered, debug } = await renderAll(ctx, options.debug ? write?.debug : undefined);
  return { ok: true, results: rendered, stale: [], ...(debug ? { debug } : {}) };
}

/**
 * CI mode: render in memory, never write. Names every file a normal render
 * would change, so the caller can fail with the paths that are stale.
 */
async function checkStale(
  ctx: { cfg: Config; roots: ClassRoots },
  writeDebug: DebugSink | undefined,
): Promise<string[]> {
  const { cfg, roots } = ctx;
  const model = loadModel(cfg);
  const { schema } = model;

  if (!hasStat(absolute(cfg, databasePath(cfg)))) {
    const { graph } = loadGraph(cfg, schema, roots);
    await rebuild(graph);
  } else {
    const { graph } = loadGraph(cfg, schema, roots);
    await refresh(graph);
  }

  const namedViews = new Map(model.views.map((v) => [v.name, v]));
  const stale: string[] = [];

  const { graph } = loadGraph(cfg, schema, roots);

  for (const file of renderableMdFiles(cfg)) {
    const text = readFileSync(file, "utf8");
    const markers = scanViewMarkers(text);
    if (markers.length === 0) continue;

    const link = { graph, fromPath: toRepoRelative(cfg, file) };
    let touched = false;
    for (const marker of markers) {
      const { markdown, debug: info } = await renderView(cfg, marker.view, marker.params, namedViews, link, toRepoRelative(cfg, file));
      if (writeDebug !== undefined) {
        writeDebug(`${file}: view ${info.name}\n  ${info.sql.replaceAll("\n", "\n  ")}`);
      }
      if (sectionDiffers(text, marker, markdown)) touched = true;
    }
    if (touched) stale.push(file);
  }

  return stale;
}
