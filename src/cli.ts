import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { absolute, loadConfig, RESERVED_SCHEMES, type Config } from "./config.ts";
import { LoomError, error, summarise } from "./diagnostics.ts";
import { parse as parseYaml } from "yaml";
import { readFileSync as readTextFile } from "node:fs";
import { type Op, parseChangeset } from "./changeset.ts";
import { listUri, locateLine } from "./browse.ts";
import { unifiedDiff } from "./diff.ts";
import { databasePath, query, rebuild } from "./duckdb.ts";
import { cosineSimilarity, embedder } from "./embeddings.ts";
import { indexCommand } from "./index.ts";
import { getLinksBlock, parseInstance } from "./document.ts";
import { applyFixes } from "./fix.ts";
import { commit, planChangeset } from "./mutate.ts";
import { loadGraph, resolvePath, validateGraph } from "./graph.ts";
import { validateInstance } from "./instance.ts";
import { loadModel } from "./model/load.ts";
import { writeReport } from "./report.ts";
import { serialise, type OutputFormat } from "./output.ts";
import { canonicalise, formatUri, parseUri, resolveUri } from "./uri.ts";
import { detectLang, extractAnchors, resolveAnchor } from "./source.ts";
import type { ClassRoots } from "./path-resolution.ts";
import pack from "@xberg-io/tree-sitter-language-pack";

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

interface LoadedContext {
  cfg: Config;
  roots: ClassRoots;
}

function loadContext(startDir?: string): LoadedContext {
  const cfg = loadConfig(startDir ?? process.cwd());
  return { cfg, roots: loadModel(cfg).roots };
}

function resolveTarget(raw: string, ctx: LoadedContext) {
  const uri = parseUri(raw);
  const resolved = resolveUri(uri, ctx.roots);
  return { uri, resolved, absolutePath: absolute(ctx.cfg, resolved.path) };
}

function resolveCommand(ctx: LoadedContext, raw: string): CommandOutput {
  const { cfg, roots } = ctx;
  const { uri, resolved, absolutePath } = resolveTarget(raw, ctx);
  let line: number | undefined;

  if (existsSync(absolutePath) && uri.anchor) {
    const lang = detectLang(resolved.path);
    if (lang) {
      const code = readFileSync(absolutePath, "utf8");
      const found = resolveAnchor(extractAnchors(code, lang, cfg.anchorPolicy), uri.anchor);
      if (found.ok) {
        line = found.anchor.line;
      } else if (found.reason === "ambiguous") {
        throw new LoomError(error(
          "source/ambiguous-anchor",
          `"${uri.anchor}" matches several declarations in ${resolved.path}`,
          { uri: raw, fix: `qualify it: ${found.candidates.join(" | ")}` },
        ));
      }
    }
  }

  return {
    value: {
      uri: formatUri(canonicalise(resolved.path, roots, uri.anchor)),
      scheme: uri.scheme,
      path: resolved.path,
      absolutePath,
      ...(uri.anchor === undefined ? {} : { anchor: uri.anchor }),
      ...(line === undefined ? {} : { line }),
      exists: existsSync(absolutePath),
    },
  };
}

function readInstance(raw: string, ctx: LoadedContext) {
  const { roots } = ctx;
  const { uri, resolved, absolutePath } = resolveTarget(raw, ctx);
  if (!existsSync(absolutePath)) {
    throw new LoomError(error("instance/not-found", `no file at ${resolved.path}`, {
      uri: formatUri(uri),
    }));
  }
  return {
    canonical: canonicalise(resolved.path, roots, uri.anchor),
    path: resolved.path,
    file: parseInstance(readFileSync(absolutePath, "utf8")),
  };
}

function showCommand(ctx: LoadedContext, raw: string): CommandOutput {
  const { canonical, path, file } = readInstance(raw, ctx);
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

function validateOneCommand(ctx: LoadedContext, raw: string, override?: string): CommandOutput {
  const { cfg, roots } = ctx;
  const { schema } = loadModel(cfg, override);
  const { canonical, path, file } = readInstance(raw, ctx);

  if (RESERVED_SCHEMES.has(canonical.scheme)) {
    throw new LoomError(error(
      "uri/not-a-class",
      `${path} is not under any class root, so it has no class to validate against`,
      { uri: formatUri(canonical) },
    ));
  }

  const data = (file.frontmatter?.toJS() ?? {}) as Record<string, unknown>;
  const uri = formatUri({ scheme: canonical.scheme, path: canonical.path });
  const report = summarise(validateInstance(schema, {
    uri,
    className: canonical.scheme,
    data,
  }));
  return { value: { uri, ...report }, code: report.ok ? 0 : 1 };
}

function validateAllCommand(
  ctx: LoadedContext,
  options: { model?: string; fix?: boolean },
): CommandOutput {
  const { cfg } = ctx;
  const { schema, roots } = loadModel(cfg, options.model);

  const check = () => {
    const { graph, diagnostics } = loadGraph(cfg, schema, roots);
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
      throw new LoomError(error("cli/bad-assignment", `expected key=value, got ${pair}`));
    }
    attrs[pair.slice(0, split)] = parseYaml(pair.slice(split + 1));
  }
  return attrs;
}

