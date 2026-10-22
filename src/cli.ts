import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { absolute, loadConfig, RESERVED_SCHEMES, type Config } from "./config.ts";
import { DesignDocsError, error, summarise } from "./diagnostics.ts";
import { parse as parseYaml } from "yaml";
import { readFileSync as readTextFile } from "node:fs";
import { type Op, parseChangeset } from "./changeset.ts";
import { unifiedDiff } from "./diff.ts";
import { databasePath, query, rebuild } from "./duckdb.ts";
import { cosineSimilarity, embedder } from "./embeddings.ts";
import { indexCommand } from "./index.ts";
import { getLinksBlock, parseInstance } from "./document.ts";
import { applyFixes } from "./fix.ts";
import { commit, planChangeset } from "./mutate.ts";
import { loadGraph, validateGraph } from "./graph.ts";
import { validateInstance } from "./instance.ts";
import { loadModel } from "./model/load.ts";
import { writeReport } from "./report.ts";
import { serialise, type OutputFormat } from "./output.ts";
import { canonicalise, formatUri, fsExists, parseUri, resolveUri } from "./uri.ts";
import { detectLang, extractAnchors, resolveAnchor } from "./source.ts";
import pack from "@xberg-io/tree-sitter-language-pack";
import { resolvePath } from "./graph.ts";

export interface CliRun {
  code: number;
  out: string;
  err: string;
}

/** A command returns data to emit and, optionally, a non-zero exit code. */
interface CommandOutput {
  value: unknown;
  code?: number;
}

interface GlobalOptions {
  json?: boolean;
  cwd?: string;
}

function resolveTarget(raw: string, cfg: Config) {
  const uri = parseUri(raw);
  const resolved = resolveUri(uri, cfg, fsExists(cfg));
  return { uri, resolved, absolutePath: absolute(cfg, resolved.path) };
}

function resolveCommand(cfg: Config, raw: string): CommandOutput {
  const { uri, resolved, absolutePath } = resolveTarget(raw, cfg);
  let line: number | undefined;

  if (existsSync(absolutePath) && uri.anchor) {
    const lang = detectLang(resolved.path);
    if (lang) {
      const code = readFileSync(absolutePath, "utf8");
      const found = resolveAnchor(extractAnchors(code, lang, cfg.anchorPolicy), uri.anchor);
      if (found.ok) {
        line = found.anchor.line;
      } else if (found.reason === "ambiguous") {
        throw new DesignDocsError(error(
          "source/ambiguous-anchor",
          `"${uri.anchor}" matches several declarations in ${resolved.path}`,
          { uri: raw, fix: `qualify it: ${found.candidates.join(" | ")}` },
        ));
      }
    }
  }

  return {
    value: {
      uri: formatUri(canonicalise(resolved.path, cfg, uri.anchor)),
      scheme: uri.scheme,
      path: resolved.path,
      absolutePath,
      ...(uri.anchor === undefined ? {} : { anchor: uri.anchor }),
      ...(line === undefined ? {} : { line }),
      candidates: resolved.candidates,
      ambiguous: resolved.ambiguous,
      exists: existsSync(absolutePath),
    },
  };
}

function readInstance(raw: string, cfg: Config) {
  const { uri, resolved, absolutePath } = resolveTarget(raw, cfg);
  if (!existsSync(absolutePath)) {
    throw new DesignDocsError(error("instance/not-found", `no file at ${resolved.path}`, {
      uri: formatUri(uri),
    }));
  }
  return {
    canonical: canonicalise(resolved.path, cfg, uri.anchor),
    path: resolved.path,
    file: parseInstance(readFileSync(absolutePath, "utf8")),
  };
}

function showCommand(cfg: Config, raw: string): CommandOutput {
  const { canonical, path, file } = readInstance(raw, cfg);
  return {
    value: {
      uri: formatUri(canonical),
      path,
      frontmatter: file.frontmatter === null ? null : file.frontmatter.toJS(),
      links: getLinksBlock(file.markdown),
      markdown: file.markdown,
    },
  };
}

function modelCheckCommand(cfg: Config, override?: string): CommandOutput {
  const model = loadModel(cfg, override);
  const report = summarise(model.diagnostics);
  return { value: { model: model.path, ...report }, code: report.ok ? 0 : 1 };
}

