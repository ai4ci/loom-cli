import { existsSync } from "node:fs";
import { absolute, classRootsFor, type Config } from "./config.ts";
import { DesignDocsError, error } from "./diagnostics.ts";

export interface ParsedUri {
  scheme: string;
  /** Path relative to the scheme's root, POSIX, no leading slash. */
  path: string;
  /** Symbol anchor for `src`-family URIs (plan §Phase 5). */
  anchor?: string;
}

export interface ResolvedUri {
  /** The chosen repo-relative path. */
  path: string;
  /** Every root tried, in precedence order (plan §1.9). */
  candidates: string[];
  /** True when more than one candidate exists on disk. */
  ambiguous: boolean;
  anchor?: string;
}

export type ExistsCheck = (repoRelativePath: string) => boolean;

const URI_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^]*)$/;

/** Collapse `.`, `..` and repeated slashes. Throws if the path escapes its root. */
export function normalisePath(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new DesignDocsError(
          error("uri/escapes-root", `path ${JSON.stringify(raw)} escapes its root`),
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function parseUri(raw: string): ParsedUri {
  const match = URI_RE.exec(raw.trim());
  if (!match) {
    throw new DesignDocsError(
      error("uri/malformed", `not a design uri: ${JSON.stringify(raw)}`),
    );
  }

  const scheme = match[1]!.toLowerCase();
  let rest = match[2]!;
  let anchor: string | undefined;

  const hash = rest.indexOf("#");
  if (hash >= 0) {
    anchor = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  const normalised = normalisePath(rest);
  if (normalised === "") {
    throw new DesignDocsError(
      error("uri/malformed", `design uri has no path: ${JSON.stringify(raw)}`),
    );
  }

  return anchor === undefined
    ? { scheme, path: normalised }
    : { scheme, path: normalised, anchor };
}

export function formatUri(uri: ParsedUri): string {
  const anchor = uri.anchor === undefined ? "" : `#${uri.anchor}`;
  return `${uri.scheme}://${uri.path}${anchor}`;
}

function join(root: string, rest: string): string {
  return normalisePath(root === "" ? rest : `${root}/${rest}`);
}

function candidatePaths(uri: ParsedUri, cfg: Config): string[] {
  if (uri.scheme === "repo") return [normalisePath(uri.path)];
  if (uri.scheme === "design") return [join(cfg.designRoot, uri.path)];
  return classRootsFor(cfg, uri.scheme).map((root) => join(root, uri.path));
}

/**
 * Resolve a URI to a repo-relative path. With several roots configured the
 * first that exists wins, and more than one existing root is flagged as
 * ambiguous (plan §1.9). Without an existence check the first root is taken.
 */
export function resolveUri(uri: ParsedUri, cfg: Config, exists?: ExistsCheck): ResolvedUri {
  const candidates = candidatePaths(uri, cfg);
  let chosen = candidates[0]!;
  let ambiguous = false;

  if (exists) {
    const hits = candidates.filter(exists);
    if (hits.length > 0) {
      chosen = hits[0]!;
      ambiguous = hits.length > 1;
    }
  }

  const resolved: ResolvedUri = { path: chosen, candidates, ambiguous };
  if (uri.anchor !== undefined) resolved.anchor = uri.anchor;
  return resolved;
}

/** An existence check backed by the real filesystem. */
export function fsExists(cfg: Config): ExistsCheck {
  return (repoRelative) => existsSync(absolute(cfg, repoRelative));
}

function under(p: string, root: string): boolean {
  return root !== "" && (p === root || p.startsWith(`${root}/`));
}

/**
 * The most compact URI for a repo-relative path (plan §2.4): the longest
 * matching class root wins, then `design://`, then `repo://`.
 */
export function canonicalise(repoRelativePath: string, cfg: Config, anchor?: string): ParsedUri {
  const p = normalisePath(repoRelativePath);

  let best: { scheme: string; root: string } | null = null;
  for (const [name, roots] of Object.entries(cfg.classRoots)) {
    for (const root of roots) {
      if (under(p, root) && (best === null || root.length > best.root.length)) {
        best = { scheme: name, root };
      }
    }
  }

  const make = (scheme: string, rest: string): ParsedUri =>
    anchor === undefined ? { scheme, path: rest } : { scheme, path: rest, anchor };

  if (best) return make(best.scheme, p.slice(best.root.length + 1));
  if (under(p, cfg.designRoot)) return make("design", p.slice(cfg.designRoot.length + 1));
  return make("repo", p);
}

/** True when two URIs address the same thing, regardless of scheme (plan §IA.13). */
export function equivalent(a: string | ParsedUri, b: string | ParsedUri, cfg: Config): boolean {
  const left = typeof a === "string" ? parseUri(a) : a;
  const right = typeof b === "string" ? parseUri(b) : b;
  if ((left.anchor ?? null) !== (right.anchor ?? null)) return false;
  return resolveUri(left, cfg).path === resolveUri(right, cfg).path;
}
