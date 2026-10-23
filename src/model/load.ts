import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { absolute, type Config } from "../config.ts";
import { LoomError, type Diagnostic, error } from "../diagnostics.ts";
import {
  classRoot as pickClassRoot,
  extractPathAnnotations,
  resolveClassRoots,
  type ClassRoots,
} from "../path-resolution.ts";
import { parseModel } from "./mermaid.ts";
import { validateModel } from "./schema.ts";
import type { SchemaIR } from "./types.ts";

export const MODEL_FILENAME = "document-model.mmd";

export interface LoadedModel {
  /** Absolute path the model was read from. */
  path: string;
  schema: SchemaIR;
  roots: ClassRoots;
  /** Syntax, model-level and path-resolution findings combined. */
  diagnostics: Diagnostic[];
}

export function defaultModelPath(cfg: Config): string {
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
    throw new LoomError(error("model/not-found", `no document model at ${target}`, {
      fix: `create ${cfg.designRoot}/${MODEL_FILENAME}`,
    }));
  }

  const { schema, diagnostics, comments } = parseModel(readFileSync(target, "utf8"));
  const annotations = extractPathAnnotations(comments);
  const { roots, diagnostics: pathDiagnostics } = resolveClassRoots(
    schema,
    annotations,
    cfg.repoRoot,
    cfg.designRoot,
  );
  const modelDiagnostics = validateModel(schema);
  return {
    path: target,
    schema,
    roots,
    diagnostics: [...diagnostics, ...pathDiagnostics, ...modelDiagnostics],
  };
}

/** Lookup helper retained for backward compat with code that imports it. */
export function classRoot(roots: ClassRoots, name: string): string {
  return pickClassRoot(roots, name);
}