function validateOneCommand(cfg: Config, raw: string, override?: string): CommandOutput {
  const { schema } = loadModel(cfg, override);
  const { canonical, path, file } = readInstance(raw, cfg);

  if (RESERVED_SCHEMES.has(canonical.scheme)) {
    throw new DesignDocsError(error(
      "uri/not-a-class",
      `${path} is not under any class root, so it has no class to validate against`,
      { uri: formatUri(canonical) },
    ));
  }

  const data = (file.frontmatter?.toJS() ?? {}) as Record<string, unknown>;
  const uri = formatUri({ scheme: canonical.scheme, path: canonical.path });
  const report = summarise(validateInstance(schema, cfg, {
    uri,
    className: canonical.scheme,
    data,
  }));
  return { value: { uri, ...report }, code: report.ok ? 0 : 1 };
}

function validateAllCommand(
  cfg: Config,
  options: { model?: string; fix?: boolean },
): CommandOutput {
  const { schema } = loadModel(cfg, options.model);

  const check = () => {
    const { graph, diagnostics } = loadGraph(cfg, schema);
    return { graph, report: summarise([...diagnostics, ...validateGraph(graph)]) };
  };

  let { graph, report } = check();
  let fixed: string[] | undefined;

  if (options.fix) {
    fixed = applyFixes(graph);
    // Re-read from disk so the reported state is the state on disk.
    ({ graph, report } = check());
  }

  // A proposed model is a what-if, so it must not overwrite the report.
  const reportPath = options.model === undefined ? writeReport(cfg, report) : undefined;

  return {
    value: {
      instances: graph.instances.size,
      ...(reportPath === undefined ? {} : { report: reportPath }),
      ...(fixed === undefined ? {} : { fixed }),
      ...report,
    },
    code: report.ok ? 0 : 1,
  };
}

/** `key=value` pairs, with the value read as a yaml scalar. */
function parseAssignments(pairs: string[]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    if (split < 0) {
      throw new DesignDocsError(error("cli/bad-assignment", `expected key=value, got ${pair}`));
    }
    attrs[pair.slice(0, split)] = parseYaml(pair.slice(split + 1));
  }
  return attrs;
}

function applyOps(cfg: Config, ops: Op[], options: { dryRun?: boolean }): CommandOutput {
  const { schema } = loadModel(cfg);
  const plan = planChangeset(cfg, schema, ops);
  const report = summarise(plan.diagnostics);

  if (!report.ok) return { value: report, code: 1 };

  if (options.dryRun) {
    return {
      value: {
        dryRun: true,
        changes: plan.writes.map((write) => ({
          path: write.path,
          action: write.content === null ? "delete" : write.before === null ? "create" : "update",
          diff: unifiedDiff(write.before ?? "", write.content ?? ""),
        })),
        ...report,
      },
    };
  }

  commit(cfg, plan.writes);
  return {
    value: {
      written: plan.writes.filter((w) => w.content !== null).map((w) => w.path),
      removed: plan.writes.filter((w) => w.content === null).map((w) => w.path),
      ...report,
    },
  };
}

async function rebuildCommand(cfg: Config): Promise<CommandOutput> {
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema);
  return { value: await rebuild(graph) };
}

async function queryCommand(cfg: Config, sql: string): Promise<CommandOutput> {
  // A missing database is a stale cache, not a user error: rebuild it.
  if (!existsSync(absolute(cfg, databasePath(cfg)))) await rebuildCommand(cfg);
  return { value: await query(cfg, sql) };
}

