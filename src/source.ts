import pack from "@xberg-io/tree-sitter-language-pack";
import type { Span, StructureItem } from "@xberg-io/tree-sitter-language-pack";

/**
 * Addressing source code (design/source-linkage.md).
 *
 * A linkable anchor is a named structural item whose kind is in the configured
 * allowlist, addressed by its dotted path from the file root. Anchors must
 * resolve uniquely; overloads are separated by a normalised parameter type
 * list. A reverse-link comment attaches to the innermost anchor whose *body*
 * contains it.
 */

export interface AnchorPolicy {
  /** Kinds that are addressable. */
  anchorKinds: string[];
  /** Kinds that are not addressable but whose children still count. */
  transparentKinds: string[];
}

export const DEFAULT_ANCHOR_POLICY: AnchorPolicy = {
  anchorKinds: ["Function", "Method", "Class", "Struct", "Interface", "Enum", "Trait"],
  transparentKinds: ["Impl", "Module", "Namespace"],
};

export interface Anchor {
  name: string;
  /** Dotted path from the file root. */
  fullName: string;
  kind: string;
  /** 1-indexed line of the declaration. */
  line: number;
  span: Span;
  /** The block. Absent when the declaration has none, which means it cannot be annotated. */
  bodySpan?: Span;
  /** Normalised parameter types, computed only when a name collides. */
  params?: string[];
}

export interface ReverseLink {
  relation: string;
  target: string;
  line: number;
  enclosingSymbol?: string;
}

const REVERSE_LINK_RE =
  /^\s*(?:\/\/|#|--|\/\*)\s*([a-zA-Z0-9_-]+)\s*:\s*([a-zA-Z0-9+.-]+:\/\/\S+?)(?:\s*\*\/)?\s*$/;

/** Minimal structural view of a tree-sitter node. */
interface TsNode {
  kind(): string;
  startByte(): number;
  endByte(): number;
  startPosition(): { row: number; column: number };
  endPosition(): { row: number; column: number };
  childCount(): number;
  child(index: number): TsNode | null;
  namedChildCount(): number;
  namedChild(index: number): TsNode | null;
  childByFieldName(name: string): TsNode | null;
}

export function detectLang(filename: string): string | null {
  return pack.detectLanguageFromPath(filename);
}

function parse(code: string, language: string): TsNode | null {
  const tree = pack.getParser(language).parse(code) as unknown as { rootNode(): TsNode } | null;
  return tree ? tree.rootNode() : null;
}

function spanOf(node: TsNode): Span {
  return {
    startByte: node.startByte(),
    endByte: node.endByte(),
    startLine: node.startPosition().row,
    startColumn: node.startPosition().column,
    endLine: node.endPosition().row,
    endColumn: node.endPosition().column,
  };
}

function walkNodes(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount(); i++) {
    const child = node.child(i);
    if (child) walkNodes(child, visit);
  }
}

// --- parameter types -------------------------------------------------------

/**
 * Reduce a type expression to a stable form: no whitespace, no leading colon,
 * and every dotted path reduced to its last segment. Generic arguments are
 * kept, since C# reifies them and erasure would wrongly collide overloads.
 */
function normaliseType(text: string): string {
  const stripped = text.replace(/^\s*:\s*/, "").replace(/\s+/g, "");
  return stripped.replace(/[A-Za-z_$][\w$]*(?:[.:]{1,2}[A-Za-z_$][\w$]*)+/g, (path) => {
    const segments = path.split(/[.:]+/);
    return segments[segments.length - 1] ?? path;
  });
}

function typeOfParameter(node: TsNode, code: string): string {
  const field = node.childByFieldName("type");
  if (field) return normaliseType(code.slice(field.startByte(), field.endByte()));

  // Varargs carry the type as a child rather than in a `type` field.
  for (let i = 0; i < node.namedChildCount(); i++) {
    const child = node.namedChild(i);
    if (child && /type/.test(child.kind())) {
      const base = normaliseType(code.slice(child.startByte(), child.endByte()));
      return /spread|variadic|rest/.test(node.kind()) ? `${base}[]` : base;
    }
  }
  return "_";
}

/** Node kinds that hold a parameter list, measured across the supported languages. */
const PARAMETER_CONTAINER = /^(formal_parameters|parameter_list|parameters)$/;

/**
 * Parameter types for every declaration in the file, keyed by span. Built in a
 * single walk so that qualifying an overload costs one pass, not one per
 * anchor.
 */
