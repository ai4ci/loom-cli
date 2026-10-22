/**
 * Normalised longest-common-subsequence ratio in [0, 1]. Good enough to rank
 * rename candidates for drift tier 1 (source-linkage §6.1); not a general
 * string distance.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const grid: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array<number>(b.length + 1).fill(0),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      grid[i]![j] = a[i - 1] === b[j - 1]
        ? grid[i - 1]![j - 1]! + 1
        : Math.max(grid[i - 1]![j]!, grid[i]![j - 1]!);
    }
  }

  return (2 * grid[a.length]![b.length]!) / (a.length + b.length);
}
