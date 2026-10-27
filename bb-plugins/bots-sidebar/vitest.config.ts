import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS's default /var temp path is a symlink; bot state confinement correctly
// rejects symlink ancestors. Give the real filesystem path to test workers.
process.env.TMPDIR = realpathSync(tmpdir());

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) }, dedupe: ["react", "react-dom"] },
  test: {
    setupFiles: ["tests/setup-thread-list.ts"],
    execArgv: ["--no-experimental-webstorage"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], restoreMocks: true,
    // The SDK harness uses durable SQLite and filesystem exports. Bound parallel
    // workers and allow disk contention without weakening behavioral assertions.
    maxWorkers: 4, testTimeout: 20_000,
  },
});