async function similarCommand(
  cfg: Config,
  query_: string,
  options: { limit?: number },
): Promise<CommandOutput> {
  if (!existsSync(absolute(cfg, databasePath(cfg)))) await rebuildCommand(cfg);
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema);

  // Determine the query vector. A uri embeds the body of the referenced
  // document (so `similar issue://x.md` finds the most related siblings).
  const emb = embedder();
  let queryVec: Float32Array;
  let queryLabel = "text";
  // Only treat the argument as a uri if it has a scheme separator.
  if (/^[a-zA-Z+.-]+:\/\//.test(query_)) {
    const parsed = parseUri(query_);
    const target = formatUri({ scheme: parsed.scheme, path: parsed.path });
    const node = graph.instances.get(target);
    if (node) {
      const body = stripForEmbed(node.file.markdown);
      queryVec = await emb.embed(body);
      queryLabel = node.uri;
    } else {
      queryVec = await emb.embed(query_);
    }
  } else {
    queryVec = await emb.embed(query_);
  }

  // Score every row from the embedding table.
  const cols = Array.from({ length: emb.dimensions }, (_, i) => `"v${i}"`).join(", ");
  const result = await query(cfg, `SELECT uri, ${cols} FROM embedding`);
  const scored: { uri: string; score: number }[] = [];
  for (const row of result.rows) {
    const rec = row as Record<string, unknown>;
    const vec = new Float32Array(emb.dimensions);
    for (let i = 0; i < emb.dimensions; i++) vec[i] = Number(rec[`v${i}`] ?? 0);
    if (!Number.isFinite(vec[0] ?? NaN)) continue;
    scored.push({ uri: String(rec["uri"]), score: cosineSimilarity(queryVec, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? 10;
  const results = scored.slice(0, limit);

  return {
    value: {
      query: queryLabel,
      ...(queryLabel === "text" ? { queryText: query_ } : {}),
      results,
    },
  };
}

/** Strip the protected region so it doesn't bias the embedding. */
function stripForEmbed(markdown: string): string {
  return markdown.replace(/<!-- design-docs:links start -->[\s\S]*?<!-- design-docs:links end -->/g, "").trim();
}

function applyCommand(cfg: Config, file: string, options: { dryRun?: boolean }): CommandOutput {
  const { ops, diagnostics } = parseChangeset(readTextFile(file, "utf8"));
  if (diagnostics.length > 0) return { value: summarise(diagnostics), code: 1 };
  return applyOps(cfg, ops, options);
}

function refsCommand(cfg: Config, raw: string): CommandOutput {
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema);
  const uri = parseUri(raw);
  const targetCanonical = formatUri(canonicalise(resolvePath(uri, cfg), cfg, uri.anchor));

  // Find all documents with edges pointing to this target or containing reverse links
  const matches = graph.edges.filter((e) => e.to === targetCanonical || e.to.startsWith(`${targetCanonical}#`));

  return {
    value: {
      target: targetCanonical,
      references: matches.map((m) => ({ from: m.from, relation: m.relation })),
    },
  };
}

function prefetchCommand(cfg: Config): CommandOutput {
  const languages = cfg.languages.length > 0 ? cfg.languages : ["mermaid", "typescript", "r", "python"];
  pack.prefetch(languages);
  return {
    value: {
      prefetched: languages,
    },
  };
}

export function buildProgram(emit: (text: string) => void, setCode: (code: number) => void): Command {
  const program = new Command();

  program
    .name("design-docs")
    .description("Configurable in-project design documentation")
    .option("--json", "emit JSON instead of YAML")
    .option("--cwd <dir>", "directory to resolve configuration from");

  const runWith = (action: (cfg: Config, ...args: string[]) => CommandOutput) =>
    (...args: unknown[]) => {
      const options = program.opts<GlobalOptions>();
      const cfg = loadConfig(options.cwd ?? process.cwd());
      // commander passes the Command object last; command options second-last.
      const positional = args.slice(0, -2) as string[];
      const commandOptions = (args.at(-2) ?? {}) as { model?: string };
      const result = action(cfg, ...positional, ...(commandOptions.model === undefined ? [] : [commandOptions.model]));
      emit(serialise(result.value, options.json ? "json" : ("yaml" as OutputFormat)));
      if (result.code) setCode(result.code);
    };

  program
    .command("resolve")
    .argument("<uri>", "design uri to resolve")
    .description("resolve a uri to a repo-relative path")
    .action(runWith(resolveCommand));

  program
    .command("show")
    .argument("<uri>", "design uri of an instance")
    .description("show an instance's frontmatter, links and markdown")
    .action(runWith(showCommand));

  const model = program.command("model").description("document model commands");
  model
    .command("check")
    .option("--model <path>", "check a proposed model instead of the installed one")
    .description("parse and validate the document model")
    .action(runWith(modelCheckCommand));

  program
    .command("validate")
    .argument("[uri]", "design uri of an instance; omit to check the whole repository")
    .option("--model <path>", "validate against a proposed model")
    .option("--fix", "apply the unambiguous repairs")
    .description("validate the repository, or one instance, against the document model")
    .action((uri: string | undefined, commandOptions: { model?: string; fix?: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const cfg = loadConfig(options.cwd ?? process.cwd());
      const result = uri === undefined
        ? validateAllCommand(cfg, commandOptions)
        : validateOneCommand(cfg, uri, commandOptions.model);
      emit(serialise(result.value, options.json ? "json" : ("yaml" as OutputFormat)));
      if (result.code) setCode(result.code);
    });

  const finish = (result: CommandOutput): void => {
    const options = program.opts<GlobalOptions>();
    emit(serialise(result.value, options.json ? "json" : ("yaml" as OutputFormat)));
    if (result.code) setCode(result.code);
  };
  const configNow = () => loadConfig(program.opts<GlobalOptions>().cwd ?? process.cwd());

  program
    .command("apply")
    .argument("<changeset>", "path to a changeset yaml file")
    .option("--dry-run", "show what would be written without writing it")
    .description("apply a changeset transactionally")
    .action((file: string, options: { dryRun?: boolean }) => {
      finish(applyCommand(configNow(), file, options));
    });

  program
    .command("rename")
    .argument("<from>", "current uri")
    .argument("<to>", "new uri")
    .option("--dry-run", "show what would be written without writing it")
    .description("move an instance and rewrite every inbound uri")
    .action((from: string, to: string, options: { dryRun?: boolean }) => {
      finish(applyOps(configNow(), [{ op: "rename", from, to }], options));
    });

  program
    .command("create")
    .argument("<uri>", "uri of the new instance")
    .argument("[assignments...]", "key=value attributes")
    .description("create an instance")
    .action((uri: string, assignments: string[]) => {
      finish(applyOps(configNow(), [{ op: "create", uri, attrs: parseAssignments(assignments) }], {}));
    });

  program
    .command("set")
    .argument("<uri>", "uri of the instance")
    .argument("<assignments...>", "key=value attributes")
    .description("set attributes on an instance")
    .action((uri: string, assignments: string[]) => {
      finish(applyOps(configNow(), [{ op: "set", uri, attrs: parseAssignments(assignments) }], {}));
    });

  for (const verb of ["link", "unlink"] as const) {
    program
      .command(verb)
      .argument("<from>", "source instance uri")
      .argument("<relation>", "relation name")
      .argument("<to>", "target uri")
      .description(`${verb} two instances`)
      .action((from: string, rel: string, to: string) => {
        finish(applyOps(configNow(), [{ op: verb, from, rel, to }], {}));
      });
  }

  program
    .command("delete")
    .argument("<uri>", "uri of the instance")
    .description("delete an instance")
    .action((uri: string) => {
      finish(applyOps(configNow(), [{ op: "delete", uri }], {}));
    });

  program
    .command("rebuild")
    .description("rebuild the derived database from the files")
    .action(async () => {
      finish(await rebuildCommand(configNow()));
    });

  program
    .command("query")
    .argument("<sql>", "sql to run against the derived database")
    .description("query the derived database")
    .action(async (sql: string) => {
      finish(await queryCommand(configNow(), sql));
    });

  program
    .command("refs")
    .argument("<srcUri>", "source code uri to check references for")
    .description("find design documents referencing a source symbol")
    .action((srcUri: string) => {
      finish(refsCommand(configNow(), srcUri));
    });

  program
    .command("prefetch")
    .description("prefetch configured tree-sitter language grammars")
    .action(() => {
      finish(prefetchCommand(configNow()));
    });

  program
    .command("index")
    .option("--check", "exit 1 if any index is stale")
    .description("regenerate navigational indexes")
    .action(async (options: { check?: boolean }) => {
      const result = await indexCommand(configNow(), options);
      if (options.check && result.unchanged.length > 0) {
        finish({ value: { ok: false, stale: result.unchanged }, code: 1 });
        return;
      }
      finish({ value: { updated: result.updated, unchanged: result.unchanged } });
    });

  program
    .command("similar")
    .argument("<query>", "text or uri to search for")
    .option("--limit <n>", "maximum results to return", "10")
    .description("rank documents by semantic similarity to a query or existing uri")
    .action(async (queryArg: string, options: { limit?: string }) => {
      const limit = options.limit !== undefined ? Number(options.limit) : undefined;
      finish(await similarCommand(configNow(), queryArg, { limit }));
    });

  return program;
}

export async function run(argv: string[]): Promise<CliRun> {
  let out = "";
  let err = "";
  let code = 0;

  const program = buildProgram(
    (text) => {
      out += text;
    },
    (next) => {
      code = next;
    },
  );
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return { code, out, err };
  } catch (cause) {
    if (cause instanceof DesignDocsError) {
      return { code: 1, out, err: `${cause.diagnostic.code}: ${cause.message}\n` };
    }
    const exitCode = (cause as { exitCode?: number }).exitCode;
    if (typeof exitCode === "number") return { code: exitCode, out, err };
    return { code: 2, out, err: `${(cause as Error).message}\n` };
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.filename.replace(/\.ts$/, ".js") === process.argv[1].replace(/\.ts$/, ".js");

if (invokedDirectly) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
