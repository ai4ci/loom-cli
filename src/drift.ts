import { execFileSync } from "node:child_process";
import type { Config } from "./config.ts";
import { type Anchor, type AnchorPolicy, extractAnchors } from "./source.ts";
import { similarity } from "./similarity.ts";

/**
 * Drift tier 2 (source-linkage §6.2): when an anchor stops resolving, compare
 * the file against HEAD. A declaration that existed before under the old name
 * and exists now under a new one, with a near-identical body, is a rename.
 */

/** File content at HEAD, or null outside a repository or for a new file. */
export function contentAtHead(cfg: Config, repoRelative: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${repoRelative}`], {
      cwd: cfg.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Body text with whitespace collapsed, so formatting alone is not a change. */
function bodyFingerprint(code: string, anchor: Anchor): string | null {
  const span = anchor.bodySpan;
  if (!span) return null;
  return code.slice(span.startByte ?? 0, span.endByte ?? 0).replace(/\s+/g, " ").trim();
}

export interface RenameGuess {
  from: string;
  to: string;
  confidence: number;
}

/**
 * Infer what `wanted` was renamed to. A match needs the same kind and a body
 * that is still recognisably the same; a changed body means the declaration was
 * rewritten, not moved, and is reported as missing rather than guessed at.
 */
export function inferRename(
  before: string,
  after: string,
  language: string,
  policy: AnchorPolicy,
  wanted: string,
): RenameGuess | null {
  const oldAnchors = extractAnchors(before, language, policy);
  const newAnchors = extractAnchors(after, language, policy);

  const previous = oldAnchors.find((a) => a.fullName === wanted)
    ?? oldAnchors.find((a) => a.name === wanted.split(".").pop());
  if (previous === undefined) return null;

  const previousBody = bodyFingerprint(before, previous);
  if (previousBody === null || previousBody === "") return null;

  const stillPresent = new Set(newAnchors.map((a) => a.fullName));
  if (stillPresent.has(previous.fullName)) return null;

  let best: RenameGuess | null = null;
  for (const candidate of newAnchors) {
    if (candidate.kind !== previous.kind) continue;
    // A name that was already there before cannot be where this one went.
    if (oldAnchors.some((a) => a.fullName === candidate.fullName)) continue;

    const body = bodyFingerprint(after, candidate);
    if (body === null) continue;

    const confidence = similarity(previousBody, body);
    if (confidence < 0.9) continue;
    if (best === null || confidence > best.confidence) {
      best = { from: previous.fullName, to: candidate.fullName, confidence };
    }
  }

  return best;
}
