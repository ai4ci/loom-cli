import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { DesignDocsError, error } from "./diagnostics.ts";

/** Schemes that address locations rather than classes (plan §2.4). */
export const RESERVED_SCHEMES = new Set(["repo", "design"]);

export const CONFIG_FILENAME = ".design-docs.yaml";

export interface Config {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Repo-relative POSIX path of the design docs folder. */
  designRoot: string;
  /** Repo-relative POSIX roots per class, in precedence order. */
  classRoots: Record<string, string[]>;
  /** Grammars to prefetch (plan §Phase 5). */
  languages: string[];
  configPath: string | null;
}

export interface RawConfig {
  designRoot?: string;
  classRoots?: Record<string, string | string[]>;
  languages?: string[];
}

/** Normalise a configured path to a repo-relative POSIX path with no trailing slash. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function configFrom(repoRoot: string, raw: RawConfig, configPath: string | null = null): Config {
  const classRoots: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw.classRoots ?? {})) {
    classRoots[name] = (Array.isArray(value) ? value : [value]).map(toPosix);
  }
  return {
    repoRoot,
    designRoot: toPosix(raw.designRoot ?? "design"),
    classRoots,
    languages: raw.languages ?? [],
    configPath,
  };
}

/**
 * Roots for a class, in precedence order. An unconfigured class defaults to
 * `<designRoot>/<class>` (plan §1.5).
 */
export function classRootsFor(cfg: Config, className: string): string[] {
  if (RESERVED_SCHEMES.has(className)) {
    throw new DesignDocsError(
      error("config/reserved-scheme", `"${className}" is a reserved scheme, not a class`),
    );
  }
  const configured = cfg.classRoots[className];
  if (configured !== undefined) return configured;
  // Scope §IA.9: src maps to the source tree, not under the design folder.
  if (className === "src") return ["src"];
  return [`${cfg.designRoot}/${className}`];
}

/** Absolute path for a repo-relative path. */
export function absolute(cfg: Config, repoRelative: string): string {
  return path.join(cfg.repoRoot, repoRelative);
}

/**
 * Find the nearest `.design-docs.yaml` by walking up from `startDir`. Absent
 * one, the repo root is the nearest git root and all defaults apply.
 */
export function loadConfig(startDir: string = process.cwd()): Config {
  let dir = path.resolve(startDir);
  let gitRoot: string | null = null;

  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      const raw = (parse(readFileSync(candidate, "utf8")) as RawConfig | null) ?? {};
      return configFrom(dir, raw, candidate);
    }
    if (gitRoot === null && existsSync(path.join(dir, ".git"))) gitRoot = dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return configFrom(gitRoot ?? path.resolve(startDir), {}, null);
}
