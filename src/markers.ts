import { LoomError, error } from "./diagnostics.ts";

/**
 * Inline marker scanning, shared by `render` (which expands markers) and the
 * projection (which stores prose with every marker section collapsed back to
 * its bare opener, so the database holds source text and never generated
 * output — design/inline-views.md §6).
 *
 * Both marker families live in one scan. A marker inside another marker's
 * section is skipped whatever its kind: transcluded prose carries its source
 * document's markers across as text, and text is all they are.
 */

export interface ViewMarker {
  kind: "view";
  /** Raw text from the marker comment (name or inline SQL). */
  view: string;
  /** Parsed query-string parameters. */
  params: Record<string, string>;
  /** Byte offset where the opening `<!-- loom view:` starts. */
  start: number;
  /** Byte offset where the end marker ends (just after the opener if absent). */
  end: number;
}

export interface IncludeMarker {
  kind: "include";
  /** Everything after `loom include:`, verbatim: the end marker repeats it. */
  raw: string;
  /** Uri of the document to transclude. */
  uri: string;
  /** Heading level the include starts at; absent means transclude verbatim. */
  level?: number;
  /** Whether the document's title is emitted as a heading. */
  title: boolean;
  start: number;
  end: number;
}

export type Marker = ViewMarker | IncludeMarker;

const MARKER_RE = /<!--\s*loom[\s:]+(view|include)\s*:\s*(.+?)\s*-->/g;

