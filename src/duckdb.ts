import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { absolute, type Config } from "./config.ts";
import { LoomError, error } from "./diagnostics.ts";
import type { Graph } from "./graph.ts";
import { effectiveAttributes, isInstantiable } from "./model/schema.ts";
import type { Attribute, SchemaIR } from "./model/types.ts";
import { embedder, hashBody, type Embedder } from "./embeddings.ts";

export const DATABASE_FILENAME = ".loom.duckdb";

export function databasePath(cfg: Config): string {
  return `${cfg.designRoot}/${DATABASE_FILENAME}`;
}

/**
 * Attribute types map to native DuckDB types so comparisons and aggregates
 * need no casts (plan §Phase 4). Enumerations are VARCHAR with membership
 * enforced at validation rather than by a database constraint. Class-typed
 * attributes become DuckDB STRUCTs so subfields are queryable and misspellings
 * fail loudly (plan "Later — composite attributes").
 */
function columnType(schema: SchemaIR, attribute: Attribute): string {
  let base: string;
  if (attribute.type.kind === "primitive") {
    base = {
      string: "VARCHAR",
      path: "VARCHAR",
      uri: "VARCHAR",
      int: "INTEGER",
      float: "DOUBLE",
      bool: "BOOLEAN",
      date: "DATE",
    }[attribute.type.name];
  } else if (attribute.type.kind === "class") {
    base = structType(schema, attribute.type.className);
  } else if (attribute.type.kind === "enum") {
    base = "VARCHAR";
  } else {
    base = "VARCHAR";
  }
  return attribute.list ? `${base}[]` : base;
}

