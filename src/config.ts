import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { type AnchorPolicy, DEFAULT_ANCHOR_POLICY } from "./source.ts";

/** Schemes that address locations rather than classes (architecture §2.5). */
export const RESERVED_SCHEMES = new Set(["repo"]);

const IGNORED_DIRS = new Set([".git", "node_modules", ".sandbox", ".svn"]);

/**
 * Walk `root` recursively (excluding VCS/metadata directories) looking for
 * files named `document-model.mmd`. Returns absolute paths.
 */
export function findModelFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (entry === "document-model.mmd") results.push(full);
    }
  }
  walk(root);
  return results;
}

/**
 * Determine `$LOOM_DEFAULT_ROOT` by precedence:
 *   1. `.loom.yaml` explicit `designRoot` key
 *   2. `LOOM_DEFAULT_ROOT` environment variable
 *   3. Repo-wide search for `document-model.mmd`
 *   4. Fall back to `"design"`
 */
export function designRootFrom(raw: RawConfig, repoRoot: string): string {
  if (raw.designRoot !== undefined) return raw.designRoot;
  const env = process.env["LOOM_DEFAULT_ROOT"];
  if (env !== undefined && env.length > 0) return env;
  const matches = findModelFiles(repoRoot);
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return toRepoRelative(path.dirname(first), repoRoot);
  if (matches.length > 1 && first !== undefined) {
    // Multiple matches: best-effort — the model loader will re-check and error.
    return toRepoRelative(path.dirname(first), repoRoot);
  }
  return "design";
}

/** Strip the repo root prefix to get a repo-relative POSIX path. */
function toRepoRelative(abs: string, root: string): string {
  let rel = path.relative(root, abs);
  if (rel === "") return ".";
  return rel.replace(/\\/g, "/");
}

/**
 * Repo-level configuration. Class roots are NOT stored here — they come from
 * the document model itself via `path-resolution.ts`. Anything here is either
 * discovered (`repoRoot`, `designRoot`) or env-overridable default behaviour.
 */
export interface Config {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Repo-relative POSIX path of the design docs folder. */
  designRoot: string;
  /** Which source declarations are addressable (source-linkage §2.1). */
  anchorPolicy: AnchorPolicy;
  /** Path of the `.loom.yaml` that produced this config, if any. */
  configPath: string | null;
}

export interface RawConfig {
  designRoot?: string;
  source?: {
    anchorKinds?: string[];
    transparentKinds?: string[];
  };
}

export function configFrom(repoRoot: string, raw: RawConfig, configPath: string | null = null): Config {
  const designRoot = designRootFrom(raw, repoRoot).replace(/\/+$/, "");
  return {
    repoRoot,
    designRoot,
    anchorPolicy: {
      anchorKinds: raw.source?.anchorKinds ?? DEFAULT_ANCHOR_POLICY.anchorKinds,
      transparentKinds: raw.source?.transparentKinds ?? DEFAULT_ANCHOR_POLICY.transparentKinds,
    },
    configPath,
  };
}

/** Absolute path for a repo-relative path. */
export function absolute(cfg: Config, repoRelative: string): string {
  return path.join(cfg.repoRoot, repoRelative);
}

/**
 * Find the nearest `.loom.yaml` by walking up from `startDir`. Absent one, the
 * repo root is the nearest git root and all defaults apply.
 *
 * `.loom.yaml` is now strictly optional: it can override `designRoot` and
 * tweak `anchorPolicy`, but it can never declare class roots (those come from
 * the model) and it no longer names grammars — `loom prefetch` takes those on
 * the command line. The file remains as an escape hatch for unusual
 * repositories.
 */
export function loadConfig(startDir: string = process.cwd()): Config {
  let dir = path.resolve(startDir);
  let gitRoot: string | null = null;
  let raw: RawConfig = {};
  let configPath: string | null = null;

  for (;;) {
    const candidate = path.join(dir, ".loom.yaml");
    if (existsSync(candidate)) {
      raw = parseYaml(candidate) ?? {};
      configPath = candidate;
      if (gitRoot === null && existsSync(path.join(dir, ".git"))) gitRoot = dir;
      break;
    }
    if (gitRoot === null && existsSync(path.join(dir, ".git"))) gitRoot = dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Use the directory containing `.loom.yaml` as the repo root when no git
  // root was found (mirrors the original loadConfig behaviour).
  // LOOM_REPO_ROOT overrides the git root, e.g. one loom per monorepo package.
  const override = process.env["LOOM_REPO_ROOT"];
  const repoRoot = override !== undefined && override.length > 0
    ? path.resolve(override)
    : gitRoot ?? (configPath !== null ? path.dirname(configPath) : path.resolve(startDir));
  return configFrom(repoRoot, raw, configPath);
}

function parseYaml(filePath: string): RawConfig | null {
  return (parse(readFileSync(filePath, "utf8")) as RawConfig | null) ?? null;
}
