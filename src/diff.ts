/**
 * A unified diff built from the common prefix and suffix of two texts. Not a
 * minimal diff — it reports one changed region — but it is exact: applying it
 * reproduces the new text.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";

  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const from = Math.max(0, start - context);
  const lines: string[] = [
    `@@ -${from + 1},${endA - from} +${from + 1},${endB - from} @@`,
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...a.slice(start, endA).map((line) => `-${line}`),
    ...b.slice(start, endB).map((line) => `+${line}`),
    ...a.slice(endA, Math.min(a.length, endA + context)).map((line) => ` ${line}`),
  ];
  return lines.join("\n");
}
