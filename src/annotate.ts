import pack from "@xberg-io/tree-sitter-language-pack";
import { absolute, classRootsFor, type Config } from "./config.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import {
  type Anchor,
  type AnchorPolicy,
  attributeComment,
  detectLang,
  extractAnchors,
  extractReverseLinks,
  resolveAnchor,
} from "./source.ts";
import { parseUri } from "./uri.ts";

/**
 * Writing reverse links into source (source-linkage §4).
 *
 * A link lives inside the body of the element it refers to, after any leading
 * comments, before the first statement. Insertion points are all resolved
 * against the original buffer and applied descending by offset, so earlier
 * edits cannot move pending ones.
 */

/** Line-comment token per language. Reading uses a permissive regex instead. */
const COMMENT_TOKEN: Record<string, string> = {
  r: "#",
  python: "#",
  ruby: "#",
  perl: "#",
  bash: "#",
  yaml: "#",
  sql: "--",
  lua: "--",
  haskell: "--",
};

export function commentToken(language: string): string {
  return COMMENT_TOKEN[language] ?? "//";
}

export interface SourceEdit {
  /** Repo-relative path. */
  path: string;
  /** Byte offset in the original buffer. */
  offset: number;
  /** Full text to splice in, including its own newline and indentation. */
  text: string;
  /** For a deletion, the number of bytes to remove instead of inserting. */
  removeBytes?: number;
  /** Deterministic tie-break when two edits share an offset. */
  order: string;
  /** What the link is expected to attach to, for post-write verification. */
  anchor: string | null;
  relation: string;
  target: string;
  language: string;
}

interface TsNode {
  kind(): string;
  startByte(): number;
  endByte(): number;
  startPosition(): { row: number; column: number };
  childCount(): number;
  child(index: number): TsNode | null;
  namedChildCount(): number;
  namedChild(index: number): TsNode | null;
  isError(): boolean;
}

function rootOf(code: string, language: string): TsNode | null {
  const tree = pack.getParser(language).parse(code) as unknown as { rootNode(): TsNode } | null;
  return tree ? tree.rootNode() : null;
}

