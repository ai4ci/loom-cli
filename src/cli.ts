import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { absolute, loadConfig, RESERVED_SCHEMES, type Config } from "./config.ts";
import { DesignDocsError, error, summarise } from "./diagnostics.ts";
import { getLinksBlock, parseInstance } from "./document.ts";
import { applyFixes } from "./fix.ts";
import { loadGraph, validateGraph } from "./graph.ts";
import { validateInstance } from "./instance.ts";
import { loadModel } from "./model/load.ts";
import { writeReport } from "./report.ts";
import { serialise, type OutputFormat } from "./output.ts";
import { canonicalise, formatUri, fsExists, parseUri, resolveUri } from "./uri.ts";

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
  return {
    value: {
      uri: formatUri(canonicalise(resolved.path, cfg, uri.anchor)),
      scheme: uri.scheme,
      path: resolved.path,
      absolutePath,
      ...(uri.anchor === undefined ? {} : { anchor: uri.anchor }),
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

  return program;
}

export function run(argv: string[]): CliRun {
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
    program.parse(argv, { from: "user" });
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
  const result = run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