/** Recursive STRUCT projection for a class-typed attribute (plan "Later — composite attributes"). */
function structType(schema: SchemaIR, className: string): string {
  const fields = effectiveAttributes(schema, className).map((a) => `${quote(a.name)} ${columnType(schema, a)}`);
  return `STRUCT(${fields.join(", ")})`;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(schema: SchemaIR, attribute: Attribute, value: unknown): string {
  if (value === undefined || value === null) return "NULL";

  if (attribute.list) {
    const items = Array.isArray(value) ? value : [value];
    return `[${items.map((item) => literal(schema, { ...attribute, list: false }, item)).join(", ")}]`;
  }

  if (attribute.type.kind === "primitive") {
    switch (attribute.type.name) {
      case "int":
      case "float":
        return typeof value === "number" ? String(value) : "NULL";
      case "bool":
        return value === true ? "TRUE" : value === false ? "FALSE" : "NULL";
      case "date": {
        const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
        return `DATE '${text.replace(/'/g, "''")}'`;
      }
      default:
        break;
    }
  }

  if (attribute.type.kind === "class") {
    return structLiteral(schema, attribute.type.className, value);
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

function structLiteral(schema: SchemaIR, className: string, value: unknown): string {
  if (typeof value !== "object" || value === null) return "NULL";
  const record = value as Record<string, unknown>;
  const fields = effectiveAttributes(schema, className).map((a) => {
    const v = record[a.name];
    const fieldLiteral = literal(schema, a, v);
    return `${quote(a.name)}: ${fieldLiteral}`;
  });
  return `{${fields.join(", ")}}`;
}

export interface TableSummary {
  name: string;
  rows: number;
}

async function connect(cfg: Config): Promise<DuckDBConnection> {
  const target = absolute(cfg, databasePath(cfg));
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  // Ensure the derived database and its WAL are git-ignored in the design root.
  const ignoreFile = path.join(dir, ".gitignore");
  if (!existsSync(ignoreFile)) {
    writeFileSync(ignoreFile, `${DATABASE_FILENAME}*\n`);
  }
  return (await DuckDBInstance.create(target)).connect();
}

/**
 * Full rebuild only: the files are the source of truth, so the cheapest
 * correct projection is to throw the database away and write it again.
 */
export async function rebuild(graph: Graph): Promise<{ database: string; tables: TableSummary[] }> {
  const { cfg, schema } = graph;
  const target = absolute(cfg, databasePath(cfg));
  rmSync(target, { force: true });
  rmSync(`${target}.wal`, { force: true });

  const connection = await connect(cfg);
  const tables: TableSummary[] = [];
  const emb = embedder();

  for (const className of [...schema.classes.keys()].sort()) {
    if (!isInstantiable(schema, className)) continue;

    const attributes = effectiveAttributes(schema, className);
    const columns = [
      "uri VARCHAR PRIMARY KEY",
      "id VARCHAR",
      "path VARCHAR",
      ...attributes.map((a) => `${quote(a.name)} ${columnType(schema, a)}`),
    ];
    await connection.run(`CREATE TABLE ${quote(className)} (${columns.join(", ")})`);

    const nodes = [...graph.instances.values()]
      .filter((n) => n.className === className)
      .sort((a, b) => a.uri.localeCompare(b.uri));

    for (const node of nodes) {
      const values = [
        `'${node.uri.replace(/'/g, "''")}'`,
        `'${node.id.replace(/'/g, "''")}'`,
        `'${node.path.replace(/'/g, "''")}'`,
        ...attributes.map((a) => literal(schema, a, node.data[a.name])),
      ];
      await connection.run(`INSERT INTO ${quote(className)} VALUES (${values.join(", ")})`);
    }
    tables.push({ name: className, rows: nodes.length });
  }

  await connection.run("CREATE TABLE edge (subject VARCHAR, relation VARCHAR, object VARCHAR)");
  const edges = [...graph.edges].sort((a, b) =>
    a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to));
  for (const edge of edges) {
    const values = [edge.from, edge.relation, edge.to]
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    await connection.run(`INSERT INTO edge VALUES (${values})`);
  }
  tables.push({ name: "edge", rows: edges.length });

  // Embeddings table: hash-based cache so unchanged bodies skip re-embedding
  // (plan §Phase 7).
  const dimensions = emb.dimensions;
  const vectorCols = Array.from({ length: dimensions }, (_, i) => `v${i} DOUBLE`).join(", ");
  await connection.run(
    `CREATE TABLE embedding (uri VARCHAR PRIMARY KEY, content_hash VARCHAR, ${vectorCols})`,
  );

  const rows: { uri: string; hash: string; vector: Float32Array }[] = [];
  for (const node of graph.instances.values()) {
    const body = stripProtected(node.file.markdown);
    const hash = hashBody(body);
    const vec = await emb.embed(body);
    rows.push({ uri: node.uri, hash, vector: vec });
  }
  rows.sort((a, b) => a.uri.localeCompare(b.uri));
  for (const row of rows) {
    const cols = Array.from(row.vector).map((v) => String(v));
    const values = [`'${row.uri.replace(/'/g, "''")}'`, `'${row.hash}'`, ...cols].join(", ");
    await connection.run(`INSERT INTO embedding VALUES (${values})`);
  }
  tables.push({ name: "embedding", rows: rows.length });

  connection.closeSync();
  return { database: databasePath(cfg), tables };
}

/** Strip the generated protected region so it doesn't pollute the embedding. */
function stripProtected(markdown: string): string {
  return markdown.replace(/<!-- loom:links start -->[\s\S]*?<!-- loom:links end -->/g, "").trim();
}

/** DuckDB returns its own value objects; flatten them for YAML/JSON output. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // DuckDBDate is days since the epoch; DuckDBTimestamp carries micros.
    if (typeof record["days"] === "number") {
      return new Date(record["days"] * 86_400_000).toISOString().slice(0, 10);
    }
    // DuckDB wraps STRUCTs as `{entries: {...}}` and lists as `{items: [...]}`
    // (plan "Later — composite attributes"). Flatten both for plain output.
    if ("entries" in record && record["entries"] !== null && typeof record["entries"] === "object") {
      return plain(record["entries"]);
    }
    if ("items" in record) return plain(record["items"]);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export async function query(cfg: Config, sql: string): Promise<{ rows: unknown[] }> {
  if (!existsSync(absolute(cfg, databasePath(cfg)))) {
    throw new LoomError(error("query/no-database", "no database; run `loom rebuild`"));
  }

  const connection = await connect(cfg);
  try {
    const result = await connection.runAndReadAll(sql);
    return { rows: result.getRowObjects().map((row) => plain(row)) };
  } catch (cause) {
    throw new LoomError(error("query/failed", (cause as Error).message));
  } finally {
    connection.closeSync();
  }
}
