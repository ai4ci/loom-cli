import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { absolute, loadConfig, type Config } from "./config.ts";
import { DesignDocsError } from "./diagnostics.ts";
import { getLinksBlock, parseInstance } from "./document.ts";
import { serialise, type OutputFormat } from "./output.ts";
import { canonicalise, formatUri, fsExists, parseUri, resolveUri } from "./uri.ts";

export interface CliRun {
  code: number;
  out: string;
  err: string;
}

interface GlobalOptions {
  json?: boolean;
  cwd?: string;
}

function formatOf(options: GlobalOptions): OutputFormat {
  return options.json ? "json" : "yaml";
}

function resolveTarget(raw: string, cfg: Config) {
  const uri = parseUri(raw);
  const resolved = resolveUri(uri, cfg, fsExists(cfg));
  return { uri, resolved, absolutePath: absolute(cfg, resolved.path) };
}

function resolveCommand(raw: string, cfg: Config) {
  const { uri, resolved, absolutePath } = resolveTarget(raw, cfg);
  return {
    uri: formatUri(canonicalise(resolved.path, cfg, uri.anchor)),
    scheme: uri.scheme,
    path: resolved.path,
    absolutePath,
    ...(uri.anchor === undefined ? {} : { anchor: uri.anchor }),
    candidates: resolved.candidates,
    ambiguous: resolved.ambiguous,
    exists: existsSync(absolutePath),
  };
}

function showCommand(raw: string, cfg: Config) {
  const { uri, resolved, absolutePath } = resolveTarget(raw, cfg);
  if (!existsSync(absolutePath)) {
    throw new DesignDocsError({
      severity: "error",
      code: "instance/not-found",
      uri: formatUri(uri),
      message: `no file at ${resolved.path}`,
    });
  }

  const file = parseInstance(readFileSync(absolutePath, "utf8"));
  return {
    uri: formatUri(canonicalise(resolved.path, cfg, uri.anchor)),
    path: resolved.path,
    frontmatter: file.frontmatter === null ? null : file.frontmatter.toJS(),
    links: getLinksBlock(file.markdown),
    markdown: file.markdown,
  };
}

export function buildProgram(emit: (text: string) => void): Command {
  const program = new Command();

  program
    .name("design-docs")
    .description("Configurable in-project design documentation")
    .option("--json", "emit JSON instead of YAML")
    .option("--cwd <dir>", "directory to resolve configuration from");

  const withConfig = (action: (raw: string, cfg: Config) => unknown) => (raw: string) => {
    const options = program.opts<GlobalOptions>();
    const cfg = loadConfig(options.cwd ?? process.cwd());
    emit(serialise(action(raw, cfg), formatOf(options)));
  };

  program
    .command("resolve")
    .argument("<uri>", "design uri to resolve")
    .description("resolve a uri to a repo-relative path")
    .action(withConfig(resolveCommand));

  program
    .command("show")
    .argument("<uri>", "design uri of an instance")
    .description("show an instance's frontmatter, links and markdown")
    .action(withConfig(showCommand));

  return program;
}

export function run(argv: string[]): CliRun {
  let out = "";
  let err = "";

  const program = buildProgram((text) => {
    out += text;
  });
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
    return { code: 0, out, err };
  } catch (cause) {
    if (cause instanceof DesignDocsError) {
      return { code: 1, out, err: `${cause.diagnostic.code}: ${cause.message}\n` };
    }
    // commander throws for --help and usage errors, carrying its own exit code.
    const code = (cause as { exitCode?: number }).exitCode;
    if (typeof code === "number") return { code, out, err };
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