function collectParameters(root: TsNode, code: string): Map<string, string[]> {
  const bySpan = new Map<string, string[]>();

  walkNodes(root, (node) => {
    let container: TsNode | null = null;
    for (let i = 0; i < node.namedChildCount(); i++) {
      const child = node.namedChild(i);
      if (child && PARAMETER_CONTAINER.test(child.kind())) {
        container = child;
        break;
      }
    }
    if (container === null) return;

    const types: string[] = [];
    for (let i = 0; i < container.namedChildCount(); i++) {
      const parameter = container.namedChild(i);
      if (!parameter || /comment/.test(parameter.kind())) continue;
      types.push(typeOfParameter(parameter, code));
    }
    bySpan.set(`${node.startByte()}:${node.endByte()}`, types);
  });

  return bySpan;
}

// --- anchor extraction -----------------------------------------------------

function kindName(kind: StructureItem["kind"]): string {
  if (typeof kind === "string") return kind;
  const record = kind as unknown as { type?: string; other?: string };
  return record.type ?? record.other ?? "Other";
}

function fromStructure(
  items: StructureItem[] | undefined,
  policy: AnchorPolicy,
  prefix: string,
  out: Anchor[],
): void {
  for (const item of items ?? []) {
    const kind = kindName(item.kind);

    if (policy.transparentKinds.includes(kind) || !item.name || !item.span) {
      // Not addressable, but what is inside it still is.
      fromStructure(item.children, policy, prefix, out);
      continue;
    }
    if (!policy.anchorKinds.includes(kind)) {
      fromStructure(item.children, policy, prefix, out);
      continue;
    }

    const fullName = prefix === "" ? item.name : `${prefix}.${item.name}`;
    const anchor: Anchor = {
      name: item.name,
      fullName,
      kind,
      line: (item.span.startLine ?? 0) + 1,
      span: item.span,
    };
    if (item.bodySpan) anchor.bodySpan = item.bodySpan;
    out.push(anchor);
    fromStructure(item.children, policy, fullName, out);
  }
}

/**
 * R adapter. `process()` names every R function "function" — the keyword, not
 * the binding — so anchors are derived from the syntax tree instead
 * (source-linkage §2.6).
 */
function fromR(code: string, out: Anchor[]): void {
  const root = parse(code, "r");
  if (!root) return;
  const text = (n: TsNode) => code.slice(n.startByte(), n.endByte());

  const bodyOf = (fn: TsNode): Span | undefined => {
    for (let i = 0; i < fn.namedChildCount(); i++) {
      const child = fn.namedChild(i);
      if (child && child.kind() === "braced_expression") return spanOf(child);
    }
    return undefined; // a one-liner has no block, so it cannot be annotated
  };

  const emit = (name: string, prefix: string, declaration: TsNode, fn: TsNode): string => {
    const fullName = prefix === "" ? name : `${prefix}.${name}`;
    const anchor: Anchor = {
      name,
      fullName,
      kind: "Function",
      line: declaration.startPosition().row + 1,
      span: spanOf(declaration),
    };
    const body = bodyOf(fn);
    if (body) anchor.bodySpan = body;
    out.push(anchor);
    return fullName;
  };

  const walk = (node: TsNode, prefix: string): void => {
    if (node.kind() === "binary_operator") {
      const left = node.child(0);
      const operator = node.child(1);
      const right = node.child(2);
      const op = operator ? text(operator).trim() : "";

      // Only a binding introduces a name. A call on the left (S7's
      // `method(generic, class) <-`) would yield an anchor whose spelling
      // collides with the overload qualifier, so it is not one.
      if (left?.kind() === "identifier" && (op === "<-" || op === "=")) {
        const name = text(left);
        const scope = right?.kind() === "function_definition"
          ? emit(name, prefix, node, right)
          : (prefix === "" ? name : `${prefix}.${name}`);
        if (right) walk(right, scope);
        return;
      }
    }

    // A named call argument whose value is a function: R6 methods and S7
    // validators/constructors are the same shape.
    if (node.kind() === "argument") {
      const first = node.namedChild(0);
      let fn: TsNode | null = null;
      for (let i = 0; i < node.namedChildCount(); i++) {
        const child = node.namedChild(i);
        if (child && child.kind() === "function_definition") fn = child;
      }
      if (fn && first && first.kind() === "identifier" && first !== fn) {
        const scope = emit(text(first), prefix, node, fn);
        walk(fn, scope);
        return;
      }
    }

    for (let i = 0; i < node.childCount(); i++) {
      const child = node.child(i);
      if (child) walk(child, prefix);
    }
  };

  walk(root, "");
}

export function extractAnchors(
  code: string,
  language: string,
  policy: AnchorPolicy = DEFAULT_ANCHOR_POLICY,
): Anchor[] {
  const anchors: Anchor[] = [];
  if (language === "r") {
    fromR(code, anchors);
  } else {
    const result = pack.process(code, { language, structure: true });
    fromStructure(result.structure, policy, "", anchors);
  }

  const root = parse(code, language);
  if (root) {
    const bySpan = collectParameters(root, code);
    for (const anchor of anchors) {
      const params = bySpan.get(`${anchor.span.startByte}:${anchor.span.endByte}`);
      if (params !== undefined) anchor.params = params;
    }
  }

  return anchors;
}