function applyOps(ctx: LoadedContext, ops: Op[], options: { dryRun?: boolean }): CommandOutput {
  const { cfg, roots } = ctx;
  const { schema } = loadModel(cfg);
  const plan = planChangeset(cfg, schema, roots, ops);
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

async function rebuildCommand(ctx: LoadedContext): Promise<CommandOutput> {
  const { cfg, roots } = ctx;
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema, roots);
  return { value: await rebuild(graph) };
}

async function queryCommand(ctx: LoadedContext, sql: string): Promise<CommandOutput> {
  const { cfg } = ctx;
  if (!existsSync(absolute(cfg, databasePath(cfg)))) await rebuildCommand(ctx);
  return { value: await query(cfg, sql) };
}

async function similarCommand(
  ctx: LoadedContext,
  query_: string,
  options: { limit?: number },
): Promise<CommandOutput> {
  const { cfg } = ctx;
  if (!existsSync(absolute(cfg, databasePath(cfg)))) await rebuildCommand(ctx);
  const { schema, roots } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema, roots);

  const emb = embedder();
  let queryVec: Float32Array;
  let queryLabel = "text";
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

function stripForEmbed(markdown: string): string {
  return markdown.replace(/<!-- loom:links start -->[\s\S]*?<!-- loom:links end -->/g, "").trim();
}

function applyCommand(ctx: LoadedContext, file: string, options: { dryRun?: boolean }): CommandOutput {
  const { ops, diagnostics } = parseChangeset(readTextFile(file, "utf8"));
  if (diagnostics.length > 0) return { value: summarise(diagnostics), code: 1 };
  return applyOps(ctx, ops, options);
}

function lsCommand(
  ctx: LoadedContext,
  raw: string,
  options: { depth?: string; kind?: string; linked?: boolean; unlinked?: boolean },
): CommandOutput {
  const { cfg, roots } = ctx;
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema, roots);
  return {
    value: listUri(cfg, graph, raw, {
      depth: options.depth === undefined ? 1 : Number(options.depth),
      ...(options.kind === undefined ? {} : { kinds: options.kind.split(",").map((k) => k.trim()) }),
      ...(options.linked ? { linked: true } : {}),
      ...(options.unlinked ? { unlinked: true } : {}),
    }),
  };
}

function locateCommand(ctx: LoadedContext, raw: string, options: { line?: string }): CommandOutput {
  if (options.line === undefined) {
    throw new LoomError(error("cli/missing-option", "locate needs --line <n>"));
  }
  return { value: locateLine(ctx.cfg, ctx.roots, raw, Number(options.line)) };
}

