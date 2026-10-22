import { type Document, parseDocument } from "yaml";
import { enforceSafeScalars } from "./yaml-scalars.ts";

export const LINKS_START = "<!-- loom:links start -->";
export const LINKS_END = "<!-- loom:links end -->";

const LINKS_RE = /<!-- loom:links start -->[\s\S]*?<!-- loom:links end -->/;

export interface InstanceFile {
  /** Comment-preserving YAML document, or null when the file has no frontmatter. */
  frontmatter: Document | null;
  /** Everything after the frontmatter, verbatim, with `\n` line endings. */
  markdown: string;
  /** Line ending of the source, restored on write. */
  eol: "\n" | "\r\n";
}

function findFrontmatterEnd(text: string): { start: number; after: number } | null {
  let i = 4; // past the opening "---\n"
  while (i <= text.length) {
    const nl = text.indexOf("\n", i);
    const line = text.slice(i, nl === -1 ? text.length : nl);
    if (line === "---" || line === "...") {
      return { start: i, after: nl === -1 ? text.length : nl + 1 };
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return null;
}

export function parseInstance(raw: string): InstanceFile {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = eol === "\r\n" ? raw.replace(/\r\n/g, "\n") : raw;

  if (!text.startsWith("---\n")) return { frontmatter: null, markdown: text, eol };

  const end = findFrontmatterEnd(text);
  if (end === null) return { frontmatter: null, markdown: text, eol };

  return {
    frontmatter: parseDocument(text.slice(4, end.start)),
    markdown: text.slice(end.after),
    eol,
  };
}

export function stringifyInstance(file: InstanceFile): string {
  let text: string;
  if (file.frontmatter === null) {
    text = file.markdown;
  } else {
    const body = enforceSafeScalars(file.frontmatter).toString({ lineWidth: 0 });
    text = `---\n${body}---\n${file.markdown}`;
  }
  return file.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Content of the protected link block, or null when there is none. */
export function getLinksBlock(markdown: string): string | null {
  const match = LINKS_RE.exec(markdown);
  if (!match) return null;
  return match[0].slice(LINKS_START.length, match[0].length - LINKS_END.length).trim();
}

/**
 * Replace the protected link block, or insert one ahead of the prose when the
 * document has none. Idempotent for identical content.
 */
export function setLinksBlock(markdown: string, content: string): string {
  const block = `${LINKS_START}\n${content}\n${LINKS_END}`;
  if (LINKS_RE.test(markdown)) return markdown.replace(LINKS_RE, block);

  const rest = markdown.replace(/^\n+/, "");
  return rest === "" ? `\n${block}\n` : `\n${block}\n\n${rest}`;
}
