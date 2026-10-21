import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Build a throwaway repository from a map of repo-relative path to content.
 * Returns its absolute root.
 */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "design-docs-"));
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
