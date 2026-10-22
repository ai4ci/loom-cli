import { test } from "node:test";
import assert from "node:assert/strict";
import { findSymbolLine, extractReverseLinks, scanSourceFile } from "../src/source.ts";

test("findSymbolLine finds functions and methods in TypeScript", () => {
  const ts = `
export class Calculator {
  add(a: number, b: number) {
    return a + b;
  }
}

export function helper() {
  return 1;
}
`;
  assert.equal(findSymbolLine(ts, "typescript", "Calculator"), 2);
  assert.equal(findSymbolLine(ts, "typescript", "Calculator.add"), 3);
  assert.equal(findSymbolLine(ts, "typescript", "add"), 3);
  assert.equal(findSymbolLine(ts, "typescript", "helper"), 8);
  assert.equal(findSymbolLine(ts, "typescript", "nonexistent"), null);
});

test("findSymbolLine finds functions in Python", () => {
  const py = `
class Worker:
    def process(self):
        pass

def standalone():
    pass
`;
  assert.equal(findSymbolLine(py, "python", "Worker"), 2);
  assert.equal(findSymbolLine(py, "python", "Worker.process"), 3);
  assert.equal(findSymbolLine(py, "python", "process"), 3);
  assert.equal(findSymbolLine(py, "python", "standalone"), 6);
});

test("findSymbolLine finds functions in R", () => {
  const r = `
fit_model <- function(df) {
  lm(y ~ x, data = df)
}

calculate = function(val) {
  val * 2
}
`;
  assert.equal(findSymbolLine(r, "r", "fit_model"), 2);
  assert.equal(findSymbolLine(r, "r", "calculate"), 6);
  assert.equal(findSymbolLine(r, "r", "missing"), null);
});

test("extractReverseLinks parses // and # comments and attributes to enclosing symbols", () => {
  const code = `
// rel: issue://one.md
export class Service {
  // implemented-by: issue://sub.md
  run() {
    return true;
  }
}
`;
  const links = extractReverseLinks(code, "typescript");
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], {
    relation: "rel",
    target: "issue://one.md",
    line: 2,
    enclosingSymbol: "Service",
  });
  assert.deepEqual(links[1], {
    relation: "implemented-by",
    target: "issue://sub.md",
    line: 4,
    enclosingSymbol: "Service.run",
  });
});