function refsCommand(ctx: LoadedContext, raw: string): CommandOutput {
  const { cfg, roots } = ctx;
  const { schema } = loadModel(cfg);
  const { graph } = loadGraph(cfg, schema, roots);
  const uri = parseUri(raw);
  const targetCanonical = formatUri(canonicalise(resolveUri(uri, roots).path, roots, uri.anchor));

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
    .name("loom")
    .description("Model-driven markdown documentation graph")
    .option("--json", "emit JSON instead of YAML")
    .option("--cwd <dir>", "directory to resolve configuration from");

  const finish = (result: CommandOutput): void => {
    const options = program.opts<GlobalOptions>();
    emit(serialise(result.value, options.json ? "json" : ("yaml" as OutputFormat)));
    if (result.code) setCode(result.code);
  };
  const ctx = () => loadContext(program.opts<GlobalOptions>().cwd);
  const cfg = () => ctx().cfg;

  program
    .command("resolve")
    .argument("<uri>", "design uri to resolve")
    .description("resolve a uri to a repo-relative path")
    .action((raw: string) => finish(resolveCommand(ctx(), raw)));

  program
    .command("show")
    .argument("<uri>", "design uri of an instance")
    .description("show an instance's frontmatter, links and markdown")
    .action((raw: string) => finish(showCommand(ctx(), raw)));

  const model = program.command("model").description("document model commands");
  model
    .command("check")
    .option("--model <path>", "check a proposed model instead of the installed one")
    .description("parse and validate the document model")
    .action((options: { model?: string }) => finish(modelCheckCommand(cfg(), options.model)));

  program
    .command("validate")
    .argument("[uri]", "design uri of an instance; omit to check the whole repository")
    .option("--model <path>", "validate against a proposed model")
    .option("--fix", "apply the unambiguous repairs")
    .description("validate the repository, or one instance, against the document model")
    .action((uri: string | undefined, options: { model?: string; fix?: boolean }) => {
      const result = uri === undefined
        ? validateAllCommand(ctx(), options)
        : validateOneCommand(ctx(), uri, options.model);
      finish(result);
    });

  program
    .command("apply")
    .argument("<changeset>", "path to a changeset yaml file")
    .option("--dry-run", "show what would be written without writing it")
    .description("apply a changeset transactionally")
    .action((file: string, options: { dryRun?: boolean }) => {
      finish(applyCommand(ctx(), file, options));
    });

  program
    .command("rename")
    .argument("<from>", "current uri")
    .argument("<to>", "new uri")
    .option("--dry-run", "show what would be written without writing it")
    .description("move an instance and rewrite every inbound uri")
    .action((from: string, to: string, options: { dryRun?: boolean }) => {
      finish(applyOps(ctx(), [{ op: "rename", from, to }], options));
    });

  program
    .command("create")
    .argument("<uri>", "uri of the new instance")
    .argument("[assignments...]", "key=value attributes")
    .description("create an instance")
    .action((uri: string, assignments: string[]) => {
      finish(applyOps(ctx(), [{ op: "create", uri, attrs: parseAssignments(assignments) }], {}));
    });

  program
    .command("set")
    .argument("<uri>", "uri of the instance")
    .argument("<assignments...>", "key=value attributes")
    .description("set attributes on an instance")
    .action((uri: string, assignments: string[]) => {
      finish(applyOps(ctx(), [{ op: "set", uri, attrs: parseAssignments(assignments) }], {}));
    });

  for (const verb of ["link", "unlink"] as const) {
    program
      .command(verb)
      .argument("<from>", "source instance uri")
      .argument("<relation>", "relation name")
      .argument("<to>", "target uri")
      .option("--line <n>", "resolve the subject anchor from a line number")
      .description(`${verb} two instances, or source to a document`)
      .action((from: string, rel: string, to: string, options: { line?: string }) => {
        const op = options.line === undefined
          ? { op: verb, from, rel, to }
          : { op: verb, from, rel, to, line: Number(options.line) };
        finish(applyOps(ctx(), [op], {}));
      });
  }

  program
    .command("delete")
    .argument("<uri>", "uri of the instance")
    .description("delete an instance")
    .action((uri: string) => {
      finish(applyOps(ctx(), [{ op: "delete", uri }], {}));
    });

  program
    .command("rebuild")
    .description("rebuild the derived database from the files")
    .action(async () => finish(await rebuildCommand(ctx())));

  program
    .command("query")
    .argument("<sql>", "sql to run against the derived database")
    .description("query the derived database")
    .action(async (sql: string) => finish(await queryCommand(ctx(), sql)));

  program
    .command("refs")
    .argument("<srcUri>", "source code uri to check references for")
    .description("find design documents referencing a source symbol")
    .action((srcUri: string) => finish(refsCommand(ctx(), srcUri)));

  program
    .command("ls")
    .argument("<uri>", "class, directory, file or anchor to list below")
    .option("--depth <n>", "how far to descend", "1")
    .option("--kind <kinds>", "comma-separated structure kinds to keep")
    .option("--linked", "only entries a design document already points at")
    .option("--unlinked", "only entries nothing points at")
    .description("list what can be linked to")
    .action((uri: string, options: { depth?: string; kind?: string; linked?: boolean; unlinked?: boolean }) => {
      finish(lsCommand(ctx(), uri, options));
    });

  program
    .command("locate")
    .argument("<uri>", "source file uri")
    .option("--line <n>", "line number to locate")
    .description("the address of a line: its innermost linkable ancestor")
    .action((uri: string, options: { line?: string }) => {
      finish(locateCommand(ctx(), uri, options));
    });

  program
    .command("prefetch")
    .description("prefetch configured tree-sitter language grammars")
    .action(() => finish(prefetchCommand(cfg())));

  program
    .command("index")
    .option("--check", "exit 1 if any index is stale")
    .description("regenerate navigational indexes")
    .action(async (options: { check?: boolean }) => {
      const result = await indexCommand(ctx(), options);
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
      finish(await similarCommand(ctx(), queryArg, { limit }));
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
    if (cause instanceof LoomError) {
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
