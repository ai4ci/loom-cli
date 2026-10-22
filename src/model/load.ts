import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { absolute, type Config } from "../config.ts";
import { LoomError, type Diagnostic, error } from "../diagnostics.ts";
import { parseModel } from "./mermaid.ts";
import { validateModel } from "./schema.ts";
import type { SchemaIR } from "./types.ts";

export const MODEL_FILENAME = "document-model.mmd";

export interface LoadedModel {
  /** Absolute path the model was read from. */
  path: string;
  schema: SchemaIR;
  /** Syntax and model-level findings combined. */
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

  const { schema, diagnostics } = parseModel(readFileSync(target, "utf8"));
  return { path: target, schema, diagnostics: [...diagnostics, ...validateModel(schema, cfg)] };
}
