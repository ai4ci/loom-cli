import path from "node:path";
import { LoomError, error } from "./diagnostics.ts";
import { LINKS_END, LINKS_START } from "./document.ts";
import { classRoot, normalisePath, type ClassRoots, schemeFor } from "./path-resolution.ts";

/**
 * The editable prose of an instance: everything in the markdown that is not
 * the protected link block. Loom owns the block and the frontmatter; the agent
 * owns the prose, and edits it through `splitProse`/`joinProse` so neither of
 * the two protected regions can be damaged by a body edit.
 */
export interface SplitBody {
  /** The protected block verbatim, including its markers, or null when absent. */
  block: string | null;
  /** Everything else, with the leading blank lines removed. */
  prose: string;
}

const LINKS_RE = /<!-- loom:links start -->[\s\S]*?<!-- loom:links end -->/;

export function splitProse(markdown: string): SplitBody {
  const match = LINKS_RE.exec(markdown);
  if (!match) return { block: null, prose: markdown };

  const before = markdown.slice(0, match.index).replace(/^\n+/, "");
  const after = markdown.slice(match.index + match[0].length);
  return { block: match[0], prose: `${before}${after}`.replace(/^\n+/, "") };
}

/**
 * Rebuild the markdown. The block goes back at the top — where `setLinksBlock`
 * puts it — so a document whose block was written mid-prose is normalised, but
 * no prose is ever dropped.
 */
export function joinProse(split: SplitBody): string {
  const prose = split.prose.replace(/^\n+/, "");
  if (split.block === null) return prose;
  return prose === "" ? `\n${split.block}\n` : `\n${split.block}\n\n${prose}`;
}

/** `[text](target)` and `![alt](target)`, with an optional title after the target. */
const LINK_RE = /(!?\[[^\]]*\]\()([^)\s]+)([^)]*\))/g;

/** Anything of the form `scheme:` is a url or a uri, not a relative path. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** `scheme:path`, with the superseded `scheme://path` still accepted. */
const URI_RE = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/)?(.+)$/;

function mapLinks(prose: string, map: (target: string) => string | null): string {
  return prose.replace(LINK_RE, (whole, open: string, target: string, close: string) => {
    const next = map(target);
    return next === null ? whole : `${open}${next}${close}`;
  });
}

function splitFragment(target: string): { base: string; fragment: string } {
  const hash = target.indexOf("#");
  return hash < 0
    ? { base: target, fragment: "" }
    : { base: target.slice(0, hash), fragment: target.slice(hash) };
}

function knownScheme(roots: ClassRoots, scheme: string): boolean {
  if (scheme === "repo") return true;
  const wanted = scheme.toLowerCase();
  for (const key of roots.keys()) {
    if (key.toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * Read direction: the relative links a markdown reader follows become the
 * design uris the agent reasons about. Links that are not repo-relative paths
 * — urls, `mailto:`, in-page `#fragments`, site-absolute paths — are left
 * exactly as written.
 */
export function toUris(
  prose: string,
  docPath: string,
  roots: ClassRoots,
  prefixes?: Map<string, string>,
): string {
  const dir = path.posix.dirname(docPath);

  return mapLinks(prose, (target) => {
    // An absolute url matching a declared prefix canonicalises to a curie.
    if (prefixes !== undefined) {
      for (const [name, target0] of prefixes) {
        if (target.startsWith(target0)) {
          return `${name}:${target.slice(target0.length)}`;
        }
      }
    }
    if (HAS_SCHEME.test(target) || target.startsWith("#") || target.startsWith("/")) return null;

    const { base, fragment } = splitFragment(target);
    if (base === "") return null;

    const resolved = path.posix.normalize(path.posix.join(dir, base));
    // A link reaching outside the repository has no uri to become.
    if (resolved.startsWith("..")) return null;

    const repoRelative = normalisePath(resolved);
    const scheme = schemeFor(roots, repoRelative);
    const root = scheme === "repo" ? "" : classRoot(roots, scheme);
    const rest = root === "" ? repoRelative : repoRelative.slice(root.length + 1);
    return `${scheme}:${rest}${fragment}`;
  });
}

/**
 * Write direction: design uris become the relative links a markdown reader —
 * and GitHub's renderer — can actually follow. A uri whose scheme is not a
 * class in this model is left alone, so `https://` and friends survive.
 */
export function toRelative(
  prose: string,
  docPath: string,
  roots: ClassRoots,
  prefixes?: Map<string, string>,
): string {
  const dir = path.posix.dirname(docPath);

  return mapLinks(prose, (target) => {
    const { base, fragment } = splitFragment(target);
    const match = URI_RE.exec(base);
    if (!match) return null;

    const scheme = match[1]!.toLowerCase();
    // External prefixes expand to the absolute url, not a repo path.
    const prefix = prefixes?.get(scheme);
    if (prefix !== undefined) return `${prefix}${normalisePath(match[2]!)}${fragment}`;
    if (!knownScheme(roots, scheme)) return null;

    const root = scheme === "repo" ? "" : classRoot(roots, scheme);
    const inner = normalisePath(match[2]!);
    const repoRelative = root === "" ? inner : normalisePath(`${root}/${inner}`);
    return `${path.posix.relative(dir, repoRelative)}${fragment}`;
  });
}

interface Hunk {
  /** Zero-based line the hunk claims to start at. */
  start: number;
  old: string[];
  next: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    const header = HUNK_RE.exec(line);
    if (header) {
      current = { start: Math.max(0, Number(header[1]) - 1), old: [], next: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue; // `---`/`+++` preamble, or junk before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("-")) current.old.push(line.slice(1));
    else if (line.startsWith("+")) current.next.push(line.slice(1));
    else {
      // A context line. Tools that strip trailing whitespace leave it bare.
      const content = line.startsWith(" ") ? line.slice(1) : line;
      current.old.push(content);
      current.next.push(content);
    }
  }

  return hunks;
}

function matchesAt(lines: string[], old: string[], at: number): boolean {
  if (at < 0 || at + old.length > lines.length) return false;
  return old.every((line, i) => lines[at + i] === line);
}

function locate(lines: string[], hunk: Hunk, hint: number): number {
  if (hunk.old.length === 0) return Math.min(Math.max(hint, 0), lines.length);
  if (matchesAt(lines, hunk.old, hint)) return hint;

  for (let at = 0; at + hunk.old.length <= lines.length; at++) {
    if (matchesAt(lines, hunk.old, at)) return at;
  }

  throw new LoomError(error(
    "body/patch-failed",
    `no part of the body matches this hunk's context (expected near line ${hunk.start + 1})`,
    { fix: "re-read the body with `loom body get` and rebuild the diff against it" },
  ));
}

/**
 * Apply a unified diff. Hunk headers are used only as a hint: loom's own
 * `unifiedDiff` emits trailing context beyond the count it reports, and hand-
 * written diffs drift, so a hunk is placed by matching its context exactly.
 * No fuzz — a hunk that does not match is an error and nothing is written.
 */
export function applyUnifiedDiff(text: string, diff: string): string {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    throw new LoomError(error("body/patch-failed", "the patch contains no `@@` hunks"));
  }

  const lines = text.split("\n");
  let drift = 0;

  for (const hunk of hunks) {
    const at = locate(lines, hunk, hunk.start + drift);
    lines.splice(at, hunk.old.length, ...hunk.next);
    drift += hunk.next.length - hunk.old.length;
  }

  return lines.join("\n");
}
