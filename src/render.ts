import { LoomError, type Diagnostic, error } from "./diagnostics.ts";
import { IGNORED_DIRS, type Config, absolute } from "./config.ts";
import { type ViewAnnotation } from "./model/types.ts";
import { loadModel, type LoadedModel } from "./model/load.ts";
import { query, refresh, withQueryConnection, type Query } from "./duckdb.ts";
import { type Graph, loadGraph, relativeLink, titleOf, toRepoRelative } from "./graph.ts";
import {
  type IncludeMarker,
  type Marker,
  type ViewMarker,
  scanMarkers,
  scanViewMarkers,
  updateSection,
} from "./markers.ts";
import { codeRanges, inRanges } from "./markers.ts";
import { toRelative } from "./body.ts";
import { canonicalise, formatUri, parseUri, resolveUri } from "./uri.ts";

export { scanMarkers, scanViewMarkers, type Marker, type ViewMarker, type IncludeMarker };
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
// Includes — transcluding one document's prose into another
// ---------------------------------------------------------------------------

/** ATX heading lines outside fenced code. Setext headings are not supported. */
function headings(text: string): { at: number; length: number; level: number; rest: string }[] {
  const code = codeRanges(text);
  const found: { at: number; length: number; level: number; rest: string }[] = [];
  const re = /^( {0,3})(#{1,6})([ \t][^\n]*|)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (inRanges(code, match.index)) continue;
    found.push({
      at: match.index,
      length: match[0].length,
      level: match[2]!.length,
      rest: `${match[1] ?? ""}|${match[3] ?? ""}`,
    });
  }
  return found;
}

/**
 * Shift every heading so the shallowest sits at `to`. Relative depth and gaps
 * survive. Past six hashes CommonMark stops seeing a heading and renders the
 * line as text, which is the documented behaviour here: the author chose the
 * level, and a paragraph is a visible symptom.
 */
export function shiftHeadings(text: string, to: number): string {
  const found = headings(text);
  if (found.length === 0) return text;

  const shift = to - Math.min(...found.map((h) => h.level));
  if (shift === 0) return text;

  let out = "";
  let at = 0;
  for (const heading of found) {
    const [indent = "", rest = ""] = heading.rest.split("|");
    out += text.slice(at, heading.at);
    out += `${indent}${"#".repeat(Math.max(1, heading.level + shift))}${rest}`;
    at = heading.at + heading.length;
  }
  return out + text.slice(at);
}

/**
 * Transclude a document's prose. The text comes from the projection, which
 * holds source prose with every marker collapsed, so an include can never
 * copy another document's generated output (design/inline-views.md §7).
 */
async function renderInclude(
  lookup: { query: Query; bodies: Map<string, string> },
  marker: IncludeMarker,
  link: LinkContext,
  file: string,
): Promise<string> {
  const { graph } = link;
  let uri: string;
  try {
    const parsed = parseUri(marker.uri);
    uri = formatUri(canonicalise(resolveUri(parsed, graph.roots).path, graph.roots, parsed.anchor));
  } catch {
    throw new LoomError(error("render/bad-include", `"${marker.uri}" is not a uri (in ${file})`, {
      fix: "write <!-- loom include: <uri> [h1..h6] [notitle] -->",
    }));
  }

  const node = graph.instances.get(uri);
  if (node === undefined) {
    throw new LoomError(error("render/missing-include", `${uri} has no instance file (in ${file})`, {
      fix: `create it, or correct the uri (\`loom ls ${parseUri(uri).scheme}:\` lists what exists)`,
    }));
  }

  let body = lookup.bodies.get(uri);
  if (body === undefined) {
    const result = await lookup.query(`SELECT body FROM ${quoteIdentifier(node.className)} WHERE uri = '${uri.replace(/'/g, "''")}'`);
    body = String((result.rows as { body?: unknown }[])[0]?.body ?? "");
    lookup.bodies.set(uri, body);
  }

  let prose = body;
  if (marker.level !== undefined) {
    // With a title, the document's own headings live under it.
    prose = shiftHeadings(prose, marker.level + (marker.title ? 1 : 0));
  }

  const title = marker.title ? node.data["title"] : undefined;
  const heading = typeof title === "string" && title !== ""
    ? `${"#".repeat(marker.level ?? 1)} ${title}\n\n`
    : "";

  // Curies become links relative to the file the prose now lives in.
  return `${heading}${toRelative(prose, link.fromPath, graph.roots, graph.prefixes)}`.trimEnd();
}

