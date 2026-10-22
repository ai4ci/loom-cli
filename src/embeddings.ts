import { createHash } from "node:crypto";

export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/**
 * A deterministic, dependency-free embedder.
 *
 * Words are hashed into a fixed-dimension bag-of-features vector using two
 * independent hashes: one selects the dimension, the other decides the sign.
 * This is not a semantic model — it is a stand-in for one that lets the
 * command work offline and be deterministic, so the rest of the pipeline
 * (storage, indexing, query) can be exercised end to end.
 *
 * Replace by swapping the factory in `embedder()`.
 */
export function embedder(dimensions = 256): Embedder {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
    "of", "in", "on", "to", "for", "with", "by", "as", "at", "from", "this",
    "that", "it", "its", "has", "have", "had", "do", "does", "did", "not",
    "no", "so", "if", "or", "i", "you", "we", "they", "he", "she",
  ]);

  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length > 1 && !stop.has(t));
  }

  async function embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) return v;

    for (const token of tokens) {
      const dimHash = createHash("sha1").update(`d:${token}`).digest();
      const signHash = createHash("sha1").update(`s:${token}`).digest();
      const idx = dimHash.readUInt32BE(0) % dimensions;
      const sign = (signHash.readUInt32BE(0) & 1) === 0 ? 1 : -1;
      v[idx]! += sign;
    }

    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) v[i]! /= norm;
    }
    return v;
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  }

  return { dimensions, embed, embedBatch };
}

export function hashBody(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface EmbeddingRow {
  contentHash: string;
  uri: string;
  vector: Float32Array;
}
