import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { absolute, type Config } from "./config.ts";
import { LoomError, error } from "./diagnostics.ts";
import type { Graph } from "./graph.ts";
import { effectiveAttributes, isInstantiable } from "./model/schema.ts";
import { isEnumeration, type Attribute, type SchemaIR } from "./model/types.ts";
import { embedder, hashBody, type Embedder } from "./embeddings.ts";

export const DATABASE_FILENAME = "loom.duckdb";

/** Loom's own directory, holding both checked-in state and derived caches. */
export const LOOM_DIR = ".loom";

export function loomDir(cfg: Config): string {
  return `${cfg.designRoot}/${LOOM_DIR}`;
}

const branchCache = new Map<string, string>();

/**
 * The branch the working tree is on, used as a directory path so that
 * `feat/x` nests naturally rather than needing a sanitised flat name. Git
 * forbids a ref named `feat` alongside `feat/x` for the same reason, so the
 * filesystem layout cannot collide where git would not.
 *
 * Outside a repository there is no branch and `main` is the sensible default;
 * on a detached HEAD the commit stands in for a name, because every detached
 * checkout sharing a directory called `HEAD` would mix unrelated projections.
 */
export function gitBranch(repoRoot: string): string {
  const cached = branchCache.get(repoRoot);
  if (cached !== undefined) return cached;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();

  let branch: string;
  try {
    const name = git("rev-parse", "--abbrev-ref", "HEAD");
    branch = name === "HEAD" ? `detached/${git("rev-parse", "HEAD").slice(0, 12)}` : name;
  } catch {
    branch = "main";
  }

  branchCache.set(repoRoot, branch);
  return branch;
}

export function databasePath(cfg: Config): string {
  return `${loomDir(cfg)}/db/${gitBranch(cfg.repoRoot)}/${DATABASE_FILENAME}`;
}

/**
 * Create the loom directory and the gitignore that excludes the derived
 * databases. Only `db/` is ignored: the rest of `.loom/` is checked in so
 * generated state that must agree with the model travels with the branch.
 */
export function ensureLoomDir(cfg: Config): string {
  const dir = absolute(cfg, loomDir(cfg));
  mkdirSync(dir, { recursive: true });
  const ignoreFile = path.join(dir, ".gitignore");
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, "db/\n");
  return dir;
}

/**
 * Attribute types map to native DuckDB types so comparisons and aggregates
 * need no casts (architecture §6). Enumerations become native DuckDB ENUM types
 * so that ORDER BY, MIN/MAX and the comparison operators follow the order the
 * members are declared in the model rather than alphabetical order. Class-typed
 * attributes become DuckDB STRUCTs so subfields are queryable and misspellings
 * fail loudly (plan "Later — composite attributes").
 *
 * The ENUM type is baked into the database at rebuild time, so editing an
 * enumeration's members in the model requires `loom rebuild` before queries
 * reflect the change.
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
    base = enumMembers(schema, attribute.type.className) === null
      ? "VARCHAR"
      : quote(attribute.type.className);
  } else {
    base = "VARCHAR";
  }
  return attribute.list ? `${base}[]` : base;
}

/**
 * Declared members of an enumeration class, or null when the class is not a
 * usable enumeration. A memberless enumeration is a model error, but `rebuild`
 * does not validate, so fall back to VARCHAR rather than emitting `ENUM()`.
 */
function enumMembers(schema: SchemaIR, className: string): string[] | null {
  const def = schema.classes.get(className);
  if (!def || !isEnumeration(def) || def.members.length === 0) return null;
  return def.members;
}

/** Every enumeration the database needs a type for, in schema order. */
function enumTypes(schema: SchemaIR): { name: string; members: string[] }[] {
  const types: { name: string; members: string[] }[] = [];
  for (const name of [...schema.classes.keys()].sort()) {
    const members = enumMembers(schema, name);
    if (members !== null) types.push({ name, members });
  }
  return types;
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

  if (attribute.type.kind === "enum") {
    // An ENUM column rejects a non-member outright, which would abort the whole
    // rebuild over one bad file. `validate` is the authority on membership, so
    // project the offending value as NULL instead — the same way a malformed
    // int or bool is handled above.
    const members = enumMembers(schema, attribute.type.className);
    if (members !== null && !members.includes(String(value))) return "NULL";
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
  ensureLoomDir(cfg);
  mkdirSync(path.dirname(target), { recursive: true });
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

  // Enum types first: the column definitions below refer to them by name.
  for (const { name, members } of enumTypes(schema)) {
    const values = members.map((m) => `'${m.replace(/'/g, "''")}'`).join(", ");
    try {
      await connection.run(`CREATE TYPE ${quote(name)} AS ENUM (${values})`);
    } catch (cause) {
      connection.closeSync();
      // Almost always a clash with a built-in DuckDB type name (`date`, `blob`,
      // ...). The model is the fixable end, so say so rather than letting a
      // raw catalog error out.
      throw new LoomError(error(
        "query/enum-type",
        `cannot project enumeration "${name}": ${(cause as Error).message}`,
        { fix: `rename the "${name}" enumeration in the model; it collides with a built-in database type` },
      ));
    }
  }

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
  // (architecture §6).
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