/** DuckDB identifier quoting, for the class table an include reads from. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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

function checkIgnoredPaths(repoRoot: string, paths: string[]) {
  const input = Buffer.from(`${paths.join("\0")}\0`);
  const dir = mkdtempSync(path.join(tmpdir(), "loom-ignore-"));
  let fd: number | undefined;
  try {
    const file = path.join(dir, "paths");
    writeFileSync(file, input);
    // A regular file avoids the synchronous stdin pipe that can stall in
    // agent tool sessions. Git reads the whole list in one invocation.
    fd = openSync(file, "r");
    return spawnSync("git", ["-C", repoRoot, "check-ignore", "--stdin", "-z"], {
      stdio: [fd, "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: Math.max(1024 * 1024, input.length),
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
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
    const child = checkIgnoredPaths(cfg.repoRoot, files.map((file) => toRepoRelative(cfg, file)));
    // Exit 0 means some paths matched, 1 means none did, 128 means no repo.
    if (child.status !== 0 && child.status !== 1) return files;
    ignored = new Set(child.stdout.split("\0"));
  } catch {
    return files;
  }
  return files.filter((f) => !ignored.has(toRepoRelative(cfg, f)));
}

function hasStat(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

/** True when a render would change the section in this file. */
function sectionDiffers(text: string, marker: Marker, renderedMd: string): boolean {
  return updateSection(text, marker, renderedMd) !== text;
}

export interface RenderResult {
  file: string;
  view: string;
}

interface RenderContext {
  cfg: Config;
  roots: ClassRoots;
  model?: LoadedModel;
}

async function prepareRender({ cfg, roots, model = loadModel(cfg) }: RenderContext) {
  const { graph } = loadGraph(cfg, model.schema, roots);
  await refresh(graph);
  return { graph, namedViews: new Map(model.views.map((view) => [view.name, view])) };
}

/**
 * Scan every markdown file under the repo root, find
 * `<!-- loom view: ... -->` markers, render them, and update files in place.
 */
export async function renderAll(
  ctx: RenderContext,
  debug?: DebugSink,
): Promise<{ rendered: RenderResult[]; debug: string[] }> {
  const { cfg } = ctx;
  const { graph, namedViews } = await prepareRender(ctx);
  const files = renderableMdFiles(cfg);
  const rendered: RenderResult[] = [];
  const debugLines: string[] = [];
  const note = (line: string) => {
    debugLines.push(line);
    debug?.(line);
  };

  // Render every file in memory first: if any view fails, nothing is written
  // anywhere, so a failed render cannot leave a half-updated repo.
  const updates: { file: string; content: string }[] = [];
  await withQueryConnection(cfg, async (query) => {
    const lookup = { query, bodies: new Map<string, string>() };
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const markers = scanMarkers(text);
      if (markers.length === 0) continue;

      const link = { graph, fromPath: toRepoRelative(cfg, file) };
      let updated = text;
      // Render right-to-left: earlier markers' offsets stay valid.
      for (const marker of [...markers].reverse()) {
        if (marker.kind === "include") {
          const markdown = await renderInclude(lookup, marker, link, link.fromPath);
          note(`${file}: include ${marker.raw}`);
          updated = updateSection(updated, marker, markdown);
          rendered.push({ file, view: `include ${marker.uri}` });
          continue;
        }
        const { markdown, debug } = await renderView(cfg, marker.view, marker.params, namedViews, link, link.fromPath);
        note(`${file}: view ${debug.name}\n  ${debug.sql.replaceAll("\n", "\n  ")}`);
        updated = updateSection(updated, marker, markdown);
        rendered.push({ file, view: marker.view });
      }
      rendered.reverse();
      if (updated !== text) updates.push({ file, content: updated });
    }
  });
  for (const update of updates) writeFileSync(update.file, update.content, "utf8");

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
  ctx: RenderContext,
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
  ctx: RenderContext,
  writeDebug: DebugSink | undefined,
): Promise<string[]> {
  const { cfg } = ctx;
  const { graph, namedViews } = await prepareRender(ctx);
  const stale: string[] = [];

  await withQueryConnection(cfg, async (query) => {
    const lookup = { query, bodies: new Map<string, string>() };
    for (const file of renderableMdFiles(cfg)) {
      const text = readFileSync(file, "utf8");
      const markers = scanMarkers(text);
      if (markers.length === 0) continue;

      const link = { graph, fromPath: toRepoRelative(cfg, file) };
      let touched = false;
      for (const marker of markers) {
        if (marker.kind === "include") {
          const markdown = await renderInclude(lookup, marker, link, link.fromPath);
          if (sectionDiffers(text, marker, markdown)) touched = true;
          continue;
        }
        const { markdown, debug: info } = await renderView(cfg, marker.view, marker.params, namedViews, link, link.fromPath);
        if (writeDebug !== undefined) {
          writeDebug(`${file}: view ${info.name}\n  ${info.sql.replaceAll("\n", "\n  ")}`);
        }
        if (sectionDiffers(text, marker, markdown)) touched = true;
      }
      if (touched) stale.push(file);
    }
  });

  return stale;
}
