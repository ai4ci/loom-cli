import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Build a throwaway repository from a map of repo-relative path to content.
 * Returns its absolute root.
 */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "loom-"));
  mkdirSync(path.join(root, ".git"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** Frontmatter + optional markdown, as an instance file would be written by hand. */
export function instance(frontmatter: string, markdown = ""): string {
  return `---\n${frontmatter.trim()}\n---\n${markdown}`;
}

/**
 * Build a model with `%% @path <class> <path>` annotations mapping the
 * class schemes used by CLI tests to where their files live in the repo.
 * Tests that need the model for `validate`/`show` etc. compose this with the
 * instance files they create.
 */
export function defaultModel(annotations: Record<string, string> = {}): string {
  const lines = [
    "classDiagram",
    ...Object.entries(annotations).map(([cls, p]) => `    %% @path ${cls} ${p}`),
    "    class issue {",
    "        +string title",
    "        +string status",
    "    }",
    "    class decision {",
    "        +string title",
    "    }",
  ];
  return lines.join("\n") + "\n";
}
