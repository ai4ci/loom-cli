import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { absolute, type Config } from "./config.ts";
import { getLinksBlock, setLinksBlock, stringifyInstance, parseInstance } from "./document.ts";
import { loadModel } from "./model/load.ts";
import type { SchemaIR } from "./model/types.ts";
import { query } from "./duckdb.ts";

export interface FilterView {
  class: string;
  where?: Record<string, unknown>;
  orderBy?: string;
}

export interface QueryView {
  query: string;
}

export type IndexView = FilterView | QueryView;

export interface IndexDefinition {
  /** Repo-relative path of the index file. */
  path: string;
  view: IndexView;
}

function isQueryView(view: unknown): view is QueryView {
  return typeof view === "object" && view !== null && "query" in view
    && typeof (view as Record<string, unknown>)["query"] === "string";
}

function isFilterView(view: unknown): view is FilterView {
  return typeof view === "object" && view !== null && "class" in view
    && typeof (view as Record<string, unknown>)["class"] === "string";
}

export function loadIndexDefinitions(cfg: Config): IndexDefinition[] {
  const indices: IndexDefinition[] = [];
  const designRoot = absolute(cfg, cfg.designRoot);

  if (!existsSync(designRoot)) return indices;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = parseInstance(readFileSync(full, "utf8"));
      const data = file.frontmatter?.toJS() as Record<string, unknown> | undefined;
      if (!data || data["class"] !== "index") continue;
      const view = data["view"];
      if (!isFilterView(view) && !isQueryView(view)) continue;

      const repoRelative = path.relative(cfg.repoRoot, full).split(path.sep).join("/");
      indices.push({
        path: repoRelative,
        view: view as IndexView,
      });
    }
  };
  walk(designRoot);
  return indices.sort((a, b) => a.path.localeCompare(b.path));
}

function escapeSql(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildFilterSql(view: FilterView): string {
  const conds: string[] = [];
  if (view.where) {
    for (const [key, value] of Object.entries(view.where)) {
      conds.push(`${key} = ${escapeSql(value)}`);
    }
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  const order = view.orderBy ? ` ORDER BY ${view.orderBy}` : "";
  return `SELECT uri, title FROM ${view.class}${where}${order}`;
}

async function runView(cfg: Config, view: IndexView): Promise<{ uri: string; title: string }[]> {
  const sql = isQueryView(view) ? view.query : buildFilterSql(view);
  const { rows } = await query(cfg, sql);
  return (rows as Record<string, unknown>[]).map((r) => ({
    uri: String(r["uri"] ?? ""),
    title: String(r["title"] ?? r["uri"] ?? ""),
  }));
}

function relativeLink(cfg: Config, indexPath: string, target: { uri: string }): string {
  // The file lives at <designRoot>/<scheme>/<innerPath>; the index sits at
  // some path under designRoot. Build the designRoot-relative path directly
  // rather than via canonicalise, which would strip the class root segment.
  const match = /^([a-zA-Z+.-]+):\/\/(.+)$/.exec(target.uri);
  if (!match) return target.uri;
  const filePath = `${cfg.designRoot}/${match[1]}/${match[2]}`;
  const indexDir = path.posix.dirname(indexPath);
  return path.posix.relative(indexDir, filePath);
}

async function renderIndexBlock(cfg: Config, def: IndexDefinition, rows: { uri: string; title: string }[]): Promise<string> {
  if (rows.length === 0) return "_No matching instances._";
  const lines = rows.map((r) => `- [${r.title}](${relativeLink(cfg, def.path, r)})`);
  return lines.join("\n");
}

export interface IndexUpdate {
  path: string;
  changed: boolean;
}

/**
 * Regenerate every index file. Each is a normal markdown file whose
 * frontmatter declares a view; the body is a protected generated region.
 */
export async function regenerateIndexes(cfg: Config, schema: SchemaIR): Promise<IndexUpdate[]> {
  const definitions = loadIndexDefinitions(cfg);
  const updates: IndexUpdate[] = [];

  for (const def of definitions) {
    const absolutePath = absolute(cfg, def.path);
    const file = parseInstance(readFileSync(absolutePath, "utf8"));
    const existing = getLinksBlock(file.markdown);
    const rows = await runView(cfg, def.view);
    const expected = await renderIndexBlock(cfg, def, rows);

    if (existing !== null && existing === expected) {
      updates.push({ path: def.path, changed: false });
      continue;
    }

    file.markdown = setLinksBlock(file.markdown, expected);
    writeFileSync(absolutePath, stringifyInstance(file));
    updates.push({ path: def.path, changed: true });
  }

  return updates;
}

export async function checkIndexes(cfg: Config, schema: SchemaIR): Promise<string[]> {
  const definitions = loadIndexDefinitions(cfg);
  const stale: string[] = [];

  for (const def of definitions) {
    const file = parseInstance(readFileSync(absolute(cfg, def.path), "utf8"));
    const existing = getLinksBlock(file.markdown);
    const rows = await runView(cfg, def.view);
    const expected = await renderIndexBlock(cfg, def, rows);
    if (existing !== expected) stale.push(def.path);
  }

  return stale.sort();
}

export interface IndexCommandResult {
  updated: string[];
  unchanged: string[];
}

export async function indexCommand(cfg: Config, options: { check?: boolean }): Promise<IndexCommandResult> {
  const { schema } = loadModel(cfg);
  if (options.check) {
    const stale = await checkIndexes(cfg, schema);
    return {
      updated: [],
      unchanged: stale,
    };
  }
  // Rebuild the database if it doesn't exist; queries need it.
  if (!existsSync(absolute(cfg, `${cfg.designRoot}/.loom.duckdb`))) {
    const { loadGraph } = await import("./graph.ts");
    const { rebuild } = await import("./duckdb.ts");
    const { graph } = loadGraph(cfg, schema);
    await rebuild(graph);
  }
  const updates = await regenerateIndexes(cfg, schema);
  return {
    updated: updates.filter((u) => u.changed).map((u) => u.path).sort(),
    unchanged: updates.filter((u) => !u.changed).map((u) => u.path).sort(),
  };
}