// --- resolution ------------------------------------------------------------

export type Resolution =
  | { ok: true; anchor: Anchor }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

export function qualifiedName(anchor: Anchor): string {
  return anchor.params === undefined
    ? anchor.fullName
    : `${anchor.fullName}(${anchor.params.join(",")})`;
}

function splitSpec(spec: string): { path: string; params: string[] | null } {
  const match = /^(.*?)\(([^)]*)\)$/.exec(spec.trim());
  if (!match) return { path: spec.trim(), params: null };
  const inner = match[2]!.trim();
  return {
    path: match[1]!.trim(),
    params: inner === "" ? [] : inner.split(",").map((p) => normaliseType(p)),
  };
}

/**
 * Resolve an anchor spec against a file's anchors. A spec matches on the full
 * dotted path, or on a bare name when that is unique. Ambiguity is an error:
 * one address resolving to several things is harder to handle at every layer
 * than one that simply fails.
 */
export function resolveAnchor(anchors: Anchor[], spec: string): Resolution {
  const { path, params } = splitSpec(spec);

  const matchesPath = (a: Anchor) =>
    a.fullName === path || a.name === path || a.fullName.endsWith(`.${path}`);

  let candidates = anchors.filter((a) => a.fullName === path);
  if (candidates.length === 0) candidates = anchors.filter(matchesPath);
  if (candidates.length === 0) return { ok: false, reason: "not-found" };

  if (params !== null) {
    const exact = candidates.filter(
      (a) => a.params !== undefined && a.params.length === params.length
        && a.params.every((p, i) => p === params[i]),
    );
    if (exact.length === 1) return { ok: true, anchor: exact[0]! };
    if (exact.length === 0) return { ok: false, reason: "not-found" };
    candidates = exact;
  }

  if (candidates.length === 1) return { ok: true, anchor: candidates[0]! };

  // Name the candidates as briefly as still tells them apart.
  const counts = new Map<string, number>();
  for (const a of candidates) counts.set(a.fullName, (counts.get(a.fullName) ?? 0) + 1);
  return {
    ok: false,
    reason: "ambiguous",
    candidates: candidates
      .map((a) => (counts.get(a.fullName) === 1 ? a.fullName : qualifiedName(a)))
      .sort(),
  };
}

/** The shortest spelling that still resolves to this anchor and nothing else. */
export function shortestUnambiguousName(anchor: Anchor, all: Anchor[]): string {
  const segments = anchor.fullName.split(".");
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments.slice(i).join(".");
    const resolved = resolveAnchor(all, candidate);
    if (resolved.ok && resolved.anchor === anchor) return candidate;
  }
  return qualifiedName(anchor);
}

// --- attribution -----------------------------------------------------------

function contains(span: Span | undefined, offset: number): boolean {
  if (!span) return false;
  return (span.startByte ?? 0) <= offset && offset <= (span.endByte ?? -1);
}

/**
 * The anchor a comment at `offset` belongs to: the innermost declaration that
 * lexically contains it, or null for the file.
 *
 * Containment is tested against the whole declaration rather than its block,
 * because no node spans "body including leading comments" in every language.
 * In Python the comment on a function's first line is a *sibling* of the block,
 * not a child, so a block-based test would hand it to the enclosing class. The
 * block still decides where a link is *written* (§4.2) and whether a
 * declaration can be annotated at all (§4.4).
 */
export function attributeComment(offset: number, anchors: Anchor[]): Anchor | null {
  let best: Anchor | null = null;
  for (const anchor of anchors) {
    if (!contains(anchor.span, offset)) continue;
    if (best === null || (anchor.span.startByte ?? 0) > (best.span.startByte ?? 0)) {
      best = anchor;
    }
  }
  return best;
}

export function extractReverseLinks(
  code: string,
  language: string,
  policy: AnchorPolicy = DEFAULT_ANCHOR_POLICY,
): ReverseLink[] {
  const result = pack.process(code, { language, comments: true });
  const anchors = extractAnchors(code, language, policy);
  const links: ReverseLink[] = [];

  for (const comment of result.comments ?? []) {
    if (!comment.text || !comment.span) continue;
    const match = REVERSE_LINK_RE.exec(comment.text);
    if (!match) continue;

    const enclosing = attributeComment(comment.span.startByte ?? 0, anchors);
    const link: ReverseLink = {
      relation: match[1]!,
      target: match[2]!,
      line: (comment.span.startLine ?? 0) + 1,
    };
    if (enclosing) link.enclosingSymbol = enclosing.fullName;
    links.push(link);
  }

  return links;
}

