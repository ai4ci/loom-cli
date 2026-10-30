import { stringifyYaml } from "./yaml-scalars.ts";

/** YAML is the default; `--json` switches the same data to JSON (architecture §1.4). */
export type OutputFormat = "yaml" | "json";

export function serialise(value: unknown, format: OutputFormat): string {
  return format === "json" ? `${JSON.stringify(value, null, 2)}\n` : stringifyYaml(value);
}
