import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { type AnchorPolicy, DEFAULT_ANCHOR_POLICY } from "./source.ts";

/** Schemes that address locations rather than classes (plan §2.4). */
export const RESERVED_SCHEMES = new Set(["repo"]);

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
  /** Grammars to prefetch (plan §Phase 5). */
  languages: string[];
  /** Which source declarations are addressable (source-linkage §2.1). */
  anchorPolicy: AnchorPolicy;
  /** Path of the `.loom.yaml` that produced this config, if any. */
  configPath: string | null;
}

export interface RawConfig {
  designRoot?: string;
  languages?: string[];
  source?: {
    anchorKinds?: string[];
    transparentKinds?: string[];
  };
}

export function configFrom(repoRoot: string, raw: RawConfig, configPath: string | null = null): Config {
  return {
    repoRoot,
    designRoot: (raw.designRoot ?? "design").replace(/\/+$/, ""),
    languages: raw.languages ?? [],
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
 * `languages` and tweak `anchorPolicy`, but it can never declare class roots
 * (those come from the model). The file remains as an escape hatch for
 * unusual repositories.
 */
export function loadConfig(startDir: string = process.cwd()): Config {
  let dir = path.resolve(startDir);
  let gitRoot: string | null = null;

  for (;;) {
    const candidate = path.join(dir, ".loom.yaml");
    if (existsSync(candidate)) {
      const raw = parseYaml(candidate) ?? {};
      return configFrom(dir, raw, candidate);
    }
    if (gitRoot === null && existsSync(path.join(dir, ".git"))) gitRoot = dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return configFrom(gitRoot ?? path.resolve(startDir), {}, null);
}

function parseYaml(filePath: string): RawConfig | null {
  return (parse(readFileSync(filePath, "utf8")) as RawConfig | null) ?? null;
}
