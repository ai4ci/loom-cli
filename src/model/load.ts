import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { absolute, type Config, findModelFiles } from "../config.ts";
import { LoomError, type Diagnostic, error } from "../diagnostics.ts";
import { extractPathAnnotations, extractPrefixAnnotations, classRoot as pickClassRoot, resolveClassRoots, type ClassRoots } from "../path-resolution.ts";
import { extractViewAnnotations } from "../render.ts";
import { parseModel } from "./mermaid.ts";
import { validateModel } from "./schema.ts";
import type { SchemaIR } from "./types.ts";

import { type ViewAnnotation } from "./types.ts";

export const MODEL_FILENAME = "document-model.mmd";

export interface LoadedModel {
  /** Absolute path the model was read from. */
  path: string;
  schema: SchemaIR;
  roots: ClassRoots;
  views: ViewAnnotation[];
  /** External prefixes from `%% @prefix` annotations. */
  prefixes: Map<string, string>;
  /** Syntax, model-level and path-resolution findings combined. */
  diagnostics: Diagnostic[];
}

function defaultModelPath(cfg: Config): string {
  return absolute(cfg, `${cfg.designRoot}/${MODEL_FILENAME}`);
}

/**
 * Read and validate a model. `override` points at a proposed model so its
 * authoring errors and impact can be checked before it is installed
 * (plan §CLI.9).
 */
export function loadModel(cfg: Config, override?: string): LoadedModel {
  const target = override === undefined
    ? defaultModelPath(cfg)
    : path.resolve(cfg.repoRoot, override);

  if (!existsSync(target)) {
    // If the config didn't find a model and fell back to "design", give a
    // more helpful error that mentions repo-wide search.
    const matches = findModelFiles(cfg.repoRoot);
    if (matches.length === 0) {
      throw new LoomError(error(
        "model/not-found",
        `no document model found — expected ${cfg.designRoot}/${MODEL_FILENAME}`,
        { fix: `create ${MODEL_FILENAME} under a repo-relative path, or set the LOOM_DEFAULT_ROOT environment variable` },
      ));
    }
    if (matches.length > 1) {
      throw new LoomError(error(
        "model/ambiguous",
        `multiple document models found — set LOOM_DEFAULT_ROOT to disambiguate`,
        { fix: `set LOOM_DEFAULT_ROOT to the repo-relative directory containing your ${MODEL_FILENAME}, e.g. LOOM_DEFAULT_ROOT=docs` },
      ));
    }
    throw new LoomError(error("model/not-found", `no document model at ${target}`, {
      fix: `create ${cfg.designRoot}/${MODEL_FILENAME}`,
    }));
  }

  const { schema, diagnostics, comments } = parseModel(readFileSync(target, "utf8"));
  const viewDiagnostics: Diagnostic[] = [];
  const views = extractViewAnnotations(comments, viewDiagnostics);
  const annotations = extractPathAnnotations(comments);
  const prefixes = extractPrefixAnnotations(comments, viewDiagnostics);
  const { roots, diagnostics: pathDiagnostics } = resolveClassRoots(
    schema,
    annotations,
    cfg.repoRoot,
    cfg.designRoot,
  );
  const modelDiagnostics = validateModel(schema);
  return {
    path: target,
    schema: { ...schema, prefixes },
    roots,
    views,
    prefixes,
    diagnostics: [...diagnostics, ...viewDiagnostics, ...pathDiagnostics, ...modelDiagnostics],
  };
}

/** Lookup helper retained for backward compat with code that imports it. */
export function classRoot(roots: ClassRoots, name: string): string {
  return pickClassRoot(roots, name);
}
