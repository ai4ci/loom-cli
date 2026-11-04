Here is a comprehensive, production-ready feature request designed to be copied and pasted directly into your project's GitHub issues. It outlines the architectural problem, the proposed WebAssembly solution, technical trade-offs, and an actionable implementation checklist.

Feature Request: Migrate Database & Parser Layers to WASM for Zero-Dependency Standalone Binary Distribution


🚀 The Problem & Context

We currently offer a hybrid distribution strategy: source code goes to the npm registry, and compiled standalone binaries are distributed via GitHub Releases using bun build --compile.
However, because our primary core dependencies—@duckdb/node-api and @xberg-io/tree-sitter-language-pack—rely on native C++ bindings (.node modules), we run into severe architecture limitations:
1. Compilation Failures: Bun's static analysis engine attempts to resolve all operating system targets at build time, failing unless complex --external flags are introduced to ignore missing platforms.
2. Distribution Overhead: Because native C++ fragments cannot be compiled inside a packed Bun binary text segment, the standalone executable cannot run standalone. It requires a local node_modules footprint or a heavy runtime shell fallback (npm install) on the end-user's machine to pull down the correct native bridges.
This breaks the user experience for non-Node/JS users (e.g., DevOps, Go, or Rust engineers) who expect to run loom as a zero-dependency CLI tool via curl or Homebrew.

💡 The Proposed Solution

Migrate our data processing and AST parser layers from native C++ binaries over to WebAssembly (WASM). WebAssembly modules run natively on any platform using the runtime engines built directly into Bun or Node.js.
By leveraging Bun's top-level static asset imports, we can inline the full bytecode of our query engine and language pack directly into the text segment of the compiled binary.

Proposed Dependency Swaps:

• @duckdb/node-api ➡️ @duckdb/duckdb-wasm (Inlining the companion .wasm and worker fragments via static data streams).
• @xberg-io/tree-sitter-language-pack (Native) ➡️ @xberg-io/tree-sitter-language-pack-wasm (WASM targets via web-tree-sitter).

🛠️ Technical Implementation Blueprint


1. Inlining the Engine Array Buffers (src/db.ts / src/cli.ts)

Instead of reading files from disk at runtime (which fails inside packed binaries as package.json and external files are left behind), we load modules directly as static compilation buffers using Bun's import macros:
typescript
import * as duckdb from '@duckdb/duckdb-wasm';

// Force the compiler to embed asset bytecode directly inside the executable
import duckdbWasmBuffer from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm' with { type: 'buffer' };
import workerScriptText from '@duckdb/duckdb-wasm/dist/duckdb-node.worker.js' with { type: 'text' };

async function initPersistentGraphEngine() {
  // Convert worker script into a Data URI to bypass local filesystem reads entirely
  const workerBlobUri = `data:application/javascript;base64,${Buffer.from(workerScriptText).toString('base64')}`;
  const worker = new Worker(workerBlobUri);

  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);

  // Instantiated cleanly out of memory array segments
  await db.instantiate(duckdbWasmBuffer);
  
  return db;
}
Use code with caution.

2. Clean Local Manifest (package.json)

This allows us to completely strip out our fragile --external compiler flags, simplifying our primary local build targets down to a clean, standard sequence:
json
"scripts": {
  "prebuild": "node scripts/stamp-version.cjs",
  "build": "tsc -p tsconfig.build.json && chmod +x dist/cli.js",
  "build:binary": "npm run build && bun build ./src/cli.ts --compile --outfile ./bin/loom"
}
Use code with caution.

⚖️ Trade-offs & Analysis


Pros:

• True Zero-Dependency Executable: Users receive a single file that works natively out-of-the-box on clean server environments, isolated containers, or machines completely devoid of Node.js, npm, or global caches.
• Language Parity Preserved: Modern packs like @xberg-io/tree-sitter-language-pack maintain exact feature parity across both compilation paths, preserving access to all 370+ supported languages.
• Deterministic Releases: Eliminates cross-compilation target bugs in the Release CI workflow pipeline.

Cons:

• Increased Binary Footprint: Inlining the WASM blobs will increase the base size of the compiled output binaries (~10-25MB addition depending on optimizations).
• Memory Footprint: Executing multiple WASM workers simultaneously limits allocations to isolated linear memory buffers, introducing a slight overhead when parsing massive continuous filesets compared to native OS heap access.

📋 Implementation Checklist

• Install @duckdb/duckdb-wasm and verify standard execution under local dev environments.
• Migrate src/cli.ts database wrappers to utilize the instantiate(buffer) initialization pattern.
• Switch tree-sitter bindings from native wrappers to the @xberg-io/tree-sitter-language-pack-wasm WebAssembly interface.
• Clean up package.json scripts by stripping out the --external build flags.
• Validate cross-platform execution by building standalone binaries locally for macOS, Linux, and Windows.
Would you like me to tailor any specific section of this request, such as expanding on how Loom's specific architecture currently reads DuckDB data projections, or are you ready to use this version?
