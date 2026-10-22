import pack from "@xberg-io/tree-sitter-language-pack";
import type { Span, StructureItem } from "@xberg-io/tree-sitter-language-pack";

export interface SymbolOccurrence {
  name: string;
  fullName: string;
  span: Span;
  line: number;
}

export interface ReverseLink {
  relation: string;
  target: string;
  line: number;
  enclosingSymbol?: string;
}

// Comments that match `// relation: target://...` or `# relation: target://...`
const REVERSE_LINK_RE = /^\s*(?:\/\/|#|--|\/\*)\s*([a-zA-Z0-9_-]+)\s*:\s*([a-zA-Z0-9+.-]+:\/\/\S+?)(?:\s*\*\/)?\s*$/;

export function detectLang(filename: string): string | null {
  return pack.detectLanguageFromPath(filename);
}

function collectRFunctions(code: string): SymbolOccurrence[] {
  const parser = pack.getParser("r");
  const tree = parser.parse(code);
  const symbols: SymbolOccurrence[] = [];
  if (!tree) return symbols;

  function walk(n: any) {
    if (n.kind() === "binary_operator") {
      const left = n.child(0);
      const op = n.child(1);
      const right = n.child(2);
      const opText = code.slice(op?.startByte(), op?.endByte()).trim();
      if ((opText === "<-" || opText === "=") && right?.kind() === "function_definition") {
        const name = code.slice(left?.startByte(), left?.endByte()).trim();
        const startPos = n.startPosition();
        symbols.push({
          name,
          fullName: name,
          line: startPos.row + 1,
          span: {
            startByte: n.startByte(),
            endByte: n.endByte(),
            startLine: startPos.row,
            startColumn: startPos.column,
            endLine: n.endPosition().row,
            endColumn: n.endPosition().column,
          },
        });
      }
    }
    for (let i = 0; i < n.childCount(); i++) {
      walk(n.child(i));
    }
  }
  walk(tree.rootNode());
  return symbols;
}

export function extractSymbols(code: string, language: string): SymbolOccurrence[] {
  if (language === "r") {
    return collectRFunctions(code);
  }

  const res = pack.process(code, { language, structure: true });
  const symbols: SymbolOccurrence[] = [];

  function walk(items: StructureItem[] | undefined, prefix = "") {
    if (!items) return;
    for (const item of items) {
      if (!item.name || !item.span) continue;
      const fullName = prefix ? `${prefix}.${item.name}` : item.name;
      symbols.push({
        name: item.name,
        fullName,
        span: item.span,
        line: (item.span.startLine ?? 0) + 1,
      });
      if (item.children && item.children.length > 0) {
        walk(item.children, fullName);
      }
    }
  }

  walk(res.structure);
  return symbols;
}

export function findSymbolLine(code: string, language: string, symbol: string): number | null {
  const symbols = extractSymbols(code, language);
  // Match exact fullName first, then fall back to bare name
  const match = symbols.find((s) => s.fullName === symbol) || symbols.find((s) => s.name === symbol);
  return match ? match.line : null;
}

export function extractReverseLinks(code: string, language: string): ReverseLink[] {
  const res = pack.process(code, { language, comments: true });
  const comments = res.comments ?? [];
  const symbols = extractSymbols(code, language);
  const links: ReverseLink[] = [];

  for (const c of comments) {
    if (!c.text || !c.span) continue;
    const match = REVERSE_LINK_RE.exec(c.text);
    if (!match) continue;

    const relation = match[1]!;
    const target = match[2]!;
    const commentLine = (c.span.startLine ?? 0) + 1;
    const commentByte = c.span.startByte ?? 0;

    // Find the tightest enclosing symbol, or immediately preceding a symbol
    const enclosing = symbols
      .filter((s) => (s.span.startByte ?? 0) <= commentByte && commentByte <= (s.span.endByte ?? Infinity))
      .sort((a, b) => ((b.span.startByte ?? 0) - (a.span.startByte ?? 0)))[0];

    // Or if immediately before a symbol (within 2 lines)
    const following = symbols.find((s) => s.line >= commentLine && s.line <= commentLine + 2);

    // If both exist, choose the most specific (e.g. method immediately following rather than outer class)
    const sym = (following && enclosing && following.fullName.startsWith(enclosing.fullName))
      ? following
      : (enclosing || following);
    links.push({
      relation,
      target,
      line: commentLine,
      enclosingSymbol: sym?.fullName,
    });
  }

  return links;
}

export function scanSourceFile(code: string, language: string) {
  return {
    symbols: extractSymbols(code, language),
    reverseLinks: extractReverseLinks(code, language),
  };
}