/**
 * Byte ranges covered by fenced code blocks and inline code spans. A marker
 * inside one is documentation of the syntax, not a view site: expanding it
 * would destroy prose in any file that documents loom itself.
 */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  // Fences: three or more backticks/tildes at line start, closed by a fence of
  // at least the same length. Everything from the opening fence to the closing
  // one (or EOF for an unclosed fence) is off limits.
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: RegExpExecArray | null;
  while ((open = fence.exec(text)) !== null) {
    const char = open[1]![0]!;
    const len = open[1]!.length;
    const from = open.index + open[0].length;
    // Global is load-bearing: exec() IGNORES lastIndex on a plain /m regex,
    // and a bare closing fence matches its own opener — the search then
    // rewound behind the opener and the outer loop spun forever on any
    // untagged fence pair (downstream hang report, 0.10.12).
    const close = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${len},}[ \t]*$`, "gm");
    close.lastIndex = from;
    const end = close.exec(text);
    const stop = end === null ? text.length : end.index + end[0].length;
    ranges.push([open.index, stop]);
    fence.lastIndex = stop;
  }
  // Inline spans: a run of N backticks closed by exactly N. Overlap with the
  // fence ranges is harmless.
  const span = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
  let spanMatch: RegExpExecArray | null;
  while ((spanMatch = span.exec(text)) !== null) {
    ranges.push([spanMatch.index, spanMatch.index + spanMatch[0].length]);
  }
  return ranges;
}

export function inRanges(ranges: [number, number][], at: number): boolean {
  return ranges.some(([from, to]) => at >= from && at < to);
}

/** The first word of an include's arguments: the uri the end marker repeats. */
function includeUri(raw: string): string {
  return raw.split(/\s+/)[0] ?? "";
}

/**
 * Every marker in document order, nested ones skipped. Markers inside code
 * fences or inline code spans are skipped too: they document the syntax
 * rather than use it.
 */
export function scanMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  const code = codeRanges(text);
  const re = new RegExp(MARKER_RE.source, "g");
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (inRanges(code, match.index)) continue;
    const kind = match[1] as "view" | "include";
    const raw = match[2]!.trim();
    // Terminators: bare `end`, or `<name> end` for the marker that owns them.
    if (raw === "end" || raw.endsWith(" end")) continue;

    const name = kind === "view" ? viewName(raw) : includeUri(raw);
    const start = match.index;
    const end = sectionEnd(text, code, kind, name, match.index + match[0].length);

    markers.push(kind === "view"
      ? { kind, ...parseView(raw), start, end }
      : { kind, raw, ...parseInclude(raw), start, end });

    // Everything inside this section belongs to the section, not to the file.
    re.lastIndex = end;
  }

  return markers;
}

/** Markers of one kind, for callers that only handle one. */
export function scanViewMarkers(text: string): ViewMarker[] {
  return scanMarkers(text).filter((m): m is ViewMarker => m.kind === "view");
}

/**
 * The terminator: `<name> end` if present after this opener, else the first
 * bare `end` of the same kind. An unterminated marker is not an error while
 * authoring — its section is empty (render inserts the content and the
 * qualified end right after the opener), so prose below is never eaten.
 */
function sectionEnd(
  text: string,
  code: [number, number][],
  kind: string,
  name: string,
  from: number,
): number {
  const own = new RegExp(`<!--\\s*loom[\\s:]+${kind}\\s*:\\s*${escapeRegExp(name)}\\s+end\\s*-->`);
  const rest = new RegExp(MARKER_RE.source, "g");
  rest.lastIndex = from;
  let candidate: RegExpExecArray | null;
  while ((candidate = rest.exec(text)) !== null) {
    if (inRanges(code, candidate.index)) continue;
    if (candidate[1] !== kind) continue;
    if (own.test(candidate[0]) || candidate[2]!.trim() === "end") {
      return candidate.index + candidate[0].length;
    }
  }
  return from;
}

function viewName(raw: string): string {
  const qs = raw.indexOf("?");
  return qs === -1 ? raw : raw.slice(0, qs).trim();
}

function parseView(raw: string): { view: string; params: Record<string, string> } {
  const qs = raw.indexOf("?");
  if (qs === -1) return { view: raw, params: {} };

  const params: Record<string, string> = {};
  for (const pair of raw.slice(qs + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq !== -1) params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { view: viewName(raw), params };
}

/**
 * `<uri> [h1..h6] [notitle]`. A word the grammar does not know is an error,
 * not a word to ignore: a misspelled `notitle` that silently emitted a title
 * would be found by eye, days later.
 */
function parseInclude(raw: string): { uri: string; level?: number; title: boolean } {
  const [uri, ...rest] = raw.split(/\s+/);
  if (uri === undefined || uri === "") {
    throw new LoomError(error("render/bad-include", "an include needs a document uri", {
      fix: "write <!-- loom include: <uri> [h1..h6] [notitle] -->",
    }));
  }

  let level: number | undefined;
  let title = true;
  for (const word of rest) {
    const heading = /^h([1-6])$/.exec(word);
    if (heading !== null) {
      level = Number(heading[1]);
      continue;
    }
    if (word === "notitle") {
      title = false;
      continue;
    }
    throw new LoomError(error("render/bad-include", `"${word}" is not an include option`, {
      fix: "the options are h1..h6 and notitle",
    }));
  }

  // Verbatim transclusion has no heading to put a title under.
  return { uri, title: level !== undefined && title, ...(level === undefined ? {} : { level }) };
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text of a marker's opening comment, without its section. */
function opener(text: string, marker: Marker): string {
  const close = text.indexOf("-->", marker.start);
  return close === -1 ? text.slice(marker.start) : text.slice(marker.start, close + 3);
}

export function endMarker(marker: Marker): string {
  return marker.kind === "view"
    ? `<!-- loom view: ${marker.view} end -->`
    : `<!-- loom include: ${marker.raw} end -->`;
}

export function updateSection(text: string, marker: Marker, rendered: string): string {
  const head = text.slice(0, marker.start);
  const tail = text.slice(marker.end);
  const open = opener(text, marker);
  const section = rendered ? `${open}\n\n${rendered}\n` : `${open}\n`;
  return `${head}${section}${endMarker(marker)}${tail}`;
}

/**
 * Every marker section reduced to its bare opener. This is what the database
 * stores: generated output is never a source of truth, so transcluding a
 * document can never copy another document's expansion.
 */
export function collapseSections(text: string): string {
  let out = "";
  let at = 0;
  for (const marker of scanMarkers(text)) {
    out += text.slice(at, marker.start) + opener(text, marker);
    at = marker.end;
  }
  return out + text.slice(at);
}
