import { existsSync } from "node:fs";
import { absolute, type Config } from "./config.ts";
import { LoomError, error } from "./diagnostics.ts";
import { classRoot, normalisePath, type ClassRoots, schemeFor } from "./path-resolution.ts";

export interface ParsedUri {
  scheme: string;
  /** Path relative to the scheme's root, POSIX, no leading slash. */
  path: string;
  /** Symbol anchor for `src`-family URIs (plan §Phase 5). */
  anchor?: string;
}

export interface ResolvedUri {
  /** The repo-relative path the URI addresses. */
  path: string;
  anchor?: string;
}

export type ExistsCheck = (repoRelativePath: string) => boolean;

const URI_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^]*)$/;

export function parseUri(raw: string): ParsedUri {
  const match = URI_RE.exec(raw.trim());
  if (!match) {
    throw new LoomError(
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
    throw new LoomError(
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

/**
 * Resolve a URI to a repo-relative path. Roots come from the schema's
 * resolved class roots, so each scheme has exactly one root — no ambiguity
 * to disambiguate.
 */
export function resolveUri(uri: ParsedUri, roots: ClassRoots): ResolvedUri {
  let resolved: string;
  if (uri.scheme === "repo") {
    resolved = normalisePath(uri.path);
  } else {
    const root = classRoot(roots, uri.scheme);
    resolved = root === "" ? uri.path : normalisePath(`${root}/${uri.path}`);
  }
  return uri.anchor === undefined ? { path: resolved } : { path: resolved, anchor: uri.anchor };
}

/** An existence check backed by the real filesystem. */
export function fsExists(cfg: Config): ExistsCheck {
  return (repoRelative) => existsSync(absolute(cfg, repoRelative));
}

/**
 * The most compact URI for a repo-relative path (plan §2.4): the longest
 * matching class root wins, otherwise `repo://`.
 */
export function canonicalise(repoRelativePath: string, roots: ClassRoots, anchor?: string): ParsedUri {
  const p = normalisePath(repoRelativePath);
  const scheme = schemeFor(roots, p);
  const root = scheme === "repo" ? "" : classRoot(roots, scheme);
  const rest = root === "" ? p : p.slice(root.length + 1);
  return anchor === undefined ? { scheme, path: rest } : { scheme, path: rest, anchor };
}

/** True when two URIs address the same thing, regardless of scheme (plan §IA.13). */
export function equivalent(a: string | ParsedUri, b: string | ParsedUri, roots: ClassRoots): boolean {
  const left = typeof a === "string" ? parseUri(a) : a;
  const right = typeof b === "string" ? parseUri(b) : b;
  if ((left.anchor ?? null) !== (right.anchor ?? null)) return false;
  return resolveUri(left, roots).path === resolveUri(right, roots).path;
}