function nodeAt(root: TsNode, startByte: number, endByte: number): TsNode | null {
  let found: TsNode | null = null;
  const walk = (n: TsNode) => {
    if (n.startByte() === startByte && n.endByte() === endByte && found === null) found = n;
    for (let i = 0; i < n.childCount(); i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return found;
}

function countErrors(node: TsNode): number {
  let count = 0;
  const walk = (n: TsNode) => {
    if (n.isError()) count++;
    for (let i = 0; i < n.childCount(); i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return count;
}

function indentAt(code: string, offset: number): string {
  const lineStart = code.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(code.slice(lineStart, offset));
  return match ? match[0] : "";
}

/**
 * Where a link should be written inside `anchor`: before the first non-comment
 * statement of its block. Defined by walking the block's children rather than
 * by byte offset, because a body span starts at the opening brace in C-like
 * languages but at the first statement in Python.
 */
function insertionPoint(
  code: string,
  root: TsNode,
  anchor: Anchor,
): { offset: number; indent: string } | null {
  if (!anchor.bodySpan) return null;

  const body = nodeAt(root, anchor.bodySpan.startByte ?? -1, anchor.bodySpan.endByte ?? -1);
  if (body === null) return null;

  for (let i = 0; i < body.namedChildCount(); i++) {
    const child = body.namedChild(i);
    if (!child || /comment/.test(child.kind())) continue;
    return { offset: child.startByte(), indent: indentAt(code, child.startByte()) };
  }

  // An empty block: insert just after its opening delimiter.
  const first = body.child(0);
  const offset = first && first.childCount() === 0 ? first.endByte() : body.startByte();
  return { offset, indent: `${indentAt(code, body.startByte())}  ` };
}

export interface AnnotationRequest {
  /** `src://` uri, optionally anchored. */
  from: string;
  relation: string;
  to: string;
  remove?: boolean;
  /** Resolve the anchor from a line instead of a `#name`. */
  line?: number;
}

export interface PlannedAnnotation {
  edits: SourceEdit[];
  diagnostics: Diagnostic[];
}

/**
 * Turn annotation requests into edits. Each file is parsed once and every
 * insertion point is resolved against the original buffer.
 */
export function planAnnotations(
  cfg: Config,
  requests: AnnotationRequest[],
  policy: AnchorPolicy,
  read: (repoRelative: string) => string,
): PlannedAnnotation {
  const diagnostics: Diagnostic[] = [];
  const edits: SourceEdit[] = [];
  const parsed = new Map<string, { code: string; root: TsNode; anchors: Anchor[]; language: string }>();

  for (const request of requests) {
    const uri = parseUri(request.from);
    const root = classRootsFor(cfg, uri.scheme)[0]!;
    const repoRelative = `${root}/${uri.path}`;

    let file = parsed.get(repoRelative);
    if (file === undefined) {
      const language = detectLang(repoRelative);
      if (language === null) {
        diagnostics.push(error(
          "source/unsupported-language",
          `no structure available for ${repoRelative}`,
          { uri: request.from },
        ));
        continue;
      }
      let code: string;
      try {
        code = read(repoRelative);
      } catch {
        diagnostics.push(error("source/not-found", `no file at ${repoRelative}`, { uri: request.from }));
        continue;
      }
      const tree = rootOf(code, language);
      if (tree === null) {
        diagnostics.push(error("source/unsupported-language", `cannot parse ${repoRelative}`, {
          uri: request.from,
        }));
        continue;
      }
      file = { code, root: tree, anchors: extractAnchors(code, language, policy), language };
      parsed.set(repoRelative, file);
    }

    // Resolve the target anchor, by name or by line.
    let anchor: Anchor | undefined;
    if (request.line !== undefined) {
      const containing = file.anchors
        .filter((a) => (a.span.startLine ?? 0) + 1 <= request.line!
          && request.line! <= (a.span.endLine ?? 0) + 1)
        .sort((a, b) => (b.span.startByte ?? 0) - (a.span.startByte ?? 0));
      anchor = containing[0];
      if (anchor === undefined) {
        diagnostics.push(error(
          "source/not-annotatable",
          `line ${request.line} of ${repoRelative} has no linkable ancestor`,
          { uri: request.from, fix: "link the file itself, or name an anchor" },
        ));
        continue;
      }
    } else if (uri.anchor !== undefined) {
      const resolved = resolveAnchor(file.anchors, uri.anchor);
      if (!resolved.ok && resolved.reason === "ambiguous") {
        diagnostics.push(error(
          "source/ambiguous-anchor",
          `"${uri.anchor}" matches several declarations in ${repoRelative}`,
          { uri: request.from, fix: `qualify it: ${resolved.candidates.join(" | ")}` },
        ));
        continue;
      }
      if (!resolved.ok) {
        diagnostics.push(error(
          "source/not-annotatable",
          `"${uri.anchor}" is not a linkable declaration in ${repoRelative}`,
          { uri: request.from },
        ));
        continue;
      }
      anchor = resolved.anchor;
    }

    const token = commentToken(file.language);
    const comment = `${token} ${request.relation}: ${request.to}`;

    // Is an equivalent link already present on this anchor?
    const existing = extractReverseLinks(file.code, file.language, policy).find(
      (l) => l.relation === request.relation && l.target === request.to
        && (l.enclosingSymbol ?? null) === (anchor?.fullName ?? null),
    );

    if (request.remove) {
      if (existing === undefined) continue;
      const span = findCommentSpan(file.code, existing.line);
      if (span) {
        edits.push({
          path: repoRelative,
          offset: span.start,
          removeBytes: span.length,
          text: "",
          order: comment,
          anchor: anchor?.fullName ?? null,
          relation: request.relation,
          target: request.to,
          language: file.language,
        });
      }
      continue;
    }

    if (existing !== undefined) continue; // idempotent

    if (anchor === undefined) {
      // File-level: after the leading comment block, which is the same rule
      // with the file as the enclosing element.
      const point = fileInsertionPoint(file.code, file.root);
      edits.push({
        path: repoRelative,
        offset: point.offset,
        text: `${comment}\n`,
        order: comment,
        anchor: null,
        relation: request.relation,
        target: request.to,
        language: file.language,
      });
      continue;
    }

    const point = insertionPoint(file.code, file.root, anchor);
    if (point === null) {
      diagnostics.push(error(
        "source/not-annotatable",
        `"${anchor.fullName}" has no block, so a link cannot be placed inside it`,
        {
          uri: request.from,
          fix: "annotate the enclosing declaration, or use a forward link from the design document",
        },
      ));
      continue;
    }

    edits.push({
      path: repoRelative,
      offset: point.offset,
      text: `${comment}\n${point.indent}`,
      order: comment,
      anchor: anchor.fullName,
      relation: request.relation,
      target: request.to,
      language: file.language,
    });
  }

  return { edits, diagnostics };
}

function fileInsertionPoint(code: string, root: TsNode): { offset: number } {
  for (let i = 0; i < root.namedChildCount(); i++) {
    const child = root.namedChild(i);
    if (!child || /comment|shebang/.test(child.kind())) continue;
    return { offset: child.startByte() };
  }
  return { offset: code.length };
}

function findCommentSpan(code: string, line: number): { start: number; length: number } | null {
  const lines = code.split("\n");
  if (line < 1 || line > lines.length) return null;
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
  return { start: offset, length: (lines[line - 1]?.length ?? 0) + 1 };
}

/**
 * Apply edits to one file. Descending by offset means an earlier splice cannot
 * move the offsets of pending ones.
 */
export function applyEdits(code: string, edits: SourceEdit[]): string {
  const ordered = [...edits].sort(
    (a, b) => b.offset - a.offset || a.order.localeCompare(b.order),
  );
  let result = code;
  for (const edit of ordered) {
    const end = edit.offset + (edit.removeBytes ?? 0);
    result = result.slice(0, edit.offset) + edit.text + result.slice(end);
  }
  return result;
}

/**
 * Re-parse a written file and confirm it still parses and that the link landed
 * where it was meant to. Source gets compiled, so "probably fine" is not good
 * enough.
 */
export function verify(
  before: string,
  after: string,
  language: string,
  policy: AnchorPolicy,
  expected: { relation: string; target: string; anchor: string | null }[],
): Diagnostic[] {
  const beforeRoot = rootOf(before, language);
  const afterRoot = rootOf(after, language);
  if (afterRoot === null) {
    return [error("source/verification-failed", "the written file does not parse")];
  }
  if (countErrors(afterRoot) > countErrors(beforeRoot ?? afterRoot)) {
    return [error("source/verification-failed", "the edit introduced a syntax error")];
  }

  const anchors = extractAnchors(after, language, policy);
  const links = extractReverseLinks(after, language, policy);
  for (const want of expected) {
    const found = links.find((l) => l.relation === want.relation && l.target === want.target);
    if (found === undefined) {
      return [error(
        "source/verification-failed",
        `the written link ${want.relation}: ${want.target} was not found after writing`,
      )];
    }
    if ((found.enclosingSymbol ?? null) !== want.anchor) {
      return [error(
        "source/verification-failed",
        `the written link attached to ${found.enclosingSymbol ?? "the file"}, expected ${want.anchor ?? "the file"}`,
      )];
    }
  }
  void anchors;
  return [];
}
