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
  /** Indentation the source uses for sequence items, preserved on write. */
  seqIndent: string;
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

  if (!text.startsWith("---\n")) return { frontmatter: null, markdown: text, eol, seqIndent: "" };

  const end = findFrontmatterEnd(text);
  if (end === null) return { frontmatter: null, markdown: text, eol, seqIndent: "" };

  return {
    frontmatter: parseDocument(text.slice(4, end.start)),
    markdown: text.slice(end.after),
    eol,
    // The yaml lib always emits two-space sequence indentation; re-indenting
    // on write would make every untouched list a whitespace-only diff and burn
    // blame history, so remember the file's own style instead.
    seqIndent: seqIndentOf(text.slice(4, end.start)),
  };
}

/** Indentation before the first ` - ` item in the raw frontmatter text. */
function seqIndentOf(frontmatter: string): string {
  const match = /^([ \t]+)\s*(- )/m.exec(frontmatter);
  return match?.[1] ?? "";
}

export function stringifyInstance(file: InstanceFile): string {
  let text: string;
  if (file.frontmatter === null) {
    text = file.markdown;
  } else {
    const body = enforceSafeScalars(file.frontmatter).toString({ lineWidth: 0 });
    text = `---\n${reindentSequences(body, file.seqIndent)}---\n${file.markdown}`;
  }
  return file.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Re-indent sequence items the file originally used. The yaml lib puts items
 * two spaces past the key; shifting every `- ` line to the recorded indent
 * keeps serialised output byte-stable for files that were written by hand.
 */
function reindentSequences(yaml: string, indent: string): string {
  if (indent === "  ") return yaml;
  return yaml.replace(/^(  )(- )/gm, (_match, _pad, dash) => indent + dash);
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
